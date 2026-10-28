import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpClient, fakeResponse, mockSender } from '../src/core/http.js'
import { createLogger } from '../src/core/log.js'
import { downloadMedia } from '../src/core/files.js'
import { loadAISettings, parseModelConfig } from '../src/core/video/config.js'
import { modelJson } from '../src/core/video/client.js'
import { transcribeAudio, wavChunk } from '../src/core/video/transcribe.js'
import { runVideoWorker, runVideoProcess } from '../src/core/video/worker.js'
import { ffmpegWorker, wavSamples, whisperWorker } from '../src/core/video/workers.js'
import { useTempHome } from './helpers.js'
import { makeCtx } from './golden.js'

const log = createLogger({ quiet: true })

it('实际 Node 子进程超时被回收，错误标记为可重试；取消不重试',async()=>{
  await expect(runVideoProcess(()=>{ for (;;) {} },{},log,undefined,60)).rejects.toMatchObject({detail:{retryable:true}})
  const controller=new AbortController();controller.abort()
  await expect(runVideoProcess(()=>{}, {},log,controller.signal,60)).rejects.toThrow('取消')
})

describe('视频模型配置与请求隔离', () => {
  const home = useTempHome()
  afterEach(() => vi.unstubAllEnvs())

  it('兼容原项目 JSON 和 .env，但只提取模型配置，不执行或导入其他变量', () => {
    expect(parseModelConfig('MODEL="gpt-6.1-sol"\nMODEL_URL=https://example.com/v1\nMODEL_API_KEY=fake\nDOUYIN_COOKIE=must-not-import\n')).toEqual({model:'gpt-6.1-sol',base_url:'https://example.com/v1',api_key:'fake'})
    expect(parseModelConfig(JSON.stringify({clients:{default:'openai_api',openai_api:{model:'gpt-6.1-sol',api_url:'https://example.com/v1',api_key:'fake'}}}))).toEqual({model:'gpt-6.1-sol',base_url:'https://example.com/v1',api_key:'fake'})
  })

  it('配置路径、环境变量和 --model 优先级；相对模型路径相对配置文件解析', async () => {
    const file=join(home.dir,'config','ai.json');await mkdir(join(home.dir,'config'))
    await writeFile(file,JSON.stringify({base_url:'https://example.com/v1/',api_key:'fake-file',model:'file-model',transcription:{engine:'local',model:'tiny',model_path:'model.bin'}}))
    vi.stubEnv('CATBUS_AI_CONFIG',file);vi.stubEnv('CATBUS_AI_MODEL','env-model');vi.stubEnv('CATBUS_AI_API_KEY','fake-env')
    const settings=await loadAISettings({model:'gpt-6.1-sol'},true)
    expect([settings.model,settings.api_key,settings.base_url,settings.transcription.model_path]).toEqual(['gpt-6.1-sol','fake-env','https://example.com/v1',join(home.dir,'config','model.bin')])
  })

  it('提取可不配模型服务；总结缺少配置及无效配置不泄漏密钥', async () => {
    expect((await loadAISettings({})).transcription).toEqual({engine:'local',model:'base'})
    await expect(loadAISettings({},true)).rejects.toMatchObject({code:'USAGE'})
    const file=join(home.dir,'broken.json');await writeFile(file,'{"api_key":"fake-sensitive-key",BAD')
    await expect(loadAISettings({aiConfig:file},true)).rejects.toMatchObject({code:'USAGE',message:'模型配置文件无法读取或格式错误'})
    await writeFile(file,JSON.stringify({base_url:'https://user:password@example.com/v1',api_key:'fake',model:'m'}))
    await expect(loadAISettings({aiConfig:file},true)).rejects.toMatchObject({code:'USAGE'})
  })

  it('原生运行时与设备显式配置可读，WASM 不能假装使用 Metal',async()=>{
    const file=join(home.dir,'native.json')
    await writeFile(file,JSON.stringify({transcription:{engine:'local',runtime:'native',device:'metal',model:'base'}}))
    expect((await loadAISettings({aiConfig:file})).transcription).toMatchObject({runtime:'native',device:'metal'})
    await writeFile(file,JSON.stringify({transcription:{engine:'local',runtime:'wasm',device:'metal'}}))
    await expect(loadAISettings({aiConfig:file})).rejects.toMatchObject({code:'USAGE'})
  })

  it('模型请求不携带平台 Cookie；HTTP 错误不转发可能反射密钥的响应体，也不重试', async () => {
    let requests=0
    const restore=mockSender(p=>{
      requests++;expect(p.cookies).toEqual([])
      expect(Object.fromEntries(p.headers).authorization).toBe('Bearer fake-secret')
      return fakeResponse({error:{message:'fake-secret'}},{status:503})
    })
    try {
      await expect(modelJson(new HttpClient(),'https://example.com/v1','fake-secret','/chat/completions',{url:'',headers:{cookie:'must-not-forward',authorization:'wrong-key'},json:{model:'m'}},180)).rejects.toMatchObject({code:'UPSTREAM',message:'模型接口请求失败（HTTP 503）'})
      expect(requests).toBe(1)
    } finally {restore()}
  })

  it('转写 API 分段上传，不携带平台凭证；结果恢复原视频时间偏移',async()=>{
    const audio=join(home.dir,'long.wav')
    await writeFile(audio,wavChunk(new Float32Array(600*16000+160)))
    const settings=await loadAISettings({})
    settings.transcription={engine:'api',model:'asr-chosen',base_url:'https://asr.example/v1',api_key:'fake-asr'}
    let calls=0
    const restore=mockSender(p=>{
      expect(p.url).toBe('https://asr.example/v1/audio/transcriptions');expect(p.cookies).toEqual([])
      expect(p.multipart!.find(part=>part.name==='model')!.data).toBe('asr-chosen')
      expect(p.multipart!.find(part=>part.name==='file')!.data.length).toBeLessThan(25*1024*1024)
      expect(p.multipart!.some(part=>part.name==='language')).toBe(false)
      return fakeResponse({text:++calls===1?'第一段':'第二段'})
    })
    try{
      const result=await transcribeAudio(audio,settings,new HttpClient(),log,'auto')
      expect(result.text).toBe('第一段\n第二段');expect(result.segments[1]!.start).toBe(600);expect(calls).toBe(2)
      expect((await transcribeAudio(audio,settings,new HttpClient(),log,'auto')).text).toBe(result.text)
      expect(calls).toBe(2)
    }finally{restore()}
  })

  it.each([true,false])('视频下载有大小上限，声明或实际字节超限时不留下半成品：%s',async(header)=>{
    const ctx=makeCtx({platform:'douyin',options:{dir:home.dir}})
    const restore=mockSender(()=>fakeResponse(new Uint8Array(16),{headers:header?[['content-length','16']]:[]}))
    try{
      await expect(downloadMedia(ctx,new HttpClient(),'1001',[{id:'v',type:'video',url:'https://media.example/test.mp4',width:null,height:null,duration:null}],{maxBytes:8})).rejects.toMatchObject({code:'UNSUPPORTED'})
      const files=await import('node:fs/promises').then(fs=>fs.readdir(home.dir))
      expect(files).toEqual([])
    }finally{restore()}
  })
})

describe('实际 WASM 视频提取',()=>{
  const home=useTempHome()
  const fixture=fileURLToPath(new URL('./fixtures/video/tone.mp4',import.meta.url))

  it('解码真实 MP4：16 kHz 音轨、有效 PNG、完整时长和片段标记',async()=>{
    const result=await runVideoWorker<any>(ffmpegWorker,{video:fixture,dir:home.dir,maxFrames:3,maxSeconds:1},log)
    expect(result).toMatchObject({duration:2,processed_duration:1,truncated:true})
    const samples=wavSamples(await readFile(result.audio_path))
    expect(samples.length).toBe(16000)
    expect(Math.max(...samples.subarray(0,1000))).toBeGreaterThan(0.01)
    expect(result.frames).toHaveLength(1)
    expect((await readFile(result.frames[0].path)).subarray(1,4).toString()).toBe('PNG')
  })

  it('完整视频按数量均匀采样；损坏的视频不能返回成功内容',async()=>{
    const result=await runVideoWorker<any>(ffmpegWorker,{video:fixture,dir:home.dir,maxFrames:2},log)
    expect(result.frames.map((f:any)=>f.timestamp)).toEqual([0,1])
    expect(result.truncated).toBe(false)
    const invalid=join(home.dir,'invalid.mp4');await writeFile(invalid,'not a video')
    await expect(runVideoWorker(ffmpegWorker,{video:invalid,dir:home.dir,maxFrames:2},log)).rejects.toMatchObject({code:'ERROR'})
  })

  it('1080p 视频导出为 960 宽 PNG；无音轨时仍能提取画面',async()=>{
    const video=fileURLToPath(new URL('./fixtures/video/fullhd.mp4',import.meta.url))
    const result=await runVideoWorker<any>(ffmpegWorker,{video,dir:home.dir,maxFrames:2},log)
    expect(result.audio_path).toBeNull();expect(result.frames).toHaveLength(1)
    const image=await readFile(result.frames[0].path)
    expect([image.readUInt32BE(16),image.readUInt32BE(20)]).toEqual([960,540])
  })

  it('Whisper 模块在 Node worker 中加载，坏模型报错；不会运行 Python 或下载模型',async()=>{
    const model=join(home.dir,'bad-model.bin');await writeFile(model,'invalid model')
    await expect(runVideoWorker(whisperWorker,{model,audio:join(home.dir,'unused.wav'),language:'zh'},log)).rejects.toMatchObject({code:'ERROR'})
  })

  it('取消信号能结束本地处理，不等待 WASM 计算完成',async()=>{
    const controller=new AbortController()
    const result=runVideoWorker(ffmpegWorker,{video:fixture,dir:home.dir,maxFrames:2},log,controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({code:'ERROR',message:'视频分析已取消'})
  })

  it('WAV round trip 与格式校验：拒绝不完整数据、错误采样率和双声道',()=>{
    const samples=new Float32Array([-1,-0.5,0,0.5,0.99])
    expect([...wavSamples(wavChunk(samples))]).toEqual([...samples].map(v=>Math.round(v*32768)/32768))
    expect(()=>wavSamples(new Uint8Array(12))).toThrow('无效的 WAV')
    const incomplete=wavChunk(samples).subarray(0,46)
    expect(()=>wavSamples(incomplete)).toThrow('不完整')
    const stereo=wavChunk(samples);new DataView(stereo.buffer).setUint16(22,2,true)
    expect(()=>wavSamples(stereo)).toThrow('单声道')
  })
})

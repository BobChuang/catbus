import { readFile, writeFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as n from '../src/core/normalize.js'
import { HttpClient, fakeResponse, mockSender, type PreparedRequest } from '../src/core/http.js'
import type { VideoTranscript } from '../src/core/schemas.js'
import type { AISettings } from '../src/core/video/config.js'
import { extractVideo, summarizeVideo } from '../src/core/video/pipeline.js'
import { transcribeAudio } from '../src/core/video/transcribe.js'
import { runVideoWorker } from '../src/core/video/worker.js'
import { makeCtx } from './golden.js'
import { useTempHome } from './helpers.js'

vi.mock('../src/core/video/worker.js',()=>({runVideoWorker:vi.fn()}))
vi.mock('../src/core/video/transcribe.js',()=>({transcribeAudio:vi.fn()}))

const transcript:VideoTranscript={text:'真正的口播内容：先运行测试，再审核代码。',language:'zh',engine:'local',model:'base',segments:[{start:0,end:3,text:'先运行测试，再审核代码。'}]}
const settings:AISettings={base_url:'https://model.example/v1',api_key:'fake-sensitive-key',model:'gpt-6.1-sol',timeout:180,max_output_tokens:8192,transcription:{engine:'local',model:'base'}}
const item=n.item({id:'1001',kind:'video',url:'https://www.douyin.com/video/1001',text:'这是作品描述，不是视频转写',media:[n.media({id:'v',type:'video',url:'https://media.example/video.mp4'})]})

describe('视频提取、总结与缓存',()=>{
  const home=useTempHome()
  const context=()=>makeCtx({platform:'douyin',options:{dir:home.dir,maxFrames:2,maxSeconds:3}})
  beforeEach(()=>{
    vi.clearAllMocks()
    vi.mocked(transcribeAudio).mockResolvedValue(transcript)
    vi.mocked(runVideoWorker).mockImplementation(async(_fn,data)=>{
      const dir=data.dir as string
      const audio=join(dir,'audio.wav'),frame=join(dir,'frame_001.png')
      await writeFile(audio,'fake audio');await writeFile(frame,await createCanvas(24,16).encode('png'))
      return {duration:4,processed_duration:3,truncated:true,audio_path:audio,frames:[{timestamp:0,path:frame}]} as any
    })
  })
  async function server<T>(run:(requests:PreparedRequest[])=>Promise<T>,answer:unknown='## 总结\n先运行测试，再审核代码。'){
    const requests:PreparedRequest[]=[]
    const fixture=await readFile(new URL('./fixtures/video/tone.mp4',import.meta.url))
    const restore=mockSender(p=>{
      requests.push(p)
      if(p.url===item.media[0]!.url)return fakeResponse(fixture)
      if(p.url==='https://model.example/v1/chat/completions')return fakeResponse({choices:[{message:{content:answer}}]})
      throw new Error(`没有配置的请求：${p.url}`)
    })
    try{return await run(requests)}finally{restore()}
  }

  it('总结请求同时包含真实转写和画面，产物中不保存模型密钥；片段范围明确标记',async()=>{
    await server(async(requests)=>{
      const result=await summarizeVideo(context(),item,settings,new HttpClient())
      expect(result.model).toBe('gpt-6.1-sol')
      expect(result.summary).toContain('仅分析视频前 3.0 秒')
      expect(result.content.transcript?.text).toBe(transcript.text)
      const modelRequest=requests.find(r=>r.url.includes('/chat/completions'))!
      expect(modelRequest.cookies).toEqual([])
      const payload=JSON.parse(modelRequest.body as string)
      expect(payload.model).toBe('gpt-6.1-sol')
      const evidence=JSON.parse(payload.messages[1].content[0].text)
      expect(evidence.transcript.text).toBe(transcript.text)
      expect(evidence.video.description).toBe(item.text)
      expect(payload.messages[1].content[1].image_url.url).toMatch(/^data:image\/webp;base64,/)
      const analysis=await readFile(result.files.analysis,'utf8')
      expect(analysis).not.toContain(settings.api_key)
      expect(await readFile(result.files.summary,'utf8')).toContain('先运行测试')
      if(process.platform!=='win32')expect((await stat(result.files.analysis)).mode&0o777).toBe(0o600)
    })
  })

  it('重跑不重复提取、转写或调用模型；改变总结模型只重做总结',async()=>{
    await server(async(requests)=>{
      const ctx=context()
      const first=await summarizeVideo(ctx,item,settings,new HttpClient())
      const cached=await summarizeVideo(ctx,item,settings,new HttpClient())
      expect([first.cached,cached.cached]).toEqual([false,true])
      expect(requests).toHaveLength(2)
      const other=await summarizeVideo(ctx,item,{...settings,model:'another-model'},new HttpClient())
      expect(other.cached).toBe(false)
      expect(requests).toHaveLength(3)
      expect(vi.mocked(runVideoWorker)).toHaveBeenCalledTimes(1)
      expect(cached.timings?.stages.filter(s=>['download','extract','summarize'].includes(s.name)).every(s=>s.cache_hit)).toBe(true)
      expect(cached.files.metrics).not.toBe(first.files.metrics)
      expect(JSON.parse(await readFile(cached.files.metrics!,'utf8')).run_id).toBe(cached.timings?.run_id)
      expect(other.files.analysis).not.toBe(first.files.analysis)
      expect(first.timings?.summary).toMatchObject({cached:false,streamed:false,first_token_ms:null})
      expect(cached.timings?.summary).toMatchObject({cached:true})
      expect(cached.timings?.summary?.request_total_ms).toBeUndefined()
    })
  })

  it('总结风格、推理和图片设置分别隔离缓存，不重新下载和转写',async()=>{
    await server(async requests=>{
      const ctx=context(),http=new HttpClient()
      const first=await summarizeVideo(ctx,item,settings,http)
      for(const summary of [{style:'detailed' as const},{reasoning_effort:'medium' as const},{image_format:'png' as const},{stream:false}]){
        const result=await summarizeVideo(ctx,item,{...settings,summary},http)
        expect(result.cached).toBe(false)
        expect(result.files.analysis).not.toBe(first.files.analysis)
      }
      expect(requests.filter(r=>r.url.includes('/chat/completions'))).toHaveLength(5)
      expect(runVideoWorker).toHaveBeenCalledTimes(1)
      expect(requests.filter(r=>r.url===item.media[0]!.url)).toHaveLength(1)
    })
  })

  it('流中断不写成功缓存，重跑复用提取产物并重新请求总结',async()=>{
    const fixture=await readFile(new URL('./fixtures/video/tone.mp4',import.meta.url))
    let calls=0
    const restore=mockSender(p=>{
      if(p.url===item.media[0]!.url)return fakeResponse(fixture)
      calls++
      return fakeResponse('data: '+JSON.stringify({choices:[{delta:{content:'还没完成'},...(calls>1?{finish_reason:'stop'}:{})}]})+'\n\n', {headers:[['content-type','text/event-stream']]})
    })
    try{
      await expect(summarizeVideo(context(),item,settings,new HttpClient())).rejects.toThrow('提前断开')
      const result=await summarizeVideo(context(),item,settings,new HttpClient())
      expect(result.cached).toBe(false);expect(calls).toBe(2)
      expect(runVideoWorker).toHaveBeenCalledTimes(1)
      const warm=await summarizeVideo(context(),item,settings,new HttpClient())
      expect(warm.cached).toBe(true);expect(calls).toBe(2)
    }finally{restore()}
  })

  it('改变提取参数或 --refresh 会重新处理；缺失的总结文件不当作缓存成功',async()=>{
    await server(async(requests)=>{
      const ctx=context();const first=await summarizeVideo(ctx,item,settings,new HttpClient())
      await rm(first.files.summary)
      await summarizeVideo(ctx,item,settings,new HttpClient())
      expect(requests.filter(r=>r.url.includes('/chat/completions'))).toHaveLength(2)
      ctx.options.refresh=true
      await summarizeVideo(ctx,item,settings,new HttpClient())
      expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(3)
      ctx.options={dir:home.dir,maxFrames:1}
      await extractVideo(ctx,item,settings,new HttpClient())
      expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(4)
    })
  })

  it('无语音时明确说明画面来源；不把作品描述当成口播',async()=>{
    vi.mocked(transcribeAudio).mockResolvedValue({...transcript,text:'',segments:[]})
    await server(async()=>{
      const result=await summarizeVideo(context(),item,settings,new HttpClient())
      expect(result.summary).toContain('仅依据抽样画面')
      expect(result.content.transcript?.text).toBe('')
      expect(await readFile(result.content.files!.transcript,'utf8')).toBe('')
    })
  })

  it('模型空响应失败，不保存成总结缓存；提取失败也不能退回文案总结',async()=>{
    await server(async(requests)=>{
      await expect(summarizeVideo(context(),item,settings,new HttpClient())).rejects.toMatchObject({code:'UPSTREAM',message:'总结模型未返回非空文本，未保存为成功结果'})
      expect(requests).toHaveLength(2)
    },null)
    vi.mocked(runVideoWorker).mockRejectedValue(new Error('decoder failed'))
    await server(async(requests)=>{
      const ctx=context();ctx.options.refresh=true
      await expect(summarizeVideo(ctx,item,settings,new HttpClient())).rejects.toThrow('decoder failed')
      expect(requests.filter(r=>r.url.includes('/chat/completions'))).toHaveLength(0)
    })
  })

  it('图文和异常 ID 在下载前拒绝',async()=>{
    await expect(extractVideo(context(),{...item,kind:'image'},settings,new HttpClient())).rejects.toMatchObject({code:'UNSUPPORTED'})
    await expect(extractVideo(context(),{...item,id:'../../escape'},settings,new HttpClient())).rejects.toMatchObject({code:'UPSTREAM'})
  })

  it('同一视频同时分析时有写锁，防止两个进程或任务覆盖彼此产物',async()=>{
    let enter!:()=>void,release!:()=>void
    const entered=new Promise<void>(r=>{enter=r}),wait=new Promise<void>(r=>{release=r})
    vi.mocked(transcribeAudio).mockImplementationOnce(async()=>{enter();await wait;return transcript})
    await server(async()=>{
      const first=extractVideo(context(),item,settings,new HttpClient())
      await entered
      try{await expect(extractVideo(context(),item,settings,new HttpClient())).rejects.toMatchObject({code:'USAGE'})}finally{release()}
      await first
    })
  })

  it('转写失败保留下载和提取缓存；语音配置及画面参数分别失效',async()=>{
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error('ASR failed'))
    await server(async requests=>{
      const ctx=context()
      await expect(summarizeVideo(ctx,item,settings,new HttpClient())).rejects.toThrow('ASR failed')
      const runs=await import('node:fs/promises').then(fs=>fs.readdir(join(home.dir,'douyin_1001','runs')))
      const failed=JSON.parse(await readFile(join(home.dir,'douyin_1001','runs',runs[0]!),'utf8'))
      expect(failed.status).toBe('error')
      expect(failed.stages.find((s:any)=>s.name==='transcribe').status).toBe('error')
      const success=await summarizeVideo(ctx,item,settings,new HttpClient())
      expect(success.timings?.stages.find(s=>s.name==='extract')?.cache_hit).toBe(true)
      await extractVideo(ctx,item,{...settings,transcription:{engine:'local',model:'tiny'}},new HttpClient())
      expect(runVideoWorker).toHaveBeenCalledTimes(1)
      ctx.options.maxFrames=1
      await extractVideo(ctx,item,settings,new HttpClient())
      expect(runVideoWorker).toHaveBeenCalledTimes(2)
      expect(requests.filter(r=>r.url===item.media[0]!.url)).toHaveLength(1)
    })
  })

  it('提取产物同大小损坏也只重做提取，视频本体仍复用',async()=>{
    await server(async requests=>{
      const first=await extractVideo(context(),item,settings,new HttpClient())
      await writeFile(first.frames[0]!.path,Buffer.alloc((await stat(first.frames[0]!.path)).size,0))
      await extractVideo(context(),item,settings,new HttpClient())
      expect(runVideoWorker).toHaveBeenCalledTimes(2)
      expect(requests.filter(r=>r.url===item.media[0]!.url)).toHaveLength(1)
    })
  })
})

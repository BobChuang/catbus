import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpClient } from '../src/core/http.js'
import { createLogger } from '../src/core/log.js'
import { loadAISettings } from '../src/core/video/config.js'
import { transcribeAudio, validTranscriptionProgress, wavChunk } from '../src/core/video/transcribe.js'
import { runVideoProcess } from '../src/core/video/worker.js'
import { wavSamples, whisperWorker } from '../src/core/video/workers.js'
import { useTempHome } from './helpers.js'
import { CatbusError } from '../src/core/errors.js'

vi.mock('../src/core/video/worker.js',()=>({runVideoProcess:vi.fn()}))
vi.mock('node:os',async importOriginal=>({...await importOriginal<typeof import('node:os')>(),availableParallelism:()=>6,totalmem:()=>16*1024**3}))
const log=createLogger({quiet:true})
const first={start:0,end:30,text:'已完成的第一段'}
async function chunkFiles(root:string) {
  return (await readdir(root,{recursive:true})).filter(p=>/chunks[/\\].*\.json$/.test(p)).map(p=>join(root,p))
}

describe('本地长音轨转写与恢复',()=>{
  const home=useTempHome()
  beforeEach(()=>{vi.mocked(runVideoProcess).mockReset().mockResolvedValue({text:'',segments:[]})})

  it('单段 worker 恢复全视频时间偏移，打印回调只收集文字',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin'),factory=join(home.dir,'fake-whisper.cjs'),pkg=join(home.dir,'package.json')
    await writeFile(audio,wavChunk(new Float32Array(65*16000)));await writeFile(model,'fake model');await writeFile(pkg,'{}')
    // 只替换模型依赖，执行生产 worker 本身；CI 不下载语音模型。
    await writeFile(factory,`module.exports=async options=>({
      FS_createDataFile(){},init(){return true},free(){},PThread:{terminateAllThreads(){}},
      full_default(samples){options.printErr('whisper_full: failed to decode with temperature = 0.00');options.printErr('whisper_full: failed to generate timestamp token - using fallback strategy');const n=samples.length/16000;options.print('[00:00:00.000 --> 00:00:'+String(n).padStart(2,'0')+'.000] chunk-'+samples.length);return 0}
    })`)
    const original=whisperWorker.toString(),source=original.replace(/localRequire\(["']whisper\.cpp["']\)/,'localRequire(workerData.factory)')
    expect(source).not.toBe(original)
    const code=`import('node:module').then(({createRequire})=>{const require=createRequire(${JSON.stringify(pkg)});const wavSamples=(${wavSamples.toString()});return (${source})()})`
    const worker=new Worker(code,{eval:true,execArgv:[],workerData:{packageJson:pkg,factory,model,samples:new Float32Array(5*16000),language:'zh',offsetSeconds:60}})
    const messages:string[]=[]
    const result=await new Promise<any>((resolve,reject)=>{
      worker.on('error',reject)
      worker.on('message',message=>{
        messages.push(message.type)
        if(message.type==='error')reject(new Error(message.message))
        else if(message.type==='result')resolve(message.result)
      })
    }).finally(()=>worker.terminate())
    expect(messages).toEqual(['result'])
    expect(result.segments).toEqual([{start:60,end:65,text:'chunk-80000'}])
  })

  it('中断后原子保存进度，同一音轨、模型、语言重跑时从已完成位置继续',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(31*16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription.model_path=model;settings.transcription.runtime='wasm'
    vi.mocked(runVideoProcess).mockImplementation(async(_fn,data)=>{
      if(data.offsetSeconds===0)return {text:first.text,segments:[first]} as any
      throw new Error('interrupted')
    })
    await expect(transcribeAudio(audio,settings,new HttpClient(),log,'zh')).rejects.toThrow('interrupted')
    expect(await chunkFiles(home.dir)).toHaveLength(1)
    vi.mocked(runVideoProcess).mockImplementationOnce(async(_fn,data)=>{
      expect(data.offsetSeconds).toBe(30);expect((data.samples as Float32Array).length).toBe(16000)
      return {text:'最后一秒',segments:[{start:30,end:31,text:'最后一秒'}]} as any
    })
    expect((await transcribeAudio(audio,settings,new HttpClient(),log,'zh')).text).toBe(first.text+' 最后一秒')
    const offsets:number[]=[]
    vi.mocked(runVideoProcess).mockImplementation(async(_fn,data)=>{offsets.push(data.offsetSeconds as number);return {text:'',segments:[]} as any})
    await transcribeAudio(audio,settings,new HttpClient(),log,'en')
    expect(offsets.sort((a,b)=>a-b)).toEqual([0,30])
  })

  it('--refresh 清除旧转写进度，失败后也不恢复被丢弃的旧状态',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription.model_path=model;settings.transcription.runtime='wasm'
    await transcribeAudio(audio,settings,new HttpClient(),log,'zh')
    expect(await chunkFiles(home.dir)).toHaveLength(1)
    vi.mocked(runVideoProcess).mockImplementationOnce(async(_fn,data)=>{expect(data.offsetSeconds).toBe(0);throw new Error('interrupted')})
    await expect(transcribeAudio(audio,settings,new HttpClient(),log,'zh',undefined,true)).rejects.toThrow('interrupted')
    expect(await chunkFiles(home.dir)).toHaveLength(0)
    expect(validTranscriptionProgress({completedSamples:-1,segments:[]})).toBe(false)
    expect(validTranscriptionProgress({completedSamples:16000,segments:[{start:0,end:999,text:'bad'}]})).toBe(false)
  })

  it('乱序完成的段落立即独立保存，最终按视频时间合并',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(31*16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription.model_path=model;settings.transcription.runtime='wasm'
    let finishFirst!:(value:any)=>void
    let finishSecond!:(value:any)=>void
    vi.mocked(runVideoProcess).mockImplementation((_fn,data)=>new Promise(resolve=>{
      if(data.offsetSeconds===0)finishFirst=resolve
      else finishSecond=resolve
    }))
    const pending=transcribeAudio(audio,settings,new HttpClient(),log,'zh')
    await vi.waitFor(()=>expect(finishSecond).toBeTypeOf('function'))
    finishSecond({text:'最后一秒',segments:[{start:30,end:31,text:'最后一秒'}]})
    await vi.waitFor(async()=>expect(await chunkFiles(home.dir)).toHaveLength(1))
    finishFirst({text:first.text,segments:[first]})
    expect((await pending).text).toBe(first.text+' 最后一秒')
    expect(await chunkFiles(home.dir)).toHaveLength(2)
  })

  it('失败段重试耗尽后保留后续成功段，重跑只补失败段',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(31*16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription={engine:'local',runtime:'wasm',model:'base',model_path:model,max_retries:1,concurrency:2}
    const counts=new Map<number,number>()
    vi.mocked(runVideoProcess).mockImplementation(async(_fn,data)=>{
      const offset=data.offsetSeconds as number;counts.set(offset,(counts.get(offset)??0)+1)
      if(offset===0)throw new CatbusError('ERROR','temporarily failed',{detail:{retryable:true}})
      return {text:'末段',segments:[{start:30,end:31,text:'末段'}]} as any
    })
    await expect(transcribeAudio(audio,settings,new HttpClient(),log,'zh')).rejects.toThrow('temporarily failed')
    expect([...counts.entries()].sort((a,b)=>a[0]-b[0])).toEqual([[0,2],[30,1]])
    expect(await chunkFiles(home.dir)).toHaveLength(1)
    vi.mocked(runVideoProcess).mockReset().mockResolvedValue({text:first.text,segments:[first]})
    let stats:any
    const result=await transcribeAudio(audio,settings,new HttpClient(),log,'zh',undefined,false,{onStats:s=>{stats=s}})
    expect(result.text).toBe(first.text+' 末段')
    expect(runVideoProcess).toHaveBeenCalledTimes(1)
    expect(stats.cached_chunks).toBe(1)
  })

  it('动态队列在慢段未完成时继续补任务，并且只重试暂时性错误',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(61*16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription={engine:'local',runtime:'wasm',model:'base',model_path:model,concurrency:2}
    let release!:(v:any)=>void,thirdStarted=false,active=0,maxActive=0,secondAttempts=0
    vi.mocked(runVideoProcess).mockImplementation(async(_fn,data)=>{
      active++;maxActive=Math.max(maxActive,active)
      try{
        if(data.offsetSeconds===0)return await new Promise(resolve=>{release=resolve})
        if(data.offsetSeconds===30&&secondAttempts++===0)throw new CatbusError('ERROR','timeout',{detail:{retryable:true}})
        if(data.offsetSeconds===60)thirdStarted=true
        return {text:'',segments:[]} as any
      }finally{active--}
    })
    let stats:any
    const pending=transcribeAudio(audio,settings,new HttpClient(),log,'zh',undefined,false,{onStats:s=>{stats=s}})
    await vi.waitFor(()=>{expect(thirdStarted).toBe(true);expect(release).toBeTypeOf('function')})
    expect(maxActive).toBe(2)
    release({text:first.text,segments:[first]});await pending
    expect(stats.retries).toBe(1);expect(stats.chunks[1].attempts).toBe(2)
    expect(vi.mocked(runVideoProcess).mock.calls[0]![4]).toBe(300000)
  })

  it('同一路径的模型内容变化会失效；损坏缓存只重算受影响段；取消不重试',async()=>{
    const audio=join(home.dir,'audio.wav'),model=join(home.dir,'model.bin')
    await writeFile(audio,wavChunk(new Float32Array(16000)));await writeFile(model,'fake model')
    const settings=await loadAISettings({});settings.transcription.model_path=model;settings.transcription.runtime='wasm'
    await transcribeAudio(audio,settings,new HttpClient(),log,'zh')
    const all=await readdir(home.dir,{recursive:true});const aggregate=all.find(p=>p.endsWith('transcript.json'))!
    await rm(join(home.dir,aggregate));await writeFile((await chunkFiles(home.dir))[0]!,'broken json')
    await transcribeAudio(audio,settings,new HttpClient(),log,'zh')
    expect(runVideoProcess).toHaveBeenCalledTimes(2)
    await writeFile(model,'different model')
    await transcribeAudio(audio,settings,new HttpClient(),log,'zh')
    expect(runVideoProcess).toHaveBeenCalledTimes(3)
    const controller=new AbortController();controller.abort()
    await expect(transcribeAudio(audio,settings,new HttpClient(),log,'en',controller.signal)).rejects.toThrow('取消')
    expect(runVideoProcess).toHaveBeenCalledTimes(3)
  })
})

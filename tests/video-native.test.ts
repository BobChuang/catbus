import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeWhisperSession, localRuntimes, NATIVE_WHISPER_VERSION } from '../src/core/video/native.js'
import { useTempHome } from './helpers.js'
import type { LocalRuntime } from '../src/core/video/native.js'

describe('原生转写隔离进程',()=>{
  const home=useTempHome()
  async function runtime(mode='ok'):Promise<LocalRuntime>{
    const library=join(home.dir,'binding.cjs')
    await writeFile(library,`let logger;let count=0;
      class WhisperContext{
        static toggleNativeLog(on,fn){logger=fn}
        constructor(options){this.n=++count;if(options.useGpu&&${JSON.stringify(mode)}!=='no-metal'){logger('info','GPU name: MTL0 (Test GPU)');logger('info','whisper_backend_init_gpu: using MTL0 backend')}}
        transcribeData(pcm){if(${JSON.stringify(mode)}==='crash')process.exit(12);if(${JSON.stringify(mode)}==='hang')return {promise:new Promise(()=>{})};return {promise:Promise.resolve({isAborted:false,segments:${JSON.stringify(mode)}==='overrun'?[{t0:900,t1:2500,text:'末尾'},{t0:2000,t1:3000,text:'补零'}]:[{t0:0,t1:pcm.byteLength/32,text:'context-'+this.n}]})}}
      }
      module.exports={WhisperContext}`)
    return {runtime:'native',backend:'metal',version:NATIVE_WHISPER_VERSION,library}
  }

  it('同一视频复用模型并恢复全视频时间，返回真实后端证据',async()=>{
    const session=new NativeWhisperSession(await runtime(),'unused')
    try{
      const first=await session.transcribe(new Float32Array(16000).fill(0.1),'zh',30)
      const second=await session.transcribe(new Float32Array(16000).fill(0.1),'zh',60)
      expect(first.segments).toEqual([{start:30,end:31,text:'context-1'}])
      expect(second.segments[0]?.text).toBe('context-1')
      expect(session.info.evidence.some(line=>line.includes('using MTL0 backend'))).toBe(true)
    }finally{session.close()}
  })

  it('仅有 GPU 名称不能假装启用了 Metal；缺失包允许 auto 回退',async()=>{
    const session=new NativeWhisperSession(await runtime('no-metal'),'unused')
    try{await expect(session.transcribe(new Float32Array(16000),'zh',0)).rejects.toMatchObject({detail:{native_unavailable:true}})}finally{session.close()}
    const missing=new NativeWhisperSession({runtime:'native',backend:'metal',version:NATIVE_WHISPER_VERSION,library:join(home.dir,'missing.node')},'unused')
    try{await expect(missing.transcribe(new Float32Array(16000),'zh',0)).rejects.toMatchObject({detail:{native_unavailable:true}})}finally{missing.close()}
  })

  it('进程崩溃和超时可重试，取消不能当作成功返回',async()=>{
    const crashed=new NativeWhisperSession(await runtime('crash'),'unused')
    try{await expect(crashed.transcribe(new Float32Array(16000).fill(0.1),'zh',0)).rejects.toMatchObject({detail:{retryable:true}})}finally{crashed.close()}
    const timeout=new NativeWhisperSession(await runtime('hang'),'unused',undefined,100)
    try{await expect(timeout.transcribe(new Float32Array(16000).fill(0.1),'zh',0)).rejects.toMatchObject({detail:{retryable:true}})}finally{timeout.close()}
    const controller=new AbortController(),cancelled=new NativeWhisperSession(await runtime('hang'),'unused',controller.signal)
    const pending=cancelled.transcribe(new Float32Array(16000).fill(0.1),'zh',0)
    setTimeout(()=>controller.abort(),80)
    try{await expect(pending).rejects.toThrow('取消')}finally{cancelled.close()}
  })

  it('所有系统均可显式使用 WASM；不支持原生的平台显式请求会报错',()=>{
    expect(localRuntimes({engine:'local',model:'base',runtime:'wasm'})).toEqual([{runtime:'wasm',backend:'cpu',version:'1.0.3'}])
    if(process.platform!=='darwin'||process.arch!=='arm64'){
      expect(localRuntimes({engine:'local',model:'base'}).at(-1)?.runtime).toBe('wasm')
      expect(()=>localRuntimes({engine:'local',model:'base',runtime:'native'})).toThrow('预编译')
    }
  })

  it('补零区域不计入音轨时长，纯静音不产生幻觉文本',async()=>{
    const session=new NativeWhisperSession(await runtime('overrun'),'unused')
    try{
      expect((await session.transcribe(new Float32Array(16000).fill(0.1),'zh',30)).segments).toEqual([{start:30.9,end:31,text:'末尾'}])
      expect((await session.transcribe(new Float32Array(16000),'zh',60)).segments).toEqual([])
    }finally{session.close()}
  })
})

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { HttpClient, fakeResponse, mockSender, type HttpResponse } from '../src/core/http.js'
import { modelChat } from '../src/core/video/client.js'
import { buildSummaryRequest, summaryProfile } from '../src/core/video/summary.js'
import { loadAISettings, type AISettings } from '../src/core/video/config.js'
import type { VideoContent } from '../src/core/schemas.js'
import { useTempHome } from './helpers.js'

const settings:AISettings={model:'gpt-6.1-sol',timeout:180,max_output_tokens:8192,transcription:{engine:'local',model:'base'}}
const event=(value:unknown)=>'data: '+JSON.stringify(value)+'\r\n\r\n'
const delta=(text:string,finish:string|null=null)=>({choices:[{delta:{content:text},finish_reason:finish}]})
async function withStream<T>(data:string,run:()=>Promise<T>){
  const restore=mockSender(()=>fakeResponse(data,{headers:[['content-type','text/event-stream']]}))
  try{return await run()}finally{restore()}
}
const chat=(signal?:AbortSignal,callback?:()=>void,timeout=1)=>modelChat(new HttpClient(),'https://model.example/v1','fake-secret',{model:'gpt-6.1-sol',stream:true},timeout,signal,callback)

describe('完整视频的总结输入',()=>{
  const home=useTempHome()
  async function content(){
    const path=join(home.dir,'frame.png'),canvas=createCanvas(60,40)
    canvas.getContext('2d').fillText('AI',5,20);await writeFile(path,await canvas.encode('png'))
    return {id:'1',url:'https://example.com/video/1',text:'作品文案',duration:120,processed_duration:120,truncated:false,
      frames:[{timestamp:0,path},{timestamp:60,path}],transcript:{text:'起点独特文字 终点独特文字',segments:[{start:0,end:60,text:'起点独特文字'},{start:60,end:120,text:'终点独特文字'}]}} as VideoContent
  }
  it('完整转写只发送一次，时间轴和所有画面仍在；WebP 不改变尺寸或原始 PNG',async()=>{
    const source=await content(),original=await readFile(source.frames[0]!.path)
    const {payload,metrics}=await buildSummaryRequest(source,settings)
    const body=JSON.stringify(payload)
    expect(body.split('起点独特文字')).toHaveLength(2)
    expect(body.split('终点独特文字')).toHaveLength(2)
    const parts=payload.messages[1]!.content as any[]
    const evidence=JSON.parse(parts[0].text)
    expect(evidence.transcript.rows).toEqual([[0,60,'起点独特文字'],[60,120,'终点独特文字']])
    expect(evidence.frames).toEqual([0,60]);expect(parts).toHaveLength(3)
    for(const part of parts.slice(1)){
      expect(part.image_url.url).toMatch(/^data:image\/webp;base64,/)
      const image=await loadImage(Buffer.from(part.image_url.url.split(',')[1],'base64'))
      expect([image.width,image.height]).toEqual([60,40])
    }
    expect(await readFile(source.frames[0]!.path)).toEqual(original)
    expect(metrics).toMatchObject({frames:2,transcript_chars:source.transcript!.text.length,cached:false,style:'standard'})
    expect(payload).toMatchObject({model:'gpt-6.1-sol',reasoning_effort:'low',verbosity:'low',stream:true,stream_options:{include_usage:true}})
  })
  it('未对齐的旧转写保留完整正文，其他模型和显式设置不继承 Sol 参数',async()=>{
    const source=await content();source.transcript!.text+=' 仅在全文中的补充'
    const {payload}=await buildSummaryRequest(source,{...settings,model:'another-model',summary:{stream:false}})
    const evidence=JSON.parse((payload.messages[1]!.content as any[])[0].text)
    expect(evidence.transcript).toEqual({text:source.transcript!.text})
    expect(payload).not.toHaveProperty('reasoning_effort');expect(payload).not.toHaveProperty('verbosity');expect(payload).not.toHaveProperty('stream_options')
    expect(summaryProfile({...settings,summary:{reasoning_effort:'default',image_format:'png',style:'detailed'}})).toMatchObject({reasoning_effort:undefined,image_format:'png',style:'detailed'})
  })
  it('配置校验接受总结选项，错误不会泄露密钥',async()=>{
    const file=join(home.dir,'settings.json')
    await writeFile(file,JSON.stringify({summary:{style:'detailed',reasoning_effort:'low',image_format:'png',stream:false}}))
    expect((await loadAISettings({aiConfig:file})).summary).toEqual({style:'detailed',reasoning_effort:'low',image_format:'png',stream:false})
    await writeFile(file,JSON.stringify({api_key:'fake-secret',summary:{reasoning_effort:'none'}}))
    await expect(loadAISettings({aiConfig:file})).rejects.toMatchObject({code:'USAGE'})
  })
})

describe('流式总结的完成性、计时与取消',()=>{
  it('跨 UTF-8 字节块、CRLF、注释、空事件和 usage 均正确处理；模型密钥与平台 Cookie 隔离',async()=>{
    const text=': heartbeat\r\n\r\n'+event({model:'gpt-6.1-sol',choices:[{delta:{role:'assistant'}}]})+event(delta(' \n'))+event(delta('完整中文'))+event(delta('总结','stop'))+event({choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:1},private:'fake-secret'}})+'data: [DONE]\r\n\r\n'
    const bytes=new TextEncoder().encode(text);let calls=0,first=0
    const restore=mockSender(request=>{
      calls++;expect(request.cookies).toEqual([])
      expect(Object.fromEntries(request.headers).authorization).toBe('Bearer fake-secret')
      return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=2)controller.enqueue(bytes.slice(i,i+2));controller.close()}}),{headers:{'content-type':'text/event-stream'}}) as HttpResponse
    })
    try{
      const result=await chat(undefined,()=>first++)
      expect(result.text).toBe('完整中文总结');expect(first).toBe(1);expect(calls).toBe(1)
      expect(result.metrics).toMatchObject({streamed:true,response_model:'gpt-6.1-sol',finish_reason:'stop',output_chars:6,usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16,cached_tokens:3,reasoning_tokens:1}})
      expect(result.metrics.first_token_ms).toBeGreaterThanOrEqual(result.metrics.first_event_ms!)
      expect(result.metrics.generation_ms).toBeGreaterThanOrEqual(0)
      expect(JSON.stringify(result.metrics)).not.toContain('fake-secret')
    }finally{restore()}
  })
  it.each([
    [event(delta('半截'))+'data: [DONE]\n\n','提前断开'],
    [event(delta('截断','length')),'长度限制'],
    [event({error:{message:'fake-secret'}}),'模型流返回错误'],
    ['data: fake-secret\n\n','无效 JSON'],
    ['data: null\n\n','无效 JSON'],
    [event(delta('','stop')),'非空文本'],
    [event(delta('拒绝','content_filter')),'正常完成'],
  ])('不把错误流当成功，也不反射响应中的密钥：%s',async(data,message)=>{
    await withStream(data,async()=>{
      const error=await chat().catch(e=>e)
      expect(error.message).toContain(message);expect(JSON.stringify(error)).not.toContain('fake-secret')
    })
  })
  it('JSON 兼容响应不捏造首字耗时；同一次请求直接返回，不再重试',async()=>{
    let calls=0
    const restore=mockSender(()=>{calls++;return fakeResponse({choices:[{message:{content:'兼容输出'},finish_reason:'stop'}],usage:{input_tokens:5,output_tokens:2,total_tokens:7}})})
    try{
      const result=await chat()
      expect(result.text).toBe('兼容输出');expect(calls).toBe(1)
      expect(result.metrics).toMatchObject({streamed:false,first_token_ms:null,generation_ms:null,usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}})
    }finally{restore()}
  })
  it.each(['cancel','timeout'])('挂起响应能%s，回收响应流并保留失败计时',async(kind)=>{
    let cancelled=false,calls=0
    const metrics={},controller=new AbortController()
    const restore=mockSender(()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}) as HttpResponse})
    try{
      const pending=modelChat(new HttpClient(),'https://model.example/v1','fake-secret',{},kind==='timeout'?0.03:1,controller.signal,undefined,metrics)
      if(kind==='cancel')setTimeout(()=>controller.abort(),10)
      await expect(pending).rejects.toThrow(kind==='cancel'?'已取消':'超时')
      expect(cancelled).toBe(true);expect(calls).toBe(1)
      expect(metrics).toMatchObject({first_token_ms:null,output_chars:0})
      expect((metrics as any).request_total_ms).toBeGreaterThanOrEqual(0)
    }finally{restore()}
  })
})

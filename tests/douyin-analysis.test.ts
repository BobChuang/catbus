import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrent, writeCredential } from '../src/core/auth-store.js'
import { CatbusError } from '../src/core/errors.js'
import { writeFileAtomic } from '../src/core/fsutil.js'
import { fakeResponse, mockSender } from '../src/core/http.js'
import { deterministic } from '../src/core/rand.js'
import { decodeSummaryCursor } from '../src/platforms/douyin/web/analysis.js'
import { extractVideo, summarizeVideo } from '../src/core/video/pipeline.js'
import { cli, useTempHome } from './helpers.js'
import { makeCtx } from './golden.js'

vi.mock('../src/core/video/pipeline.js',()=>({extractVideo:vi.fn(),summarizeVideo:vi.fn()}))
const NOW=1790000000123

describe('抖音视频分析 CLI 与批量边界',()=>{
  const home=useTempHome()
  beforeEach(()=>{
    vi.clearAllMocks()
    vi.mocked(summarizeVideo).mockImplementation(async(_ctx,item,settings)=>({id:item.id,url:item.url,model:settings.model!,summary:'测试总结',content:{} as any,files:{analysis:'/analysis.json',summary:'/summary.md'},cached:false}))
    vi.mocked(extractVideo).mockResolvedValue({id:'2',transcript:{text:'实际口播'}} as any)
  })
  async function account(){
    const ctx=makeCtx({platform:'douyin',cookies:'sessionid=fake; ttwid=fake; UIFID=fake; web_sign_token=fake; s_v_web_id=verify_fake',cookieDomain:'.douyin.com'})
    Object.assign(ctx.credential.scopes.main!.tokens,{webid:'7300000000000000000',msToken:{value:'fake-ms-token',at:NOW}})
    await writeCredential(ctx.credential);await setCurrent('douyin','web','default')
    await writeFileAtomic(join(home.dir,'ai.json'),JSON.stringify({base_url:'https://model.example/v1',api_key:'fake-key',model:'gpt-6.1-sol'}))
  }
  async function server<T>(run:(paths:string[])=>Promise<T>,pages?:Record<string,any>){
    const paths:string[]=[];const clock=deterministic({now:NOW})
    const work=(id:string,image=false)=>({aweme_id:id,aweme_type:image?68:0,desc:'作品'+id,video:{play_addr:{url_list:['https://media.example/'+id+'.mp4']}}})
    const restore=mockSender(p=>{
      const url=new URL(p.url);paths.push(url.pathname)
      if(url.pathname.endsWith('/collects/list/'))return fakeResponse({status_code:0,collects_list:[{collects_id_str:'1001',collects_name:'AI'}],has_more:false})
      if(url.pathname.endsWith('/collects/video/list/'))return fakeResponse(pages?.[url.searchParams.get('cursor')??'0']??{status_code:0,aweme_list:[work('1',true),work('2'),work('3')],has_more:false,cursor:0})
      if(url.pathname.endsWith('/aweme/detail/'))return fakeResponse({status_code:0,aweme_detail:work('2')})
      throw new Error('未配置的请求：'+url.pathname)
    })
    try{return await run(paths)}finally{restore();clock()}
  }

  it('默认只总结 1 个视频，跳过图文；--limit 2 恰好调用两次总结，不多收费',async()=>{
    await account()
    await server(async(paths)=>{
      const first=await cli('douyin','folder','summarize','AI')
      expect(first.code).toBe(0);expect(first.env.data.map((v:any)=>v.id)).toEqual(['2'])
      expect(vi.mocked(summarizeVideo)).toHaveBeenCalledTimes(1)
      vi.mocked(summarizeVideo).mockClear()
      const two=await cli('douyin','folder','summarize','AI','--limit','2','--max-seconds','20','--max-frames','3')
      expect(two.code).toBe(0);expect(two.env.data.map((v:any)=>v.id)).toEqual(['2','3'])
      expect(vi.mocked(summarizeVideo)).toHaveBeenCalledTimes(2)
      expect(vi.mocked(summarizeVideo).mock.calls[0]![0].options).toMatchObject({maxSeconds:20,maxFrames:3})
      expect(paths.filter(p=>p.endsWith('/collects/video/list/'))).toHaveLength(2)
    })
  })

  it('游标续读下一条，不重复总结上一条；错误收藏夹和无效游标在读取前拒绝',async()=>{
    await account()
    await server(async()=>{
      const first=await cli('douyin','folder','summarize','AI','--limit','1')
      const next=await cli('douyin','folder','summarize','AI','--limit','1','--cursor',first.env.page.cursor)
      expect(next.code).toBe(0);expect(next.env.data[0].id).toBe('3');expect(next.env.page.has_more).toBe(false)
      expect(vi.mocked(summarizeVideo).mock.calls.map(call=>call[1].id)).toEqual(['2','3'])
      const wrong=await cli('douyin','folder','summarize','音乐','--cursor',first.env.page.cursor)
      expect([wrong.code,wrong.env.error.code]).toEqual([2,'USAGE'])
    })
    expect(()=>decodeSummaryCursor('not-a-cursor','AI')).toThrow('游标无效')
  })

  it('--all 跨 API 页跳过图文、按顺序总结，JSONL 每个视频一行',async()=>{
    await account()
    const pages={
      '0':{status_code:0,aweme_list:[{aweme_id:'1',aweme_type:68}],cursor:20,has_more:true},
      '20':{status_code:0,aweme_list:[{aweme_id:'2',desc:'视频2'}],cursor:40,has_more:true},
      '40':{status_code:0,aweme_list:[{aweme_id:'3',desc:'视频3'}],cursor:0,has_more:false},
    }
    await server(async()=>{
      const result=await cli('douyin','folder','summarize','AI','--all','-o','jsonl')
      expect(result.code).toBe(0)
      expect(result.stdout.trim().split('\n').map(line=>JSON.parse(line).id)).toEqual(['2','3'])
      expect(vi.mocked(summarizeVideo).mock.calls.map(call=>call[1].id)).toEqual(['2','3'])
    },pages)
  })

  it('模型失败停止，不自动重试收费调用，也不继续下一条',async()=>{
    await account();vi.mocked(summarizeVideo).mockRejectedValue(new CatbusError('UPSTREAM','model failed'))
    await server(async()=>{
      const result=await cli('douyin','folder','summarize','AI','--limit','2')
      expect([result.code,result.env.error.code]).toEqual([7,'UPSTREAM'])
      expect(vi.mocked(summarizeVideo)).toHaveBeenCalledTimes(1)
    })
  })

  it('单视频提取和总结调用各自流程，--model 覆盖配置',async()=>{
    await account()
    await server(async()=>{
      const extracted=await cli('douyin','item','extract','7433523124836060416')
      expect(extracted.code).toBe(0);expect(extracted.env.data.transcript.text).toBe('实际口播')
      const summarized=await cli('douyin','item','summarize','7433523124836060416','--model','chosen-model')
      expect(summarized.code).toBe(0);expect(summarized.env.data.model).toBe('chosen-model')
    })
  })

  it('分页和提取参数先校验；缺少模型配置不会下载视频或请求平台',async()=>{
    const invalid=await cli('douyin','folder','summarize','AI','--max-frames','33')
    expect([invalid.code,invalid.env.error.code]).toEqual([2,'USAGE'])
    await account();await import('node:fs/promises').then(fs=>fs.rm(join(home.dir,'ai.json')))
    await server(async(paths)=>{
      const result=await cli('douyin','folder','summarize','AI')
      expect([result.code,result.env.error.code]).toEqual([2,'USAGE']);expect(paths).toEqual([])
    })
  })
})

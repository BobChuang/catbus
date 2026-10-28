import { z } from 'zod'
import { DOWNLOAD, filter, PRODUCT } from '../../core/options.js'
import { definePlatform, type Handler, handlers } from '../../core/registry.js'
import { type Args, checkMsgSend, type Options } from '../../core/vocab.js'

/** 懒加载 web 端的 handler：只有执行到这条命令时才加载实现。 */
const load = () => import('./web/commands.js')

/** 读取类命令：缺 UIFID 时自动补上，整条命令重跑一次（commands.retryWithUifid）。 */
const { impl: read } = handlers(load, (m, handler) => m.retryWithUifid(handler) as Handler)

/**
 * 登录与写操作不整条重跑：重跑会把已经做完的步骤再做一遍，例如私信的文字已经发出、之后取分享卡片时撞上
 * "Uifid Not Found"，重跑就会把文字再发一次；登录重跑会再出一次二维码。缺 UIFID 时照常报 RISK_CONTROL。
 */
const { impl: write } = handlers(load)

/** 收费模型调用不整条重试；仅 analysis 模块里的平台读取步骤沿用 UIFID 修复。 */
const { impl: analyze } = handlers(() => import('./web/analysis.js'))
const extraction = {
  dir: DOWNLOAD.dir.describe('视频提取和总结的产物根目录，默认使用 catbus 缓存'),
  aiConfig: z.string().optional().describe('模型 JSON 或原项目 .env 配置文件，默认 ~/.catbus/ai.json'),
  maxFrames: z.number().int().min(1).max(32).default(8).describe('抽样画面数量，默认 8，最多 32'),
  maxSeconds: z.number().positive().optional().describe('只分析视频前 N 秒，默认完整视频'),
  language: z.enum(['zh', 'en', 'auto']).default('zh').describe('语音语言，默认 zh'),
  refresh: z.boolean().optional().describe('重新提取和总结，忽略已有分析缓存'),
}
const summarization = { ...extraction, model: z.string().optional().describe('总结模型名，覆盖配置中的模型') }

/** 平台私有选项（AGENTS 4.7 的 douyin 行）。 */
const folder = (summary: string) => ({ folder: z.string().optional().describe(summary) })

/** `msg send`：比词表多了 --file / --share 也算消息内容。--to 与 --item 同时用时由 handler 报 UNSUPPORTED。 */
const msgSendCheck = (a: Args, o: Options) => checkMsgSend(a, o, { content: ['file', 'share'] })

export default definePlatform({
  id: 'douyin',
  name: '抖音',
  aliases: ['dy'],
  item: '作品',
  endpoints: {
    web: {
      login: { methods: ['qrcode', 'sms', 'cookie'], default: 'qrcode' },
      commands: {
        'auth login': write('full', 'authLogin', {
          options: { sso: z.boolean().optional().describe('短信登录改走 login.douyin.com 页的 SSO 链（sms）') },
        }),
        'auth status': read('full', 'authStatus'),

        'user get': read('full', 'userGet'),
        'user search': read('full', 'userSearch', {
          options: {
            fans: z.enum(['0_1k', '1k_1w', '1w_10w', '10w_100w', '100w_']).optional().describe('粉丝数区间'),
            userType: z.enum(['common', 'enterprise', 'personal']).optional().describe('用户类型：普通 / 企业 / 个人认证'),
          },
        }),
        'user items': read('full', 'userItems'),
        'user likes': read('full', 'userLikes'),
        // 上游没有收藏作品列表（get_collect_list 返回的是收藏夹）
        'user collects': 'none',
        'user followers': read('full', 'userFollowers'),
        'user following': read('full', 'userFollowing'),
        'user follow': 'none',
        'user unfollow': 'none',

        'item get': read('full', 'itemGet'),
        'item search': read('full', 'itemSearch', {
          // 综合频道（上游 search_general_work）的筛选值放在 filter_selected 里，--type image 是它的 content_type 2（图文）
          note: '--type video 走视频频道搜索，其余走综合频道；--type image 只要图文',
          options: {
            sort: filter.sort('general', 'popular', 'latest'),
            time: filter.time('all', 'day', 'week', 'half_year'),
            type: filter.type('all', 'video', 'image'),
            length: z.enum(['all', 'short', 'medium', 'long']).optional().describe('视频时长：1 分钟内 / 1–5 分钟 / 5 分钟以上'),
            range: z.enum(['all', 'seen', 'unseen', 'following']).optional().describe('搜索范围：看过 / 没看过 / 关注的人'),
          },
        }),
        'item related': 'none',
        'item list': read('partial', 'itemList', { note: '取发布页的作品预览（work_list）；定时未发布的作品 status 为 draft' }),
        'item media': read('full', 'itemMedia'),
        'item download': read('full', 'itemDownload'),
        'item extract': analyze('full', 'itemExtract', {
          summary: '提取视频音轨、抽样画面和语音转写', args: [{ name: 'item', summary: '视频作品：ID 或 URL' }],
          auth: 'required', output: 'VideoContent', options: extraction,
          note: '本地 FFmpeg / Whisper；Apple Silicon 自动使用 Metal，其余系统使用 WASM；首次下载并校验语音模型，无需 Python、编译器或系统 FFmpeg',
        }),
        'item summarize': analyze('full', 'itemSummarize', {
          summary: '根据视频真实语音和画面生成中文总结', args: [{ name: 'item', summary: '视频作品：ID 或 URL' }],
          auth: 'required', output: 'VideoSummary', options: summarization,
          note: '使用用户配置的模型服务；提取结果、逐字稿和总结保存到本地，可复用缓存',
        }),
        'item like': write('full', 'itemLike'),
        'item unlike': write('full', 'itemUnlike'),
        'item collect': write('full', 'itemCollect', { options: folder('收藏后移进这个收藏夹（ID 或名字）') }),
        'item uncollect': write('full', 'itemUncollect', { options: folder('只从这个收藏夹移出，仍保留收藏（ID 或名字）') }),
        'item publish': write('full', 'itemPublish', {
          supports: ['title', 'text', 'image', 'video', 'cover', 'tag', 'topic', 'mention', 'poi', 'visibility', 'schedule'],
          options: {
            poiName: z.string().optional().describe('地点名称，配合 --poi'),
            series: z.string().optional().describe('加入合集（合集 ID）'),
            hotspot: z.string().optional().describe('关联热点（热点词）'),
            noDownload: z.boolean().optional().describe('不允许别人下载'),
          },
        }),
        'item delete': 'none',

        'product get': read('partial', 'productGet', { note: '上游的商品接口只给详情图、规格和跳转链接：只有标题、图片和价格，其余字段为空' }),

        'comment list': read('full', 'commentList', {
          options: { product: PRODUCT, label: z.string().optional().describe('商品评价按标签筛选（标签名或 id，如 好评、有图）') },
        }),
        'comment replies': read('full', 'commentReplies'),
        'comment add': write('full', 'commentAdd'),
        'comment delete': 'none',
        'comment like': 'none',
        'comment unlike': 'none',

        'feed list': read('partial', 'feedList', {
          note: 'hot、following 规划中',
          options: { kind: filter.kind('recommend', 'hot', 'following') },
        }),

        'live get': read('full', 'liveGet'),
        'live list': 'none',
        'live search': read('full', 'liveSearch'),
        'live categories': 'none',
        'live listen': read('full', 'liveListen'),
        'live history': read('partial', 'liveHistory', { note: '只有进房时 im/fetch 带回的最近 15 条' }),
        'live send': write('partial', 'liveSend', { note: '--gift 规划中' }),
        'live like': write('full', 'liveLike', { options: { count: z.number().int().positive().optional().describe('一次点赞的次数，默认 1') } }),
        'live rank': read('full', 'liveRank', {
          options: { ranking: z.enum(['contribution', 'thousand']).default('contribution').describe('榜单：贡献榜 / 千票榜') },
        }),
        'live gifts': 'none',
        'live products': read('full', 'liveProducts'),
        'live media': read('partial', 'liveMedia', { note: '拉流地址取自房间资料（room/web/enter）' }),
        'live replays': 'none',
        'live start': 'none',
        'live stop': 'none',

        'keyword suggest': 'none',
        'keyword hot': 'none',

        'notice list': read('full', 'noticeList', {
          options: { group: z.enum(['all', 'fans', 'mention', 'comment', 'like', 'danmaku']).optional().describe('通知分组，不带时为默认分组') },
        }),
        'notice count': 'none',

        'msg list': 'none',
        'msg history': 'none',
        'msg send': write('full', 'msgSend', {
          options: {
            file: z.string().optional().describe('发文件（路径或 URL，≤10MB）'),
            share: z.string().optional().describe('分享作品 / 用户名片 / 网页卡片（ID 或 URL）'),
          },
          check: msgSendCheck,
        }),
        'msg listen': read('full', 'msgListen'),
        'msg read': 'none',
        'msg revoke': 'none',
        'msg delete': 'none',

        'media upload': write('full', 'mediaUpload'),

        'folder list': read('full', 'folderList'),
        'folder items': read('full', 'folderItems', {
          args: [{ name: 'folder', summary: '收藏夹 ID 或完整名称' }],
          note: '只读取当前账号的收藏夹，保留平台返回顺序；接口依据补充来源 video-analyzer 的 CollectsDetail',
        }),
        'folder summarize': analyze('full', 'folderSummarize', {
          summary: '逐条总结收藏夹内的视频', args: [{ name: 'folder', summary: '收藏夹 ID 或完整名称' }],
          auth: 'required', output: 'VideoSummary[]', paged: true, options: summarization,
          note: '默认总结 1 个视频；--limit 指定视频数，--all 处理全部；跳过图文，顺序读取，已完成结果按配置缓存',
        }),
        'folder create': 'none',
        'folder update': 'none',
        'folder delete': 'none',

        'series list': 'none',
        'series items': 'none',

        'history list': 'none',
        'topic search': 'none',
        'poi search': 'none',
      },
    },
    app: 'planned',
    pc: 'planned',
  },
})

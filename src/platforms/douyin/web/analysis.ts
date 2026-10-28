import { CatbusError } from '../../../core/errors.js'
import { join, resolve } from 'node:path'
import { cacheDir } from '../../../core/paths.js'
import * as rand from '../../../core/rand.js'
import type { HandlerContext } from '../../../core/registry.js'
import type { Item } from '../../../core/schemas.js'
import { paged } from '../../../core/toolkit.js'
import { type AISettings, type AnalysisOptions, loadAISettings } from '../../../core/video/config.js'
import { extractVideo, summarizeVideo } from '../../../core/video/pipeline.js'
import { VideoRun } from '../../../core/video/metrics.js'
import { douyin } from './client.js'
import { folderItems, itemGet, retryWithUifid } from './commands.js'
import { PROFILE, WWW } from './profile.js'

type Ctx = HandlerContext
const getItem = retryWithUifid(itemGet) as typeof itemGet
const getFolder = retryWithUifid(folderItems) as typeof folderItems
const mediaHeaders: [string, string][] = [['user-agent', PROFILE.ua], ['referer', `${WWW}/`]]

async function resolveVideo<T>(ctx: Ctx, run: VideoRun, work: (entry: { cache_hit: boolean }) => Promise<T>): Promise<T> {
  try { return await run.stage('resolve', work) } catch (error) {
    await run.finish(resolve((ctx.options as AnalysisOptions).dir ?? join(cacheDir(ctx.platform.id), 'analysis')), false)
    throw error
  }
}

export async function itemExtract(ctx: Ctx) {
  const run = new VideoRun(ctx.log)
  const settings = await loadAISettings(ctx.options as AnalysisOptions)
  const item = await resolveVideo(ctx, run, () => getItem(ctx))
  const d = await douyin(ctx)
  return extractVideo(ctx, item, settings, d.http, mediaHeaders, run)
}

export async function itemSummarize(ctx: Ctx) {
  const run = new VideoRun(ctx.log)
  const settings = await loadAISettings(ctx.options as AnalysisOptions, true)
  const item = await resolveVideo(ctx, run, () => getItem(ctx))
  const d = await douyin(ctx)
  return summarizeVideo(ctx, item, settings, d.http, mediaHeaders, run)
}

interface Position { folder: string; cursor: string | null; index: number }
const PREFIX = 'dysum:'

export function decodeSummaryCursor(cursor: string | null, folder: string): Position {
  if (cursor == null) return { folder, cursor: null, index: 0 }
  try {
    if (!cursor.startsWith(PREFIX) || cursor.length > 8192) throw new Error()
    const p = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), 'base64url').toString('utf8'))
    if (p.folder !== folder || !(p.cursor === null || typeof p.cursor === 'string') || !Number.isSafeInteger(p.index) || p.index < 0 || p.index > 10000) throw new Error()
    return p
  } catch {
    throw new CatbusError('USAGE', '收藏夹总结游标无效，或不属于这个收藏夹', { hint: '使用同一收藏夹 folder summarize 输出的 page.cursor；从头读取请省略 --cursor' })
  }
}

const encode = (p: Position) => PREFIX + Buffer.from(JSON.stringify(p)).toString('base64url')
type FolderPage = Awaited<ReturnType<typeof folderItems>>
interface Batch { settings: AISettings; at?: string | null; page?: FolderPage }
const batches = new WeakMap<Ctx['args'], Batch>()

/**
 * API 一页可能有 20 个作品，但一次 handler 只生成一个视频的总结。
 * core 按 --limit 拉取下一条，避免先分析整页再截断，产生用户没要求的模型费用。
 */
export async function folderSummarize(ctx: Ctx) {
  const run = new VideoRun(ctx.log)
  const folder = ctx.args.folder!
  let position = decodeSummaryCursor(ctx.cursor, folder)
  let batch = batches.get(ctx.args)
  if (!batch) {
    batch = { settings: await loadAISettings(ctx.options as AnalysisOptions, true) }
    batches.set(ctx.args, batch)
  }
  for (let pages = 0; pages < 100; pages++) {
    await resolveVideo(ctx, run, async entry => {
      if (!batch!.page || batch!.at !== position.cursor) {
        batch!.page = await getFolder({ ...ctx, cursor: position.cursor })
        batch!.at = position.cursor
      } else entry.cache_hit = true
    })
    const data = batch.page!.data as Item[]
    const { page } = batch.page!
    const index = data.findIndex((item: Item, i: number) => i >= position.index && item.kind === 'video')
    if (index >= 0) {
      const item = data[index]!
      const d = await douyin(ctx)
      const result = await summarizeVideo(ctx, item, batch.settings, d.http, mediaHeaders, run)
      const left = data.slice(index + 1).some((v: Item) => v.kind === 'video')
      const next = left ? { ...position, index: index + 1 } : { folder, cursor: page.cursor, index: 0 }
      const hasMore = left || page.has_more
      return paged([result], hasMore ? encode(next) : null, hasMore)
    }
    if (!page.has_more || page.cursor == null || page.cursor === position.cursor) return paged([], null, false)
    position = { folder, cursor: page.cursor, index: 0 }
    await rand.sleep(ctx.platform.pageInterval)
  }
  throw new CatbusError('UPSTREAM', '连续读取 100 页未找到视频，请检查收藏夹或稍后重试')
}

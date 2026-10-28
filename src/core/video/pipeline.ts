import { chmod, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CatbusError } from '../errors.js'
import { downloadMedia } from '../files.js'
import { ensureDir, isoNow, writeFileAtomic } from '../fsutil.js'
import { HttpClient, type HeaderInit } from '../http.js'
import { cacheDir } from '../paths.js'
import type { HandlerContext } from '../registry.js'
import type { Item, VideoContent, VideoSummary } from '../schemas.js'
import type { AISettings, AnalysisOptions } from './config.js'
import { modelChat } from './client.js'
import { transcribeAudio } from './transcribe.js'
import { runVideoWorker } from './worker.js'
import { ffmpegWorker } from './workers.js'
import { hashVideoFile, lockedVideo, readVideoJson, validArtifacts, videoKey } from './cache.js'
import { VideoRun } from './metrics.js'
import { buildSummaryRequest, summaryProfile, SUMMARY_PROMPT_VERSION } from './summary.js'

const key = videoKey
const readJson = readVideoJson

/** 同一份产物只让一个进程写；异常退出的旧锁按进程存活情况回收。 */
const locked = lockedVideo

function optionsOf(ctx: HandlerContext): AnalysisOptions { return ctx.options as AnalysisOptions }

function validExtraction(saved: any): boolean {
  const result = saved?.result
  return Number.isFinite(result?.duration) && result.duration > 0 && Number.isFinite(result.processed_duration) && result.processed_duration > 0 && result.processed_duration <= result.duration + 0.05 &&
    typeof result.truncated === 'boolean' && Array.isArray(result.frames) && result.frames.length > 0 && Array.isArray(saved.files) &&
    result.frames.every((f: any) => Number.isFinite(f?.timestamp) && f.timestamp >= 0 && f.timestamp < result.processed_duration && saved.files.some((v: any) => v?.path === f.path)) &&
    (result.audio_path === null || typeof result.audio_path === 'string' && saved.files.some((v: any) => v?.path === result.audio_path))
}

function rootOf(ctx: HandlerContext, item: Item): string {
  if (item.kind !== 'video') throw new CatbusError('UNSUPPORTED', '视频内容提取只支持视频作品，图文作品请使用 item get 或 item download')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)) throw new CatbusError('UPSTREAM', '视频 ID 格式不正确')
  return join(resolve(optionsOf(ctx).dir ?? join(cacheDir(ctx.platform.id), 'analysis')), `${ctx.platform.id}_${item.id}`)
}

export async function extractVideo(ctx: HandlerContext, item: Item, settings: AISettings, http: HttpClient, headers?: HeaderInit, run = new VideoRun(ctx.log)): Promise<VideoContent> {
  const root = rootOf(ctx, item)
  let result: VideoContent | undefined
  try { result = await locked(root, () => extract(ctx, item, settings, http, root, run, headers)); return result } finally {
    const file = await run.finish(root, !!result)
    if (result) { result.timings = run.report; result.files!.metrics = file }
  }
}

async function extract(ctx: HandlerContext, item: Item, settings: AISettings, http: HttpClient, root: string, run: VideoRun, headers?: HeaderInit): Promise<VideoContent> {
  const options = optionsOf(ctx)
  const video = await run.stage('download', async entry => {
    const dir = join(root, 'media'), marker = join(dir, 'download.json')
    const saved = options.refresh ? null : await readJson(marker)
    if (saved?.id === item.id && await validArtifacts(dir, saved.files)) { entry.cache_hit = true; return saved.files[0] as { path: string; size: number; sha256: string } }
    const media = item.media.find((m) => m.type === 'video' && m.url)
    if (!media) throw new CatbusError('UPSTREAM', '作品没有可下载的视频地址，未使用文案代替视频内容')
    const files = await downloadMedia({ ...ctx, options: { dir, overwrite: true } }, http, item.id, [media], { headers, ext: () => 'mp4', maxBytes: 256 * 1024 * 1024 })
    const video = files[0]
    if (!video) throw new CatbusError('UPSTREAM', '视频下载失败')
    if (video.size > 256 * 1024 * 1024) throw new CatbusError('UNSUPPORTED', '当前 WASM 提取支持最大 256 MB 的视频文件')
    await chmod(video.path, 0o600)
    const result = { path: video.path, size: video.size, sha256: await hashVideoFile(video.path) }
    await writeFileAtomic(marker, JSON.stringify({ id: item.id, files: [result] }))
    return result
  })
  const dir = join(root, 'extractions', key({ version: 2, video: video.sha256, frames: options.maxFrames ?? 8, seconds: options.maxSeconds ?? null }))
  await ensureDir(dir)
  const extracted = await run.stage('extract', async entry => {
    const marker = join(dir, 'extraction.json'), saved = options.refresh ? null : await readJson(marker)
    if (validExtraction(saved) && await validArtifacts(dir, saved.files)) { entry.cache_hit = true; return saved.result as Pick<VideoContent, 'duration' | 'processed_duration' | 'truncated' | 'audio_path' | 'frames'> }
    ctx.log.info(`正在提取视频画面：${item.id}`)
    const extracted = await runVideoWorker<Pick<VideoContent, 'duration' | 'processed_duration' | 'truncated' | 'audio_path' | 'frames'>>(ffmpegWorker,
      { video: video.path, dir, maxFrames: options.maxFrames ?? 8, maxSeconds: options.maxSeconds }, ctx.log, ctx.signal)
    const paths = [...extracted.frames.map(f => f.path), ...(extracted.audio_path ? [extracted.audio_path] : [])]
    const files = await Promise.all(paths.map(async path => ({ path, size: (await stat(path)).size, sha256: await hashVideoFile(path) })))
    await writeFileAtomic(marker, JSON.stringify({ result: extracted, files }))
    return extracted
  })
  const transcript = await run.stage('transcribe', async entry => {
    const modelHttp = new HttpClient({ ...ctx.config, timeout: settings.timeout, log: ctx.log })
    return extracted.audio_path ? transcribeAudio(extracted.audio_path, settings, modelHttp, ctx.log, options.language ?? 'zh', ctx.signal, options.refresh, {
      cacheDir: join(root, 'transcripts'), onStats: stats => { run.report.transcription = stats; entry.cache_hit = stats.chunks.length > 0 && stats.cached_chunks === stats.chunks.length },
    }) : null
  })
  if (!transcript?.text) ctx.log.warn('未提取到语音文本，总结将明确说明仅依据抽样画面')
  const contentDir = join(root, 'contents', key({ extract: dir, transcript, text: item.text, title: item.title, author: item.author }))
  const files = { content: join(contentDir, 'content.json'), transcript: join(contentDir, 'transcript.txt') }
  const content: VideoContent = { id: item.id, url: item.url, title: item.title, text: item.text, author: item.author,
    ...extracted, video_path: video.path, transcript, extracted_at: isoNow(), files }
  await run.stage('save', async () => {
    await writeFileAtomic(files.transcript, transcript?.text ?? '')
    await writeFileAtomic(files.content, JSON.stringify(content, null, 2) + '\n')
  })
  return content
}

export async function summarizeVideo(ctx: HandlerContext, item: Item, settings: AISettings, http: HttpClient, headers?: HeaderInit, run = new VideoRun(ctx.log)): Promise<VideoSummary> {
  const root = rootOf(ctx, item)
  let result: VideoSummary | undefined
  try { result = await locked(root, async () => {
    const content = await extract(ctx, item, settings, http, root, run, headers)
    const profile = summaryProfile(settings)
    const dir = join(root, 'summaries', key({ version: SUMMARY_PROMPT_VERSION, model: settings.model, url: settings.base_url, tokens: settings.max_output_tokens, content: content.files!.content, profile }))
    return run.stage('summarize', async entry => {
      run.report.summary = { cached: false, style: profile.style, reasoning_effort: profile.reasoning_effort, image_format: profile.image_format,
        frames: content.frames.length, transcript_chars: content.transcript?.text.length ?? 0, transcript_segments: content.transcript?.segments.length ?? 0 }
      const analysis = join(dir, 'analysis.json')
      const summary = join(dir, 'summary.md')
      const existing = optionsOf(ctx).refresh ? null : await readJson(analysis)
      if (existing?.id === item.id && existing.model === settings.model && typeof existing.summary === 'string' && existing.summary.trim() && await readFile(summary, 'utf8').catch(() => null) === existing.summary + '\n') {
        ctx.log.info(`复用视频总结缓存：${item.id}`)
        entry.cache_hit = true
        run.report.summary.cached = true
        return { ...existing, cached: true } as VideoSummary
      }
      ctx.log.info(`正在总结视频：${item.id}（${settings.model}）`)
      const request = await buildSummaryRequest(content, settings)
      run.report.summary = request.metrics
      const modelHttp = new HttpClient({ ...ctx.config, timeout: settings.timeout, log: ctx.log })
      const { text } = await modelChat(modelHttp, settings.base_url!, settings.api_key!, request.payload, settings.timeout, ctx.signal,
        () => ctx.log.info('模型已开始返回总结，正在收集完整结果'), request.metrics)
      const notice = content.truncated ? `> 本次仅分析视频前 ${content.processed_duration.toFixed(1)} 秒（全长 ${content.duration.toFixed(1)} 秒）。\n\n` : ''
      const audioNotice = !content.transcript?.text ? '> 未提取到语音文本，以下总结仅依据抽样画面，无法覆盖全部口播。\n\n' : ''
      const result: VideoSummary = { id: item.id, url: item.url, model: settings.model!, summary: notice + audioNotice + text,
        content, files: { analysis, summary }, cached: false }
      await run.stage('save', async () => {
        await writeFileAtomic(summary, result.summary + '\n')
        await writeFileAtomic(analysis, JSON.stringify(result, null, 2) + '\n')
      })
      ctx.log.info(`已保存总结：${summary}`)
      return result
    })
  }); return result } finally {
    const file = await run.finish(root, !!result)
    if (result) { result.timings = run.report; result.files.metrics = file }
  }
}

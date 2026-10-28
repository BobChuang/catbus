import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { availableParallelism, totalmem } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { CatbusError } from '../errors.js'
import { ensureDir, writeFileAtomic } from '../fsutil.js'
import { HttpClient } from '../http.js'
import type { Logger } from '../log.js'
import { catbusHome } from '../paths.js'
import type { VideoTranscript, VideoTimings } from '../schemas.js'
import type { AISettings } from './config.js'
import { modelJson } from './client.js'
import { runVideoProcess } from './worker.js'
import { wavSamples, whisperWorker } from './workers.js'
import { readVideoJson, videoKey } from './cache.js'
import { localRuntimes, NativeWhisperSession, type LocalRuntime } from './native.js'

/** ggml-org 官方模型仓库：固定 revision、文件大小和 LFS SHA256。 */
export const WHISPER_MODELS = {
  base: { size: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  tiny: { size: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
} as const
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function modelFile(settings: AISettings, http: HttpClient, log: Logger): Promise<string> {
  const config = settings.transcription
  if (config.model_path) {
    if (!(await stat(config.model_path).catch(() => null))?.isFile()) throw new CatbusError('USAGE', 'Whisper model_path 指向的文件不存在')
    return config.model_path
  }
  const name = config.model as keyof typeof WHISPER_MODELS
  const manifest = WHISPER_MODELS[name]
  const dir = join(catbusHome(), 'cache', 'whisper')
  await ensureDir(dir)
  const dest = join(dir, `ggml-${name}.bin`)
  if ((await stat(dest).catch(() => null))?.size === manifest.size && await fileSha256(dest) === manifest.sha256) return dest
  log.info(`首次使用，下载本地 Whisper ${name} 模型（约 ${Math.ceil(manifest.size / 1024 / 1024)} MB）`)
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-${name}.bin`
  const response = await http.request({ url, cookies: false, timeout: 600 })
  if (!response.ok) throw new CatbusError('NETWORK', `Whisper 模型下载失败（HTTP ${response.status}）`, { hint: '稍后重试，或通过 transcription.model_path 指定本地模型' })
  const tmp = `${dest}.${process.pid}.part`
  const hash = createHash('sha256')
  let size = 0
  const check = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    if (size > manifest.size) return callback(new Error('模型大小超过固定版本的大小'))
    hash.update(chunk)
    callback(null, chunk)
  } })
  try {
    const stream = response.body ? Readable.fromWeb(response.body as unknown as WebReadableStream) : Readable.from([Buffer.from(await response.arrayBuffer())])
    await pipeline(stream, check, createWriteStream(tmp, { mode: 0o600 }))
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('模型 SHA256 校验失败')
    await rename(tmp, dest)
  } catch {
    await rm(tmp, { force: true })
    throw new CatbusError('NETWORK', 'Whisper 模型下载不完整或校验失败，未使用该文件')
  }
  return dest
}

/** 兼容转写 API 每段小于 25 MB，分段后恢复全视频时间偏移。 */
export function wavChunk(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => [...s].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0) })
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))), true)
  return bytes
}

export interface TranscriptionProgress { completedSamples: number; segments: VideoTranscript['segments'] }

export function validTranscriptionProgress(value: any): value is TranscriptionProgress {
  return Number.isSafeInteger(value?.completedSamples) && value.completedSamples >= 0 && Array.isArray(value.segments) && value.segments.length <= 100000 &&
    value.segments.every((s: any) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && s.start >= 0 && s.end >= s.start && s.end <= value.completedSamples / 16000 + 1 && typeof s.text === 'string')
}

export interface TranscriptionOptions {
  cacheDir?: string
  onStats?: (stats: NonNullable<VideoTimings['transcription']>) => void
}

export async function transcribeAudio(audio: string, settings: AISettings, http: HttpClient, log: Logger, language: string, signal?: AbortSignal, refresh = false, options: TranscriptionOptions = {}): Promise<VideoTranscript> {
  if (settings.transcription.engine !== 'local') return transcribeWithRuntime(audio, settings, http, log, language, signal, refresh, options)
  const runtimes = localRuntimes(settings.transcription)
  if (settings.transcription.runtime !== 'wasm' && runtimes[0]?.runtime === 'wasm') log.info('本机未提供原生加速包，使用 WASM / CPU 转写')
  for (let i = 0; i < runtimes.length; i++) {
    const runtime = runtimes[i]!
    try { return await transcribeWithRuntime(audio, settings, http, log, language, signal, refresh, options, runtime) } catch (error) {
      if (signal?.aborted || i === runtimes.length - 1 || !(error instanceof CatbusError) || !(error.detail as any)?.native_unavailable) throw error
      log.warn(`原生 ${runtime.backend} 后端不可用，回退到 ${runtimes[i + 1]!.runtime} / ${runtimes[i + 1]!.backend}`)
    }
  }
  throw new CatbusError('ERROR', '没有可用的本地转写运行时')
}

async function transcribeWithRuntime(audio: string, settings: AISettings, http: HttpClient, log: Logger, language: string, signal?: AbortSignal, refresh = false, options: TranscriptionOptions = {}, runtime?: LocalRuntime): Promise<VideoTranscript> {
  const config = settings.transcription
  if (config.engine === 'local') {
    runtime ??= { runtime: 'wasm', backend: 'cpu', version: '1.0.3' }
    const model = await modelFile(settings, http, log)
    const engine = runtime.runtime === 'wasm' ? 'whisper.cpp@1.0.3-single' : `native@${runtime.version}-${runtime.backend}-flash-greedy-4threads-bounded-v1`
    const fingerprint = videoKey({ version: 2, audio: await fileSha256(audio), model: await fileSha256(model), name: config.model, language, engine })
    const dir = join(options.cacheDir ?? join(dirname(audio), 'transcripts'), fingerprint)
    if (refresh) await rm(dir, { recursive: true, force: true })
    await ensureDir(dir)
    const samples = wavSamples(await readFile(audio))
    const chunkLength = 30 * 16000
    const concurrency = runtime.runtime === 'native' ? 1 : config.concurrency ?? Math.max(1, Math.min(8, availableParallelism() - 2, Math.floor(totalmem() / (2 * 1024 ** 3))))
    const count = Math.ceil(samples.length / chunkLength)
    const meta = { runtime: runtime.runtime, backend: runtime.backend, runtime_version: runtime.version }
    const stats: NonNullable<VideoTimings['transcription']> = { chunks: [], concurrency, cached_chunks: 0, retries: 0, ...meta }
    options.onStats?.(stats)
    const valid = (segments: any, offset: number, end: number): segments is VideoTranscript['segments'] => validTranscriptionProgress({ completedSamples: end, segments }) && segments.every((s: any) => s.start >= offset / 16000 && s.start <= end / 16000 + 1)
    const whole = await readVideoJson(join(dir, 'transcript.json'))
    if (whole?.fingerprint === fingerprint && typeof whole.result?.text === 'string' && valid(whole.result.segments, 0, samples.length) && whole.result.text === whole.result.segments.map((s: any) => s.text).join(' ').trim()) {
      stats.cached_chunks = count
      if (whole.backend) { stats.device = whole.backend.device; stats.backend_evidence = whole.backend.evidence }
      stats.chunks = Array.from({ length: count }, (_, index) => ({ index, start: index * 30, end: Math.min((index + 1) * 30, samples.length / 16000), duration_ms: 0, attempts: 0, cached: true, status: 'ok' }))
      options.onStats?.(stats)
      log.info(`复用完整语音转写缓存：${count} 段`)
      return { ...whole.result, ...meta }
    }
    log.info(`正在本地转写语音（Whisper ${config.model}，${runtime.runtime} / ${runtime.backend}，${concurrency} 并发，${count} 段）`)
    const session = runtime.runtime === 'native' ? new NativeWhisperSession(runtime, model, signal, (config.chunk_timeout ?? 300) * 1000) : null
    const results: VideoTranscript['segments'][] = new Array(count)
    let next = 0, completed = 0
    let failure: unknown
    const consume = async () => {
      while (next < count && !failure) {
        if (signal?.aborted) { failure = new CatbusError('ERROR', '语音转写已取消'); break }
        const index = next++, offset = index * chunkLength, end = Math.min(offset + chunkLength, samples.length)
        const file = join(dir, 'chunks', `${String(index).padStart(6, '0')}.json`)
        const record: (typeof stats.chunks)[number] = { index, start: offset / 16000, end: end / 16000, duration_ms: 0, attempts: 0, cached: false, status: 'ok' }
        stats.chunks.push(record)
        const started = performance.now()
        try {
          const saved = await readVideoJson(file)
          if (saved?.fingerprint === fingerprint && saved.offset === offset && saved.end === end && valid(saved.segments, offset, end)) {
            results[index] = saved.segments; record.cached = true; stats.cached_chunks++
            if (saved.backend) { stats.device = saved.backend.device; stats.backend_evidence = saved.backend.evidence }
          } else {
            for (;;) {
              record.attempts++
              try {
                const chunk = new Float32Array(samples.subarray(offset, end))
                const result = session ? await session.transcribe(chunk, language, offset / 16000) : await runVideoProcess<{ text: string; segments: VideoTranscript['segments'] }>(whisperWorker,
                  { model, samples: chunk, language, offsetSeconds: offset / 16000 }, log, signal, (config.chunk_timeout ?? 300) * 1000)
                if (session) { stats.device = session.info.device; stats.backend_evidence = session.info.evidence }
                if (!valid(result.segments, offset, end)) throw new CatbusError('UPSTREAM', '语音转写时间轴无效')
                await writeFileAtomic(file, JSON.stringify({ fingerprint, offset, end, segments: result.segments, backend: session?.info }))
                results[index] = result.segments
                break
              } catch (error) {
                if (signal?.aborted || record.attempts > (config.max_retries ?? 2) || !(error instanceof CatbusError) || (error.detail as any)?.retryable !== true) throw error
                stats.retries++
                log.info(`重试语音分段 ${index + 1}/${count}（第 ${record.attempts} 次重试）`)
              }
            }
          }
          completed++
          log.info(`语音分段已完成 ${completed}/${count}：${record.start.toFixed(1)}–${record.end.toFixed(1)} 秒${record.cached ? '（缓存）' : ''}`)
        } catch (error) { record.status = 'error'; failure ??= error } finally {
          record.duration_ms = Math.round(performance.now() - started)
          options.onStats?.(stats)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, consume))
      if (failure) throw failure
      const segments = results.flat()
      const result: VideoTranscript = { text: segments.map(s => s.text).join(' ').trim(), segments, language, engine: 'local', model: config.model, ...meta }
      const backend = session?.info.evidence.length ? session.info : stats.backend_evidence ? { device: stats.device, evidence: stats.backend_evidence } : undefined
      await writeFileAtomic(join(dir, 'transcript.json'), JSON.stringify({ fingerprint, result, backend }))
      return result
    } finally { session?.close(); stats.chunks.sort((a, b) => a.index - b.index); options.onStats?.(stats) }
  }
  const samples = wavSamples(await readFile(audio))
  const chunkLength = 600 * 16000
  const fingerprint = videoKey({ version: 2, audio: await fileSha256(audio), model: config.model, url: config.base_url, language, engine: 'api' })
  const dir = join(options.cacheDir ?? join(dirname(audio), 'transcripts'), fingerprint)
  if (refresh) await rm(dir, { recursive: true, force: true })
  const stats: NonNullable<VideoTimings['transcription']> = { chunks: [], concurrency: 1, cached_chunks: 0, retries: 0 }
  options.onStats?.(stats)
  const segments: VideoTranscript['segments'] = []
  for (let offset = 0; offset < samples.length; offset += chunkLength) {
    if (signal?.aborted) throw new CatbusError('ERROR', '语音转写已取消')
    const chunk = samples.subarray(offset, offset + chunkLength)
    const end = offset + chunk.length
    const file = join(dir, 'chunks', `${String(offset / chunkLength).padStart(6, '0')}.json`)
    const record: (typeof stats.chunks)[number] = { index: offset / chunkLength, start: offset / 16000, end: end / 16000, duration_ms: 0, attempts: 0, cached: false, status: 'ok' }
    stats.chunks.push(record)
    const started = performance.now()
    try {
      const saved = await readVideoJson(file)
      if (saved?.fingerprint === fingerprint && saved.offset === offset && saved.end === end && typeof saved.text === 'string') {
        if (saved.text) segments.push({ start: offset / 16000, end: end / 16000, text: saved.text })
        record.cached = true; stats.cached_chunks++
        continue
      }
      const parts = [
        { name: 'model', data: config.model },
        { name: 'response_format', data: 'json' },
        { name: 'file', data: wavChunk(chunk), filename: 'audio.wav', contentType: 'audio/wav' },
        ...(language === 'auto' ? [] : [{ name: 'language', data: language }]),
      ]
      record.attempts++
      const body = await modelJson(http, config.base_url!, config.api_key!, '/audio/transcriptions', { url: '', multipart: parts }, settings.timeout)
      if (typeof body.text !== 'string') throw new CatbusError('UPSTREAM', '转写接口没有返回 text，未生成总结')
      if (body.text.trim()) segments.push({ start: offset / 16000, end: (offset + chunk.length) / 16000, text: body.text.trim() })
      await writeFileAtomic(file, JSON.stringify({ fingerprint, offset, end, text: body.text.trim() }))
    } catch (error) { record.status = 'error'; throw error } finally {
      record.duration_ms = Math.round(performance.now() - started); options.onStats?.(stats)
    }
  }
  return { text: segments.map((s) => s.text).join('\n'), language, segments, engine: 'api', model: config.model }
}

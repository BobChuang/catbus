import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { CatbusError } from './errors.js'
import type { HeaderInit, HttpClient } from './http.js'
import type { HandlerContext } from './registry.js'
import type { File, Media } from './schemas.js'

/** `item download` 与发布时的本地文件（AGENTS 4.9「下载」「发布」）。 */

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
}

const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]))
Object.assign(TYPE_BY_EXT, { jpeg: 'image/jpeg', m4s: 'video/mp4', flv: 'video/x-flv', mkv: 'video/x-matroska' })

function extFromUrl(url: string): string | null {
  try {
    const ext = extname(new URL(url).pathname).slice(1).toLowerCase()
    return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null
  } catch {
    return null
  }
}

export function contentTypeOf(name: string): string {
  return TYPE_BY_EXT[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

export interface DownloadOptions {
  headers?: HeaderInit
  /** 内容提取的内存边界：在下载过程中限制大小，而不是下载完才拒绝。 */
  maxBytes?: number
  /** 指定扩展名，例如 B 站 DASH 的音视频分轨。 */
  ext?: (media: Media, index: number) => string | undefined
}

/**
 * 把一组媒体下载到 `--dir`，文件名 `<platform>_<id>_<序号>.<ext>`；已有文件默认跳过，`--overwrite` 时覆盖。
 */
export async function downloadMedia(ctx: HandlerContext, http: HttpClient, itemId: string, media: Media[], options: DownloadOptions = {}): Promise<File[]> {
  const dir = resolve((ctx.options.dir as string | undefined) ?? '.')
  const overwrite = Boolean(ctx.options.overwrite)
  const tooLarge = () => new CatbusError('UNSUPPORTED', `下载文件超过此命令允许的大小（${options.maxBytes! >= 1024 * 1024 ? `${options.maxBytes! / 1024 / 1024} MiB` : `${options.maxBytes} 字节`}）`)
  await mkdir(dir, { recursive: true })
  const files: File[] = []
  for (const [i, m] of media.entries()) {
    if (!m.url) {
      ctx.log.warn(`第 ${i + 1} 个媒体没有可下载的地址，跳过`)
      continue
    }
    const ext = options.ext?.(m, i) ?? extFromUrl(m.url) ?? (m.type === 'image' ? 'jpg' : m.type === 'audio' ? 'm4a' : 'mp4')
    const path = join(dir, `${ctx.platform.id}_${itemId}_${i + 1}.${ext}`)
    const existing = await stat(path).catch(() => null)
    if (existing && !overwrite) {
      if (options.maxBytes && existing.size > options.maxBytes) throw tooLarge()
      ctx.log.info(`已存在，跳过：${path}`)
      files.push({ path, type: m.type, url: m.url, size: existing.size })
      continue
    }
    ctx.log.info(`下载 ${i + 1}/${media.length}：${basename(path)}`)
    const res = await http.request({ url: m.url, headers: options.headers })
    if (!res.ok) throw new CatbusError('UPSTREAM', `下载失败：HTTP ${res.status}`, { detail: { status: res.status, url: m.url } })
    if (options.maxBytes && Number(res.headers.get('content-length')) > options.maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw tooLarge()
    }
    const tmp = `${path}.part`
    try {
      let size = 0
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (options.maxBytes && size > options.maxBytes) return callback(tooLarge())
        callback(null, chunk)
      } })
      const input = res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream) : Readable.from([Buffer.from(await res.arrayBuffer())])
      await pipeline(input, limit, createWriteStream(tmp))
      await rename(tmp, path)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    files.push({ path, type: m.type, url: m.url, size: (await stat(path)).size })
  }
  return files
}

export interface LocalMedia {
  data: Uint8Array
  filename: string
  contentType: string
}

/** 发布时的 `--image` / `--video` / `--cover`：本地路径直接读，URL 先下载。 */
export async function readMedia(http: HttpClient, input: string, headers?: HeaderInit): Promise<LocalMedia> {
  if (/^https?:\/\//i.test(input)) {
    const res = await http.request({ url: input, headers, cookies: false })
    if (!res.ok) throw new CatbusError('USAGE', `下载失败：HTTP ${res.status} ${input}`)
    const filename = basename(new URL(input).pathname) || 'file'
    return { data: new Uint8Array(await res.arrayBuffer()), filename, contentType: res.headers.get('content-type')?.split(';')[0] ?? contentTypeOf(filename) }
  }
  const data = await readFile(input).catch(() => {
    throw new CatbusError('USAGE', `读取文件失败：${input}`)
  })
  return { data: new Uint8Array(data), filename: basename(input), contentType: contentTypeOf(input) }
}

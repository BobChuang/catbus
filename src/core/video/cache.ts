import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { resolve, sep, join } from 'node:path'
import { CatbusError } from '../errors.js'
import { ensureDir } from '../fsutil.js'

export const videoKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
export async function readVideoJson(file: string): Promise<any> { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null } }
export async function hashVideoFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function lockedVideo<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await ensureDir(dir)
  const file = join(dir, '.lock')
  let handle
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(file, 'wx', 0o600); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number(await readFile(file, 'utf8').catch(() => ''))
      let live = true
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0) } catch (e) { live = (e as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      if (live) throw new CatbusError('USAGE', '另一个进程正在处理同一段视频，请等它完成后重试')
      await rm(file, { force: true })
    }
  }
  if (!handle) throw new CatbusError('ERROR', '无法获取视频处理锁')
  try { await handle.writeFile(String(process.pid)); return await run() } finally { await handle.close(); await rm(file, { force: true }) }
}

export async function validArtifacts(root: string, files: any): Promise<boolean> {
  if (!Array.isArray(files) || !files.length) return false
  return (await Promise.all(files.map(async f => {
    if (typeof f?.path !== 'string' || !Number.isSafeInteger(f.size) || f.size <= 0 || !resolve(f.path).startsWith(resolve(root) + sep)) return false
    const info = await stat(f.path).catch(() => null)
    return !!info?.isFile() && info.size === f.size && typeof f.sha256 === 'string' && await hashVideoFile(f.path) === f.sha256
  }))).every(Boolean)
}

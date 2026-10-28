import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { CatbusError } from '../errors.js'
import { PACKAGE_ROOT } from '../paths.js'
import type { Logger } from '../log.js'
import { wavSamples } from './workers.js'

/** Whisper 的 pthread 运行在独立 Node 主线程内，避免嵌套 Worker 的原子等待。 */
export async function runVideoProcess<T>(fn: () => unknown, data: Record<string, unknown>, log: Logger, signal?: AbortSignal, timeoutMs = 300_000): Promise<T> {
  if (signal?.aborted) throw new CatbusError('ERROR', '视频分析已取消')
  const packageJson = join(PACKAGE_ROOT, 'package.json')
  const code = `import('node:module').then(({createRequire})=>{const require=createRequire(${JSON.stringify(packageJson)});const wavSamples=(${wavSamples.toString()});let started=false;process.on('message',data=>{if(started)return;started=true;globalThis.__catbusVideoData=data;return (${fn.toString()})();});process.send({type:'ready'});})`
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true })
  child.stdout?.resume();child.stderr?.resume()
  return new Promise<T>((resolve, reject) => {
    let complete = false, error: Error | null = null, result: T
    const stop = (failure: Error | null) => { if (complete) return; complete = true; error = failure; child.kill('SIGKILL') }
    const cancel = () => stop(new CatbusError('ERROR', '视频分析已取消'))
    const timer = setTimeout(() => stop(new CatbusError('ERROR', `本地语音分段超过 ${timeoutMs / 1000} 秒未完成`, { detail: { retryable: true } })), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    child.on('message', (message: any) => {
      if (complete) return
      if (message.type === 'ready') child.send({ ...data, packageJson }, (failure) => { if (failure) stop(new CatbusError('ERROR', '无法向语音转写进程传递音轨', { detail: { retryable: true } })) })
      else if (message.type === 'result') { result = message.result; stop(null) }
      else if (message.type === 'error') stop(new CatbusError('ERROR', message.message, { detail: { retryable: message.retryable === true } }))
      else if (message.type === 'progress') log.info(message.message)
    })
    child.once('error', () => stop(new CatbusError('ERROR', '无法启动本地语音转写进程')))
    child.once('close', () => {
      clearTimeout(timer);signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else if (complete) resolve(result!)
      else reject(new CatbusError('ERROR', '本地语音转写进程提前结束', { detail: { retryable: true } }))
    })
  })
}

export async function runVideoWorker<T>(fn: () => unknown, data: Record<string, unknown>, log: Logger, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new CatbusError('ERROR', '视频分析已取消')
  const packageJson = join(PACKAGE_ROOT, 'package.json')
  const code = `import('node:module').then(({createRequire}) => { const require = createRequire(${JSON.stringify(packageJson)}); const wavSamples = (${wavSamples.toString()}); return (${fn.toString()})(); })`
  const worker = new Worker(code, { eval: true, execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    workerData: { ...data, packageJson }, stdout: true, stderr: true })
  // 第三方 WASM 的 printf 不得污染 stdout，也不把转写原文混入进度日志。
  worker.stdout?.resume()
  worker.stderr?.resume()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, result?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      // 释放当前线程及其 WASM/pthread 状态后，才开始下一段，避免长音轨复用时停滞。
      void worker.terminate().then(() => error ? reject(error) : resolve(result!), () => reject(error ?? new CatbusError('ERROR', '视频处理线程无法结束')))
    }
    const cancel = () => finish(new CatbusError('ERROR', '视频分析已取消'))
    const timedOut = () => finish(new CatbusError('ERROR', '本地视频处理连续 30 分钟没有进度，请稍后重试'))
    let timer = setTimeout(timedOut, 30 * 60_000)
    const progress = () => { clearTimeout(timer); timer = setTimeout(timedOut, 30 * 60_000) }
    signal?.addEventListener('abort', cancel, { once: true })
    worker.on('message', (message) => {
      if (message.type === 'progress') { progress(); log.info(message.message) }
      else if (message.type === 'result') finish(null, message.result)
      else if (message.type === 'error') finish(new CatbusError('ERROR', message.message))
    })
    worker.once('error', (error) => {
      log.debug('视频处理线程异常', { message: error.message })
      finish(new CatbusError('ERROR', '本地视频处理线程异常退出'))
    })
    worker.once('exit', () => { if (!settled) finish(new CatbusError('ERROR', '本地视频处理线程提前结束')) })
  })
}

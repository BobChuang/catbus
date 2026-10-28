import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { CatbusError } from '../errors.js'
import { PACKAGE_ROOT } from '../paths.js'
import type { VideoTranscript } from '../schemas.js'
import type { AISettings } from './config.js'

export const NATIVE_WHISPER_VERSION = '1.2.0-rc.1'
export interface LocalRuntime { runtime: 'wasm' | 'native'; backend: 'cpu' | 'metal'; version: string; library?: string }
export interface NativeBackendInfo { device?: string; evidence: string[] }

/** 只解析预编译包路径，不在 CLI 主进程加载原生代码。 */
export function localRuntimes(config: AISettings['transcription']): LocalRuntime[] {
  const wasm: LocalRuntime = { runtime: 'wasm', backend: 'cpu', version: '1.0.3' }
  if (config.runtime === 'wasm') return [wasm]
  let library: string | undefined
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    try { library = createRequire(import.meta.url).resolve('@fugood/node-whisper-darwin-arm64') } catch {}
  }
  if (!library) {
    if (config.runtime === 'native' || config.device === 'metal') throw new CatbusError('UNSUPPORTED', '本机没有可用的预编译原生转写包', { hint: '当前原生加速支持 macOS arm64；可设置 transcription.runtime 为 wasm' })
    return [wasm]
  }
  const native = (backend: 'cpu' | 'metal'): LocalRuntime => ({ runtime: 'native', backend, version: NATIVE_WHISPER_VERSION, library })
  if (config.device === 'cpu') return config.runtime === 'native' ? [native('cpu')] : [native('cpu'), wasm]
  if (config.device === 'metal') return [native('metal')]
  return config.runtime === 'native' ? [native('metal'), native('cpu')] : [native('metal'), native('cpu'), wasm]
}

/** 自包含的 Node 子进程入口；所有原生日志留在子进程，不得污染 stdout。 */
async function nativeProcess() {
  let binding: any, context: any
  let backend: NativeBackendInfo = { evidence: [] }
  process.on('message', async (message: any) => {
    const send = (value: any) => process.send?.({ id: message.id, ...value })
    try {
      if (message.type === 'init') {
        try { binding = require(message.library) } catch { send({ type: 'error', message: '原生转写包无法加载', unavailable: true }); return }
        let logs: string[] = []
        binding.WhisperContext.toggleNativeLog(true, (_level: string, line: string) => {
          if (/GPU name:|whisper_backend_init_gpu: using|whisper_backend_init: using|found device:/i.test(line) && logs.length < 16) logs.push(line.trim().slice(0, 200))
        })
        context = await new binding.WhisperContext({ filePath: message.model, useGpu: message.gpu, useFlashAttn: true })
        // 原生日志通过 ThreadSafeFunction 异步交付，不能在构造返回后立即判定。
        if (message.gpu) {
          const deadline = Date.now() + 1000
          while (!logs.some(line => /whisper_backend_init_gpu: using MTL\d+ backend/.test(line)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        }
        backend = { evidence: logs, device: logs.find(line => /GPU name:/.test(line))?.split('GPU name:')[1]?.trim() }
        if (message.gpu && !logs.some(line => /whisper_backend_init_gpu: using MTL\d+ backend/.test(line))) {
          send({ type: 'error', message: '原生转写没有启用 Metal 后端', unavailable: true }); return
        }
        if (!message.gpu) backend.device = 'CPU / Accelerate'
        send({ type: 'result', result: backend })
      } else if (message.type === 'transcribe') {
        const samples: Float32Array = message.samples
        if (samples.every(value => Math.abs(value) < 1e-5)) { send({ type: 'result', result: { text: '', segments: [] } }); return }
        const pcm = new ArrayBuffer(samples.length * 2), view = new DataView(pcm)
        for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))), true)
        const result = await context.transcribeData(pcm, { language: message.language, maxThreads: 4, temperature: 0 }).promise
        if (result.isAborted) { send({ type: 'error', message: '原生语音转写已取消' }); return }
        if (!Array.isArray(result.segments) || !result.segments.every((s: any) => Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t1 >= s.t0 && typeof s.text === 'string')) throw new Error('原生转写时间轴无效')
        // whisper.cpp 会给最后一个解码窗口补零；原生时间戳可能延伸进补零区域。
        // 只返回真实输入覆盖的时间，不把补零误算成视频长度；不改写识别文字。
        const durationMs = samples.length / 16
        const segments = result.segments.filter((s: any) => s.t0 < durationMs && s.t1 > 0).map((s: any) => ({
          start: message.offsetSeconds + Math.max(0, s.t0) / 1000,
          end: message.offsetSeconds + Math.min(durationMs, s.t1) / 1000,
          text: s.text.trim(),
        }))
        send({ type: 'result', result: { text: segments.map((s: any) => s.text).join(' ').trim(), segments, backend } })
      }
    } catch {
      send({ type: 'error', message: message.type === 'init' ? '原生 Whisper 模型初始化失败' : '原生语音转写失败', retryable: message.type !== 'init' })
    }
  })
  process.send?.({ type: 'boot' })
}

/** 一条视频复用一个模型实例；进程异常后下一次请求会重新初始化。 */
export class NativeWhisperSession {
  info: NativeBackendInfo = { evidence: [] }
  private child: ChildProcess | null = null
  private sequence = 0
  private pending: { id: number; data: any; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null
  constructor(private readonly runtime: LocalRuntime, private readonly model: string, private readonly signal?: AbortSignal, private readonly timeoutMs = 300000) {}

  private fail(error: Error) {
    const pending = this.pending
    this.pending = null
    if (pending) { clearTimeout(pending.timer); this.signal?.removeEventListener('abort', pending.cancel); pending.reject(error) }
    this.child?.kill('SIGKILL'); this.child = null
  }

  private request(data: any, waitForBoot = false): Promise<any> {
    if (this.signal?.aborted) { this.fail(new CatbusError('ERROR', '语音转写已取消')); return Promise.reject(new CatbusError('ERROR', '语音转写已取消')) }
    if (this.pending) return Promise.reject(new CatbusError('ERROR', '原生转写进程不能同时处理多个分段'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const cancel = () => this.fail(new CatbusError('ERROR', '语音转写已取消'))
      const timer = setTimeout(() => this.fail(new CatbusError('ERROR', '原生语音分段处理超时', { detail: { retryable: true } })), this.timeoutMs)
      this.pending = { id, data: { ...data, id }, resolve, reject, timer, cancel }
      this.signal?.addEventListener('abort', cancel, { once: true })
      if (!waitForBoot) this.send()
    })
  }

  private send() {
    try { this.child!.send(this.pending!.data, error => { if (error) this.fail(new CatbusError('ERROR', '原生转写进程通信失败', { detail: { retryable: true } })) }) }
    catch { this.fail(new CatbusError('ERROR', '原生转写进程通信失败', { detail: { retryable: true } })) }
  }

  private async start() {
    const packageJson = join(PACKAGE_ROOT, 'package.json')
    const source = `import('node:module').then(({createRequire})=>{const require=createRequire(${JSON.stringify(packageJson)});return (${nativeProcess.toString()})();})`
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true })
    this.child = child
    child.stdout?.resume(); child.stderr?.resume()
    child.on('message', (message: any) => {
      if (this.child !== child) return
      if (message.type === 'boot') { this.send(); return }
      const pending = this.pending
      if (!pending || pending.id !== message.id) return
      if (message.type === 'error') { this.fail(new CatbusError('ERROR', message.message, { detail: { retryable: message.retryable === true, native_unavailable: message.unavailable === true } })); return }
      if (message.type === 'result') {
        this.pending = null; clearTimeout(pending.timer); this.signal?.removeEventListener('abort', pending.cancel); pending.resolve(message.result)
      }
    })
    child.once('error', () => { if (this.child === child) this.fail(new CatbusError('ERROR', '无法启动原生转写进程', { detail: { native_unavailable: true } })) })
    child.once('close', (_code, signal) => {
      if (this.child === child) {
        const initializing = this.pending?.data.type === 'init'
        const unavailable = initializing && signal !== 'SIGKILL'
        this.fail(new CatbusError('ERROR', '原生转写进程异常结束', { detail: { retryable: !unavailable, native_unavailable: unavailable } }))
      }
    })
    this.info = await this.request({ type: 'init', library: this.runtime.library, model: this.model, gpu: this.runtime.backend === 'metal' }, true)
  }

  async transcribe(samples: Float32Array, language: string, offsetSeconds: number): Promise<{ text: string; segments: VideoTranscript['segments'] }> {
    if (!this.child) await this.start()
    const result = await this.request({ type: 'transcribe', samples, language, offsetSeconds })
    if (result.backend) this.info = result.backend
    return result
  }

  close() { this.fail(new CatbusError('ERROR', '原生转写会话已结束')) }
}

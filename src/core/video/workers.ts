/**
 * 以下函数在隔离的 Node 线程 / 进程内执行，保持自包含；函数转成 JS 源码后执行，
 * 源码测试与编译后的 npm 包使用同一条路径，不依赖 TS loader 或系统可执行文件。
 */
export async function ffmpegWorker() {
  const { parentPort, workerData } = require('node:worker_threads')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createRequire } = require('node:module')
  const { pathToFileURL } = require('node:url')
  const localRequire = createRequire(workerData.packageJson)
  try {
    // @ffmpeg/core 的单线程构建面向 Web Worker；在隔离线程内提供 location，
    // 直接喂入 npm 包内的 wasmBinary，运行中不访问 CDN 或浏览器。
    ;(globalThis as any).self = { location: { href: pathToFileURL(localRequire.resolve('@ffmpeg/core')).href } }
    const core = await localRequire('@ffmpeg/core')({ wasmBinary: fs.readFileSync(localRequire.resolve('@ffmpeg/core/wasm')) })
    core.setLogger(() => {})
    const exec = (...args: string[]) => {
      core.reset()
      const code = core.exec(...args)
      if (code !== 0) throw new Error('FFmpeg 无法处理这段视频，可能是视频损坏或格式不支持')
    }
    core.FS.writeFile('input.mp4', fs.readFileSync(workerData.video))
    // core 0.12.10 的 ffprobe 不更新 ret；以实际生成并成功解析的 JSON 为准。
    core.ffprobe('-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', '-o', 'probe.json', 'input.mp4')
    let probe
    try { probe = JSON.parse(new TextDecoder().decode(core.FS.readFile('probe.json'))) } catch { throw new Error('无法读取视频时长和音轨') }
    const duration = Number(probe.format?.duration ?? probe.streams?.find((s: any) => s.codec_type === 'video')?.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频没有有效时长')
    const seconds = Math.min(duration, workerData.maxSeconds ?? duration)
    const save = (name: string) => {
      const dest = path.join(workerData.dir, name)
      fs.writeFileSync(dest + '.part', core.FS.readFile(name), { mode: 0o600 })
      fs.renameSync(dest + '.part', dest)
      core.FS.unlink(name)
      return dest
    }
    const hasAudio = probe.streams?.some((s: any) => s.codec_type === 'audio')
    const count = Math.max(1, Math.min(workerData.maxFrames, Math.ceil(seconds)))
    if (hasAudio) {
      parentPort.postMessage({ type: 'progress', message: '正在提取视频音轨' })
      exec('-threads', '1', '-i', 'input.mp4', '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'audio.wav')
    }
    const audio = hasAudio ? save('audio.wav') : null
    const frames = []
    for (let i = 0; i < count; i++) {
      const timestamp = i * seconds / count
      // core 0.12.10 的 MJPEG 编码器在部分真实 1080p 画面缩放到 960 宽时
      // 内存越界；用无损 PNG，保留屏幕文字，也避免依赖系统图片编码器。
      const name = `frame_${String(i + 1).padStart(3, '0')}.png`
      parentPort.postMessage({ type: 'progress', message: `正在提取画面 ${i + 1}/${count}` })
      exec('-threads', '1', '-ss', String(timestamp), '-i', 'input.mp4', '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", '-c:v', 'png', '-threads', '1', name)
      frames.push({ timestamp, path: save(name) })
    }
    parentPort.postMessage({ type: 'result', result: { duration, processed_duration: seconds, truncated: seconds + 0.05 < duration, audio_path: audio, frames } })
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : '视频提取失败' })
  }
}

/** RIFF PCM16 单声道 WAV → 16 kHz float32；不假设 WAV 头总是 44 字节。 */
export function wavSamples(buffer: Uint8Array): Float32Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const ascii = (at: number, n: number) => String.fromCharCode(...buffer.subarray(at, at + n))
  if (buffer.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('无效的 WAV 音轨')
  let valid = false
  for (let at = 12; at + 8 <= buffer.length;) {
    const name = ascii(at, 4)
    const size = view.getUint32(at + 4, true)
    const start = at + 8
    if (start + size > buffer.length) throw new Error('WAV 音轨不完整')
    if (name === 'fmt ') valid = size >= 16 && view.getUint16(start, true) === 1 && view.getUint16(start + 2, true) === 1 && view.getUint32(start + 4, true) === 16000 && view.getUint16(start + 14, true) === 16
    if (name === 'data') {
      if (!valid || size % 2) throw new Error('音轨必须是 16 kHz 单声道 PCM16 WAV')
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(start + i * 2, true) / 32768
      return samples
    }
    at = start + size + size % 2
  }
  throw new Error('WAV 没有音频数据')
}

export async function whisperWorker() {
  const threads = require('node:worker_threads')
  const parentPort = threads.parentPort ?? { postMessage: (message: unknown) => process.send?.(message as any) }
  const workerData = threads.workerData ?? (globalThis as any).__catbusVideoData
  const { readFileSync } = require('node:fs')
  const { createRequire } = require('node:module')
  const localRequire = createRequire(workerData.packageJson)
  try {
    const segments: { start: number; end: number; text: string }[] = []
    const offsetSeconds = workerData.offsetSeconds ?? 0
    const failures: string[] = []
    const time = (value: string) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
    // 旧版 WASM 的多线程推理会在部分音频段死锁；只在隔离进程中
    // 向 std::hardware_concurrency 暴露一个核心，避免依赖 pthread 调度。
    const os = localRequire('node:os')
    const cpu = os.cpus()[0]
    os.cpus = () => cpu ? [cpu] : [{}]
    const model = await localRequire('whisper.cpp')({
      print: (line: string) => {
        const match = /\[(\d\d:\d\d:\d\d\.\d+)\s*-->\s*(\d\d:\d\d:\d\d\.\d+)\]\s*(.*)/.exec(line)
        if (match) {
          segments.push({ start: offsetSeconds + time(match[1]!), end: offsetSeconds + time(match[2]!), text: match[3]!.trim() })
        }
      },
      printErr: (line: string) => {
        // 解码器会降低采样约束后重试；这条调试信息并非整段推理失败。
        const recovered = /failed to decode with temperature\s*=|failed to generate timestamp token - using fallback strategy/i.test(line)
        if (/failed|error|unknown language/i.test(line) && !recovered) failures.push(line.slice(0, 200))
      },
    })
    model.FS_createDataFile('/', 'model.bin', readFileSync(workerData.model), true, true)
    if (!model.init('model.bin')) throw new Error('无法加载 Whisper 模型，请使用兼容的 ggml base / tiny 模型')
    // wavSamples 会作为同一个 worker 脚本的前置函数注入，不依赖外部模块。
    const samples = workerData.samples ?? wavSamples(readFileSync(workerData.audio))
    const code = model.full_default(samples, workerData.language, false)
    if (code !== 0 || failures.length) {
      parentPort.postMessage({ type: 'error', message: `Whisper 语音转写失败${failures.length ? `：${failures[0]}` : ''}`, retryable: true })
      return
    }
    parentPort.postMessage({ type: 'result', result: { text: segments.map((s) => s.text).join(' ').trim(), segments } })
    // 父进程收到结果后统一终止本进程；不要在 IPC 刷新前同步清理 pthread。
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : '语音转写失败' })
  }
}

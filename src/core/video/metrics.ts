import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { writeFileAtomic } from '../fsutil.js'
import type { Logger } from '../log.js'
import type { VideoTimings } from '../schemas.js'

const labels: Record<string, string> = { resolve: '解析视频', download: '下载', extract: '提取音轨和画面', transcribe: '语音转写', summarize: '模型总结', save: '保存结果' }

/** 每次调用独立计时；业务缓存中不保存本次计时，失败也能留下诊断记录。 */
export class VideoRun {
  private readonly start = performance.now()
  readonly report: VideoTimings = { run_id: randomUUID(), started_at: new Date().toISOString(), duration_ms: 0, status: 'ok', stages: [] }
  constructor(private readonly log: Logger) {}

  async stage<T>(name: string, work: (entry: VideoTimings['stages'][number]) => Promise<T>): Promise<T> {
    const start = performance.now()
    const firstChild = this.report.stages.length + 1
    const entry: VideoTimings['stages'][number] = { name, duration_ms: 0, cache_hit: false, status: 'ok' }
    this.report.stages.push(entry)
    try { return await work(entry) } catch (error) { entry.status = 'error'; throw error } finally {
      entry.duration_ms = Math.max(0, Math.round(performance.now() - start) - this.report.stages.slice(firstChild).reduce((sum, s) => sum + s.duration_ms, 0))
      this.log.info(`${labels[name] ?? name}阶段：${(entry.duration_ms / 1000).toFixed(2)} 秒${entry.cache_hit ? '（缓存命中）' : ''}${entry.status === 'error' ? '（失败）' : ''}`)
    }
  }

  async finish(root: string, ok: boolean): Promise<string> {
    this.report.duration_ms = Math.round(performance.now() - this.start)
    this.report.status = ok ? 'ok' : 'error'
    const file = join(root, 'runs', `${this.report.run_id}.json`)
    await writeFileAtomic(file, JSON.stringify(this.report, null, 2) + '\n')
    this.log.info(`阶段计时：${file}`)
    return file
  }
}

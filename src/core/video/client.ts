import { CatbusError } from '../errors.js'
import { HttpClient, type HttpRequest } from '../http.js'
import type { VideoSummaryMetrics } from '../schemas.js'

/** 模型鉴权与平台 Cookie 完全隔离；重定向不携带密钥继续跳转，也不自动重试收费调用。 */
export async function modelJson(http: HttpClient, baseUrl: string, apiKey: string, path: string, request: HttpRequest, timeout: number): Promise<any> {
  const response = await modelResponse(http, baseUrl, apiKey, path, request, timeout)
  try { return await response.json() } catch { throw new CatbusError('UPSTREAM', '模型接口未返回有效 JSON') }
}

async function modelResponse(http: HttpClient, baseUrl: string, apiKey: string, path: string, request: HttpRequest, timeout: number) {
  const supplied = Array.isArray(request.headers) ? request.headers : Object.entries(request.headers ?? {})
  const headers: [string, string][] = supplied.filter(([name, value]) => value != null && !/^(cookie|authorization|proxy-authorization)$/i.test(name)).map(([name, value]) => [name, String(value)])
  headers.push(['authorization', `Bearer ${apiKey}`])
  const response = await http.request({ ...request, method: 'POST', url: baseUrl + path, cookies: false, redirect: 'manual', timeout,
    headers })
  if (!response.ok) throw new CatbusError('UPSTREAM', `模型接口请求失败（HTTP ${response.status}）`, {
    hint: '检查模型配置、服务可用渠道和额度；本次不会自动切换模型或服务', detail: { status: response.status, api: path },
  })
  return response
}

function usageOf(value: any): VideoSummaryMetrics['usage'] {
  if (!value || typeof value !== 'object') return undefined
  const raw = { prompt_tokens: value.prompt_tokens ?? value.input_tokens, completion_tokens: value.completion_tokens ?? value.output_tokens, total_tokens: value.total_tokens,
    cached_tokens: value.prompt_tokens_details?.cached_tokens, reasoning_tokens: value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens }
  return Object.fromEntries(Object.entries(raw).filter(([, n]) => Number.isSafeInteger(n) && n >= 0))
}

/** 只在内存收集完整响应；流式是计时与反馈手段，stdout 仍由 CLI 输出完整 JSON。 */
export async function modelChat(http: HttpClient, baseUrl: string, apiKey: string, payload: Record<string, unknown>, timeout: number,
  signal?: AbortSignal, onFirstToken?: () => void, metricsTarget?: Partial<VideoSummaryMetrics>): Promise<{ text: string; metrics: Partial<VideoSummaryMetrics> }> {
  const started = performance.now(), deadline = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const timer = setTimeout(() => deadline.abort(), timeout * 1000)
  let abortRequest!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abortRequest = () => reject(new CatbusError('ERROR', '视频总结已取消或超时'))
    activeSignal.addEventListener('abort', abortRequest, { once: true })
  })
  const wait = <T>(work: Promise<T>) => Promise.race([work, aborted])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const metrics: Partial<VideoSummaryMetrics> = metricsTarget ?? {}
  Object.assign(metrics, { first_event_ms: null, first_token_ms: null, generation_ms: null })
  let text = '', finish: string | null = null
  const noteText = (value: unknown) => {
    if (typeof value !== 'string' || !value) return
    if (metrics.first_token_ms === null && /\S/.test(value)) { metrics.first_token_ms = Math.round(performance.now() - started); onFirstToken?.() }
    text += value
  }
  try {
    if (activeSignal.aborted) throw new CatbusError('ERROR', '视频总结已取消')
    const response = await wait(modelResponse(http, baseUrl, apiKey, '/chat/completions', { url: '', json: payload, signal: activeSignal }, timeout))
    metrics.headers_ms = Math.round(performance.now() - started)
    if (!/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
      let body: any
      try { body = await wait(response.json()) } catch { throw new CatbusError('UPSTREAM', '模型接口未返回有效 JSON') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CatbusError('UPSTREAM', '模型接口未返回有效 JSON 对象')
      metrics.streamed = false
      if (typeof body.model === 'string') metrics.response_model = body.model
      metrics.first_event_ms = Math.round(performance.now() - started)
      const content = body.choices?.[0]?.message?.content
      text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n') : ''
      finish = body.choices?.[0]?.finish_reason ?? 'stop'
      metrics.usage = usageOf(body.usage)
    } else {
      metrics.streamed = true
      if (!response.body) throw new CatbusError('UPSTREAM', '模型流响应没有正文')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', data: string[] = [], done = false
      const dispatch = () => {
        if (!data.length) return
        const value = data.join('\n').trim(); data = []
        if (value === '[DONE]') { done = true; return }
        let event: any
        try { event = JSON.parse(value) } catch { throw new CatbusError('UPSTREAM', '模型流包含无效 JSON，未保存结果') }
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new CatbusError('UPSTREAM', '模型流包含无效 JSON 对象，未保存结果')
        if (event.error) throw new CatbusError('UPSTREAM', '模型流返回错误，未保存结果')
        if (typeof event.model === 'string') metrics.response_model = event.model
        metrics.first_event_ms ??= Math.round(performance.now() - started)
        if (event.usage) metrics.usage = usageOf(event.usage)
        const choice = event.choices?.[0]
        noteText(choice?.delta?.content)
        if (choice?.finish_reason) finish = choice.finish_reason
      }
      const line = (value: string) => {
        if (!value) dispatch()
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
      }
      const aborted = () => { void reader?.cancel().catch(() => {}) }
      activeSignal.addEventListener('abort', aborted, { once: true })
      try {
        for (;;) {
          if (activeSignal.aborted) throw new CatbusError('ERROR', '视频总结已取消或超时')
          const result = await wait(reader.read())
          if (result.done) break
          buffer += decoder.decode(result.value, { stream: true })
          let at: number
          while ((at = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, at).replace(/\r$/, '')); buffer = buffer.slice(at + 1) }
          if (done) break
        }
        buffer += decoder.decode()
        if (buffer) line(buffer.replace(/\r$/, ''))
        dispatch()
      } finally { activeSignal.removeEventListener('abort', aborted) }
      if (activeSignal.aborted) throw new CatbusError('ERROR', '视频总结已取消或超时')
      if (!finish) throw new CatbusError('UPSTREAM', '模型流提前断开，未收到完成标记，未保存结果')
    }
    if (finish === 'length') throw new CatbusError('UPSTREAM', '总结因模型输出长度限制被截断，未保存为成功结果', { hint: '提高模型配置的 max_output_tokens，或选择更精简的 summary.style' })
    if (finish !== 'stop') throw new CatbusError('UPSTREAM', '模型没有正常完成文字总结，未保存结果')
    if (!text.trim()) throw new CatbusError('UPSTREAM', '总结模型未返回非空文本，未保存为成功结果')
    metrics.finish_reason = finish
    metrics.request_total_ms = Math.round(performance.now() - started)
    metrics.generation_ms = metrics.first_token_ms == null ? null : metrics.request_total_ms - metrics.first_token_ms
    metrics.output_chars = text.trim().length
    return { text: text.trim(), metrics }
  } catch (error) {
    if (activeSignal.aborted) throw new CatbusError('ERROR', signal?.aborted ? '视频总结已取消' : '视频总结超时，未保存部分结果')
    throw error
  } finally {
    metrics.request_total_ms ??= Math.round(performance.now() - started)
    metrics.output_chars ??= text.trim().length
    metrics.finish_reason = finish
    clearTimeout(timer)
    activeSignal.removeEventListener('abort', abortRequest)
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}

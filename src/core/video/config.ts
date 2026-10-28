import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { CatbusError } from '../errors.js'
import { catbusHome } from '../paths.js'

const Transcription = z.object({
  engine: z.enum(['local', 'api']).default('local'),
  runtime: z.enum(['auto', 'wasm', 'native']).optional(),
  device: z.enum(['auto', 'cpu', 'metal']).optional(),
  model: z.string().default('base'),
  model_path: z.string().optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  max_retries: z.number().int().min(0).max(3).optional(),
  chunk_timeout: z.number().min(30).max(1800).optional(),
})
const Settings = z.object({
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  timeout: z.number().positive().max(3600).default(180),
  max_output_tokens: z.number().int().min(256).max(64000).default(8192),
  summary: z.object({
    style: z.enum(['standard', 'detailed']).optional(),
    reasoning_effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    image_format: z.enum(['webp', 'png']).optional(),
    stream: z.boolean().optional(),
  }).optional(),
  transcription: Transcription.default({ engine: 'local', model: 'base' }),
})
export type AISettings = z.infer<typeof Settings>
export type AnalysisOptions = {
  aiConfig?: string
  model?: string
  dir?: string
  maxFrames?: number
  maxSeconds?: number
  language?: 'zh' | 'en' | 'auto'
  refresh?: boolean
}

/** 只解析模型设置；不执行 .env，不导入登录态，也不改变原项目。 */
export function parseModelConfig(text: string): Record<string, unknown> {
  if (text.trimStart().startsWith('{')) {
    const json = JSON.parse(text)
    if (json.clients) {
      const client = json.clients[json.clients.default ?? 'openai_api']
      if (!client?.api_url) throw new Error('原项目配置不是兼容模型接口，请提供 base_url、api_key、model')
      return { base_url: client.api_url, api_key: client.api_key, model: client.model }
    }
    return json
  }
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(MODEL_URL|MODEL_API_KEY|MODEL)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return { base_url: values.MODEL_URL, api_key: values.MODEL_API_KEY, model: values.MODEL }
}

function baseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  let url: URL
  try { url = new URL(value) } catch { throw new CatbusError('USAGE', '模型 base_url 必须是完整的 HTTP(S) 地址') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CatbusError('USAGE', '模型 base_url 必须是无用户名、密码、查询参数和片段的 HTTP(S) 地址')
  }
  return url.href.replace(/\/+$/, '')
}

export async function loadAISettings(options: AnalysisOptions, requireModel = false): Promise<AISettings> {
  const explicit = options.aiConfig ?? process.env.CATBUS_AI_CONFIG
  const file = resolve(explicit ?? join(catbusHome(), 'ai.json'))
  let raw: Record<string, unknown> = {}
  try { raw = parseModelConfig(await readFile(file, 'utf8')) } catch (error) {
    if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // JSON 解析错误可能包含密钥附近的原文，不转发原始异常。
      throw new CatbusError('USAGE', '模型配置文件无法读取或格式错误', { hint: `检查模型配置文件：${file}` })
    }
  }
  const parsed = Settings.safeParse({
    ...raw,
    base_url: process.env.CATBUS_AI_BASE_URL ?? raw.base_url,
    api_key: process.env.CATBUS_AI_API_KEY ?? raw.api_key,
    model: options.model ?? process.env.CATBUS_AI_MODEL ?? raw.model,
  })
  if (!parsed.success) throw new CatbusError('USAGE', '模型配置的字段或取值不正确', { hint: '检查 base_url、model、timeout 和 transcription；用法见 docs/guide/video-analysis.md' })
  const settings = parsed.data
  if (settings.transcription.engine === 'local' && settings.transcription.runtime === 'wasm' && settings.transcription.device === 'metal') throw new CatbusError('USAGE', 'WASM 后端不能使用 Metal；请使用 auto 或 native 运行时')
  settings.base_url = baseUrl(settings.base_url)
  settings.transcription.base_url = baseUrl(settings.transcription.base_url)
  if (settings.transcription.model_path && !isAbsolute(settings.transcription.model_path)) settings.transcription.model_path = resolve(file, '..', settings.transcription.model_path)
  if (settings.transcription.engine === 'local' && !settings.transcription.model_path && !['tiny', 'base'].includes(settings.transcription.model)) {
    throw new CatbusError('USAGE', '本地 Whisper 支持 base、tiny，或用 model_path 指定兼容的 ggml 模型')
  }
  if (settings.transcription.engine === 'api' && (!settings.transcription.base_url || !settings.transcription.api_key || !settings.transcription.model)) {
    throw new CatbusError('USAGE', '转写接口需要独立的 base_url、api_key 和 model 配置')
  }
  if (requireModel && (!settings.base_url || !settings.api_key || !settings.model)) {
    throw new CatbusError('USAGE', '总结需要配置模型地址、密钥和模型名', { hint: '设置 ~/.catbus/ai.json，或用 --ai-config 指定模型配置文件；也支持 CATBUS_AI_BASE_URL、CATBUS_AI_API_KEY、CATBUS_AI_MODEL' })
  }
  return settings
}

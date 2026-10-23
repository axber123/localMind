import { AppError } from '../db/database'
import type { LlmSettings } from '../../shared/types'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmCallOptions {
  messages: LlmMessage[]
  settings: LlmSettings
  apiKey: string | null
  signal: AbortSignal
  onDelta?: (delta: string) => void
  maxTokens?: number
}

export interface LlmResult {
  content: string
  finishReason: string | null
}

export function endpointFor(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new AppError('LLM_INVALID_URL', 'API Base URL 格式无效。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('LLM_INVALID_URL', 'API Base URL 只支持 http 或 https。')
  }
  if (url.username || url.password) {
    throw new AppError('LLM_INVALID_URL', 'API Base URL 不能包含用户名或密码。')
  }
  const clean = url.toString().replace(/\/+$/, '')
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`
}

export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

export function isLoopbackHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function mapHttpError(status: number, detail: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError('LLM_AUTH_FAILED', '模型服务认证失败，请检查 API Key 或权限。', detail)
  }
  if (status === 429) {
    return new AppError('LLM_RATE_LIMITED', '模型服务限流或额度不足，请稍后再试。', detail)
  }
  if (status >= 500) {
    return new AppError('LLM_SERVER_ERROR', '模型服务暂时不可用，请稍后重试。', detail)
  }
  return new AppError('LLM_REQUEST_FAILED', `模型服务返回错误（HTTP ${status}）。`, detail)
}

function safeDetail(text: string): string {
  return text.replace(/(sk-|Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***').slice(0, 500)
}

export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: string[] = []
  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data) events.push(data)
  }
  return { events, rest }
}

export async function callLlm(options: LlmCallOptions): Promise<LlmResult> {
  const { settings, apiKey, signal, onDelta } = options
  const endpoint = endpointFor(settings.baseUrl)
  if (!apiKey && !isLoopbackHost(settings.baseUrl)) {
    throw new AppError('LLM_NO_KEY', '尚未配置 API Key，请先在设置中保存密钥。')
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), settings.timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: settings.model,
        messages: options.messages,
        temperature: settings.temperature,
        stream: settings.stream,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(response.status, safeDetail(text))
    }
    if (!settings.stream) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      }
      const content = data.choices?.[0]?.message?.content ?? ''
      if (!content) throw new AppError('LLM_EMPTY_RESPONSE', '模型返回了空回答，请重试。')
      return { content, finishReason: data.choices?.[0]?.finish_reason ?? null }
    }
    if (!response.body) throw new AppError('LLM_EMPTY_RESPONSE', '模型服务没有返回流式内容。')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let finishReason: string | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseEvents(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (event === '[DONE]') continue
        let payload: {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
          error?: { message?: string }
        }
        try {
          payload = JSON.parse(event) as typeof payload
        } catch {
          continue
        }
        if (payload.error?.message) {
          throw new AppError('LLM_STREAM_ERROR', '模型服务在生成过程中返回错误。', safeDetail(payload.error.message))
        }
        const delta = payload.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          content += delta
          onDelta?.(delta)
        }
        const reason = payload.choices?.[0]?.finish_reason
        if (reason) finishReason = reason
      }
    }
    if (!content.trim()) throw new AppError('LLM_EMPTY_RESPONSE', '模型没有返回内容，请检查模型名称或稍后重试。')
    return { content, finishReason }
  } catch (error) {
    if (error instanceof AppError) throw error
    if (signal.aborted) throw new AppError('LLM_ABORTED', '生成已停止。')
    if (controller.signal.aborted) throw new AppError('LLM_TIMEOUT', '模型请求超时，请检查网络或增大超时时间。')
    if (error instanceof TypeError) {
      throw new AppError('LLM_NETWORK', '无法连接模型服务，请检查 Base URL、网络或代理设置。', error.message)
    }
    throw new AppError('LLM_UNKNOWN', '模型请求失败，请稍后重试。', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

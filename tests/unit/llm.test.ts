import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { callLlm, parseSseEvents, type LlmMessage } from '../../src/main/llm/client'
import type { LlmSettings } from '../../src/shared/types'

let server: Server | null = null
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}/v1`
}

const settings: LlmSettings = {
  baseUrl: '',
  model: 'test-model',
  timeoutMs: 5000,
  stream: true,
  temperature: 0.2
}
const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }]

describe('OpenAI-compatible client', () => {
  it('parses SSE data split across chunks', () => {
    const parsed = parseSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\npartial')
    expect(parsed.events).toEqual(['{"a":1}', '{"b":2}', '[DONE]'])
    expect(parsed.rest).toBe('partial')
  })

  it('streams deltas and returns the final content', async () => {
    const baseUrl = await startServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer test-key')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    const deltas: string[] = []
    const result = await callLlm({
      messages,
      settings: { ...settings, baseUrl },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta)
    })
    expect(result.content).toBe('你好')
    expect(deltas).toEqual(['你', '好'])
  })

  it('maps 401 to an authentication error without leaking the key', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"bad key sk-secret-value"}}')
    })
    await expect(
      callLlm({ messages, settings: { ...settings, baseUrl }, apiKey: 'sk-secret-value', signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: 'LLM_AUTH_FAILED' })
    try {
      await callLlm({ messages, settings: { ...settings, baseUrl }, apiKey: 'sk-secret-value', signal: new AbortController().signal })
    } catch (error) {
      expect(String((error as { details?: string }).details)).not.toContain('sk-secret-value')
    }
  })

  it('maps connection failures to a readable network error', async () => {
    await expect(
      callLlm({
        messages,
        settings: { ...settings, baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1000 },
        apiKey: 'key',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'LLM_NETWORK' })
  })
})

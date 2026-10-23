import { describe, expect, it, vi } from 'vitest'
import { RagService } from '../../src/main/rag/ragService'
import type { SettingsService } from '../../src/main/services/settingsService'
import type { RetrievalService } from '../../src/main/rag/retrievalService'

describe('RagService', () => {
  it('returns an explicit insufficient-data state when retrieval is empty', async () => {
    const settings = {
      getRag: () => ({ topK: 6, scoreThreshold: 0.3, maxContextChars: 4000, chunkSize: 256, chunkOverlap: 48 })
    } as unknown as SettingsService
    const retrieval = {
      retrieve: vi.fn(async () => [])
    } as unknown as RetrievalService
    const service = new RagService(settings, retrieval)
    const preparation = await service.prepare({
      question: '一个不存在于资料中的问题',
      learningMode: 'free',
      scope: {},
      history: [],
      signal: new AbortController().signal
    })
    expect(preparation.insufficient).toBe(true)
    expect(preparation.messages).toEqual([])
    expect(preparation.sources).toEqual([])
  })
})

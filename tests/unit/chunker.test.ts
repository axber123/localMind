import { describe, expect, it } from 'vitest'
import { chunkText, estimateTokens } from '../../src/main/indexing/chunker'

const countChars = async (texts: string[]): Promise<number[]> => texts.map((text) => Array.from(text).length)

describe('chunkText', () => {
  it('returns no chunks for empty input', async () => {
    expect(await chunkText('   \n\n', { chunkSize: 100, chunkOverlap: 10 }, countChars)).toEqual([])
  })

  it('keeps every chunk under the exact token budget', async () => {
    const text = Array.from({ length: 80 }, (_, index) => `段落 ${index}：这是一段用于测试切分的中文内容。`).join('\n\n')
    const chunks = await chunkText(text, { chunkSize: 120, chunkOverlap: 20 }, countChars)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(120)
      expect(chunk.content.length).toBeGreaterThan(0)
    }
  })

  it('preserves markdown heading paths and offsets', async () => {
    const text = '# JavaScript\n\n闭包与词法环境有关。\n\n## 示例\n\n```js\nconst fn = () => {}\n```'
    const chunks = await chunkText(text, { chunkSize: 300, chunkOverlap: 20 }, countChars)
    expect(chunks.some((chunk) => chunk.headingPath?.includes('JavaScript'))).toBe(true)
    expect(chunks.some((chunk) => chunk.headingPath?.includes('示例'))).toBe(true)
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toContain(chunk.content.slice(0, 10))
    }
  })

  it('splits a single huge unit and reports token counts', async () => {
    const text = 'a'.repeat(1200)
    const chunks = await chunkText(text, { chunkSize: 100, chunkOverlap: 0 }, countChars)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(100)
  })

  it('estimates CJK tokens more conservatively than latin text', () => {
    expect(estimateTokens('闭包与词法环境')).toBeGreaterThanOrEqual(6)
    expect(estimateTokens('closure lexical environment')).toBeGreaterThan(1)
  })
})

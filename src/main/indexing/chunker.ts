export interface TextChunk {
  chunkIndex: number
  content: string
  headingPath: string | null
  startOffset: number
  endOffset: number
  tokenCount: number
}

export interface ChunkOptions {
  chunkSize: number
  chunkOverlap: number
}

export type TokenCounter = (texts: string[]) => Promise<number[]>

interface Section {
  headingPath: string | null
  text: string
  start: number
}

interface Unit {
  text: string
  start: number
  end: number
}

export function estimateTokens(text: string): number {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  const latinWords = (text.match(/[A-Za-z0-9_]+/g) ?? []).length
  const punctuation = (text.match(/[^\sA-Za-z0-9_\p{Script=Han}]/gu) ?? []).length
  return Math.ceil(han + latinWords * 1.35 + punctuation * 0.35 + text.length * 0.02)
}

function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  const headings: string[] = []
  let currentStart = 0
  let currentHeading: string | null = null
  let offset = 0
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (offset > currentStart) {
        sections.push({
          headingPath: currentHeading,
          text: text.slice(currentStart, offset),
          start: currentStart
        })
      }
      const level = match[1]!.length
      headings.length = Math.min(headings.length, level - 1)
      headings[level - 1] = match[2]!.trim()
      currentHeading = headings.filter(Boolean).join(' > ')
      currentStart = offset
    }
    offset += line.length + 1
  }
  if (currentStart < text.length) {
    sections.push({ headingPath: currentHeading, text: text.slice(currentStart), start: currentStart })
  }
  return sections.filter((section) => section.text.trim().length > 0)
}

function splitUnits(section: Section, maxChars: number): Unit[] {
  const units: Unit[] = []
  const paragraphRegex = /[^\n]*(?:\n(?!\n)[^\n]*)*/g
  for (const match of section.text.matchAll(paragraphRegex)) {
    const raw = match[0]
    if (!raw || raw.trim().length === 0) continue
    const leading = raw.length - raw.trimStart().length
    const start = section.start + (match.index ?? 0) + leading
    const value = raw.trim()
    const pieces = value.length <= maxChars ? [value] : splitLongText(value, maxChars)
    let localOffset = 0
    for (const piece of pieces) {
      const found = value.indexOf(piece, localOffset)
      const pieceStart = start + (found >= 0 ? found : localOffset)
      units.push({ text: piece, start: pieceStart, end: pieceStart + piece.length })
      localOffset = (found >= 0 ? found : localOffset) + piece.length
    }
  }
  return units
}

function splitLongText(text: string, maxChars: number): string[] {
  const pieces: string[] = []
  const sentences = text.split(/(?<=[。！？!?；;.\n])\s*/)
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length <= maxChars) {
      current += sentence
    } else {
      if (current.trim()) pieces.push(current.trim())
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) pieces.push(sentence.slice(i, i + maxChars))
        current = ''
      } else {
        current = sentence
      }
    }
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces.filter(Boolean)
}

function tailChars(text: string, overlapTokens: number): string {
  const estimatedChars = Math.max(0, Math.floor(overlapTokens * 2.5))
  if (estimatedChars <= 0) return ''
  if (text.length <= estimatedChars) return text
  const start = text.length - estimatedChars
  const boundary = text.indexOf('\n', start)
  return boundary >= 0 && boundary < text.length - 40 ? text.slice(boundary + 1) : text.slice(start)
}

async function splitByTokenLimit(content: string, maxTokens: number, countTokens: TokenCounter): Promise<string[]> {
  const [count] = await countTokens([content])
  if ((count ?? 0) <= maxTokens) return [content]
  const pieces: string[] = []
  let rest = content
  let safety = 0
  while (rest.length > 0 && safety < 100) {
    safety += 1
    let low = 1
    let high = rest.length
    let best = 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const [tokens] = await countTokens([rest.slice(0, mid)])
      if ((tokens ?? Number.POSITIVE_INFINITY) <= maxTokens) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    let cut = rest.lastIndexOf('\n', best)
    if (cut < Math.floor(best * 0.5)) cut = rest.lastIndexOf(' ', best)
    if (cut < Math.floor(best * 0.5)) cut = best
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  return pieces.filter(Boolean)
}

export async function chunkText(
  text: string,
  options: ChunkOptions,
  countTokens: TokenCounter
): Promise<TextChunk[]> {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) return []
  const maxChars = Math.max(100, options.chunkSize)
  const candidates: Array<{ content: string; headingPath: string | null; start: number; end: number }> = []

  for (const section of splitSections(normalized)) {
    const units = splitUnits(section, Math.floor(maxChars * 0.8))
    let current: Unit[] = []
    const flush = (): void => {
      if (current.length === 0) return
      const first = current[0]!
      const last = current[current.length - 1]!
      candidates.push({
        content: normalized.slice(first.start, last.end).trim(),
        headingPath: section.headingPath,
        start: first.start,
        end: last.end
      })
    }
    for (const unit of units) {
      const test = [...current, unit]
      const textValue = test.map((item) => item.text).join('\n\n')
      if (current.length > 0 && estimateTokens(textValue) > options.chunkSize) {
        flush()
        const previous = candidates[candidates.length - 1]
        const overlap = previous ? tailChars(previous.content, options.chunkOverlap) : ''
        current = overlap
          ? [
              {
                text: overlap,
                start: Math.max(previous!.start, previous!.end - overlap.length),
                end: previous!.end
              },
              unit
            ]
          : [unit]
      } else {
        current.push(unit)
      }
    }
    flush()
  }

  const verified: Array<{
    content: string
    headingPath: string | null
    startOffset: number
    endOffset: number
    tokenCount: number
  }> = []
  for (const candidate of candidates) {
    if (!candidate.content.trim()) continue
    const [tokenCount] = await countTokens([candidate.content])
    if ((tokenCount ?? 0) <= options.chunkSize) {
      verified.push({
        content: candidate.content,
        headingPath: candidate.headingPath,
        startOffset: candidate.start,
        endOffset: candidate.end,
        tokenCount: tokenCount ?? estimateTokens(candidate.content)
      })
    } else {
      const pieces = await splitByTokenLimit(candidate.content, options.chunkSize, countTokens)
      let cursor = candidate.start
      for (const piece of pieces) {
        const start = normalized.indexOf(piece, cursor)
        const safeStart = start >= 0 ? start : cursor
        const [count] = await countTokens([piece])
        verified.push({
          content: piece,
          headingPath: candidate.headingPath,
          startOffset: safeStart,
          endOffset: safeStart + piece.length,
          tokenCount: count ?? estimateTokens(piece)
        })
        cursor = safeStart + piece.length
      }
    }
  }

  // Merge tiny adjacent chunks that share a heading and still fit.
  const merged: typeof verified = []
  for (const item of verified) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.headingPath === item.headingPath &&
      previous.tokenCount < Math.floor(options.chunkSize * 0.3) &&
      previous.tokenCount + item.tokenCount <= options.chunkSize
    ) {
      const content = `${previous.content}\n\n${item.content}`
      const [count] = await countTokens([content])
      previous.content = content
      previous.endOffset = item.endOffset
      previous.tokenCount = count ?? previous.tokenCount + item.tokenCount
    } else {
      merged.push({ ...item })
    }
  }

  return merged.map((item, index) => ({ ...item, chunkIndex: index }))
}

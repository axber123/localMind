export interface RetrievedChunk {
  chunkId: number
  documentId: number
  fileName: string
  sourcePath: string
  headingPath: string | null
  content: string
  startOffset: number
  endOffset: number
  pageNumber: number | null
  score: number
}

export interface ContextSource extends RetrievedChunk {
  sourceId: string
}

export interface BuiltContext {
  contextText: string
  sources: ContextSource[]
  truncated: boolean
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function shingles(text: string): Set<string> {
  const tokens = normalize(text).split(' ').slice(0, 400)
  const result = new Set<string>()
  for (let i = 0; i < tokens.length - 4; i += 1) result.add(tokens.slice(i, i + 5).join(' '))
  return result
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('. '))
  return `${boundary > maxChars * 0.5 ? cut.slice(0, boundary + 1) : cut}…`
}

export function buildContext(
  chunks: RetrievedChunk[],
  maxContextChars: number,
  perSourceChars = 1800
): BuiltContext {
  const selected: RetrievedChunk[] = []
  const exact = new Set<string>()
  const shingleSets: Set<string>[] = []
  for (const chunk of chunks) {
    const normalized = normalize(chunk.content)
    if (!normalized || exact.has(normalized)) continue
    const set = shingles(chunk.content)
    if (shingleSets.some((existing) => similarity(existing, set) > 0.92)) continue
    exact.add(normalized)
    shingleSets.push(set)
    selected.push(chunk)
  }

  const sources: ContextSource[] = []
  let used = 0
  let truncated = false
  for (const chunk of selected) {
    const sourceId = `S${sources.length + 1}`
    const header = `<source id="${sourceId}" file="${chunk.fileName.replace(/"/g, "'")}" path="${chunk.sourcePath.replace(/"/g, "'")}"${chunk.headingPath ? ` heading="${chunk.headingPath.replace(/"/g, "'")}"` : ''}${chunk.pageNumber ? ` page="${chunk.pageNumber}"` : ''}>`
    const footer = '</source>'
    const remaining = maxContextChars - used - header.length - footer.length - 2
    if (remaining < 200) {
      truncated = true
      break
    }
    const clipped = clip(chunk.content, Math.min(perSourceChars, remaining))
    const safeContent = clipped.replace(/<\/source>/gi, '&lt;/source&gt;')
    const block = `${header}\n${safeContent}\n${footer}`
    sources.push({ ...chunk, content: safeContent, sourceId })
    used += block.length + 2
    if (safeContent.length < chunk.content.length) truncated = true
  }

  const contextText = sources
    .map((source) => {
      const header = `<source id="${source.sourceId}" file="${source.fileName.replace(/"/g, "'")}" path="${source.sourcePath.replace(/"/g, "'")}"${source.headingPath ? ` heading="${source.headingPath.replace(/"/g, "'")}"` : ''}${source.pageNumber ? ` page="${source.pageNumber}"` : ''}>`
      return `${header}\n${source.content}\n</source>`
    })
    .join('\n\n')

  return { contextText, sources, truncated }
}

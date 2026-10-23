import type { AppDatabase } from '../db/database'
import type { RetrievalScope } from '../../shared/types'
import type { RetrievedChunk } from '../rag/contextBuilder'

interface VectorRow {
  id: number
  document_id: number
  content: string
  heading_path: string | null
  start_offset: number
  end_offset: number
  page_number: number | null
  embedding: Uint8Array
  file_name: string
  source_path: string
}

export class VectorStore {
  constructor(private readonly db: AppDatabase) {}

  async search(input: {
    queryVector: Float32Array
    modelId: string
    dimensions: number
    scope: RetrievalScope
    topK: number
    threshold: number
    maxCandidates?: number
  }): Promise<RetrievedChunk[]> {
    const { where, params } = this.buildFilter(input.scope, input.modelId, input.dimensions)
    const total =
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
         ${where}`,
        ...params
      )?.count ?? 0
    if (total === 0) return []
    const maxCandidates = Math.min(input.maxCandidates ?? 200_000, total)
    const query = input.queryVector
    let queryNorm = 0
    for (const value of query) queryNorm += value * value
    queryNorm = Math.sqrt(queryNorm) || 1
    const scored: RetrievedChunk[] = []
    const batchSize = 2_000
    for (let offset = 0; offset < maxCandidates; offset += batchSize) {
      const rows = this.db.all<VectorRow>(
        `SELECT c.id, c.document_id, c.content, c.heading_path, c.start_offset, c.end_offset,
                c.page_number, c.embedding, d.file_name, d.source_path
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
         ${where}
         ORDER BY c.id
         LIMIT ? OFFSET ?`,
        ...params,
        batchSize,
        offset
      )
      for (const row of rows) {
        if (!row.embedding) continue
        const vector = float32FromBlob(row.embedding)
        if (vector.length !== input.dimensions) continue
        let dot = 0
        let norm = 0
        for (let index = 0; index < vector.length; index += 1) {
          const value = vector[index]!
          dot += value * query[index]!
          norm += value * value
        }
        const score = dot / (queryNorm * (Math.sqrt(norm) || 1))
        if (!Number.isFinite(score) || score < input.threshold) continue
        scored.push({
          chunkId: row.id,
          documentId: row.document_id,
          fileName: row.file_name,
          sourcePath: row.source_path,
          headingPath: row.heading_path,
          content: row.content,
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          pageNumber: row.page_number,
          score
        })
      }
      if (rows.length < batchSize) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, input.topK)
  }

  private buildFilter(
    scope: RetrievalScope,
    modelId: string,
    dimensions: number
  ): { where: string; params: unknown[] } {
    const clauses = [
      'c.generation = d.active_generation',
      'c.embedding IS NOT NULL',
      'c.embedding_model_id = ?',
      'c.embedding_dim = ?'
    ]
    const params: unknown[] = [modelId, dimensions]
    if (scope.folderIds && scope.folderIds.length > 0) {
      clauses.push(`d.folder_id IN (${scope.folderIds.map(() => '?').join(', ')})`)
      params.push(...scope.folderIds)
    }
    if (scope.documentIds && scope.documentIds.length > 0) {
      clauses.push(`d.id IN (${scope.documentIds.map(() => '?').join(', ')})`)
      params.push(...scope.documentIds)
    }
    if (scope.tagIds && scope.tagIds.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM folder_tags ft WHERE ft.folder_id = d.folder_id AND ft.tag_id IN (${scope.tagIds
          .map(() => '?')
          .join(', ')}))`
      )
      params.push(...scope.tagIds)
    }
    return { where: `WHERE ${clauses.join(' AND ')}`, params }
  }
}

export function float32FromBlob(blob: Uint8Array): Float32Array {
  const copy = Buffer.from(blob)
  const arrayBuffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
  return new Float32Array(arrayBuffer)
}

export function vectorToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

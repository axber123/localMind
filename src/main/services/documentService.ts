import { basename } from 'node:path'
import type { AppDatabase } from '../db/database'
import { AppError } from '../db/database'
import type { DocumentQuery, DocumentPreview, DocumentSummary, Paginated } from '../../shared/types'
import type { DocumentRecord } from '../db/documentRepository'
import { DocumentRepository, toDocumentSummary } from '../db/documentRepository'
import type { CurrentIndexConfig } from '../indexing/indexConfig'
import { countLines, readTextFile } from '../indexing/fileReader'
import {
  MAX_PREVIEW_BYTES,
  extensionOf,
  languageOf
} from '../indexing/fileTypes'
import { canonicalExistingPath, assertPathInside } from '../security/paths'
import { searchFts } from './fts'

interface DocumentListRow {
  id: number
  kind: 'file' | 'note'
  folder_id: number | null
  note_id: number | null
  folder_name: string | null
  source_path: string
  file_name: string
  extension: string
  file_hash: string
  file_size: number
  last_modified_at: string
  indexing_status: DocumentSummary['indexingStatus']
  indexed_at: string | null
  active_generation: string | null
  index_model_id: string | null
  index_config_version: string | null
  error_message: string | null
}

export class DocumentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly repository: DocumentRepository,
    private readonly notesRoot: string,
    private readonly getConfig: () => CurrentIndexConfig
  ) {}

  list(query: DocumentQuery): Paginated<DocumentSummary> {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize || 50)))
    const where: string[] = ["d.kind = 'file'"]
    const params: unknown[] = []
    if (typeof query.folderId === 'number') {
      where.push('d.folder_id = ?')
      params.push(query.folderId)
    }
    if (query.status && query.status !== 'all') {
      where.push('d.indexing_status = ?')
      params.push(query.status)
    }
    const term = query.query?.trim()
    if (term) {
      const like = `%${term}%`
      const ftsIds = searchFts(this.db, term, ['document'], 1000).map((hit) => hit.entityId)
      if (ftsIds.length > 0) {
        where.push(`(d.file_name LIKE ? OR d.source_path LIKE ? OR d.id IN (${ftsIds.map(() => '?').join(', ')}))`)
        params.push(like, like, ...ftsIds)
      } else {
        where.push('(d.file_name LIKE ? OR d.source_path LIKE ?)')
        params.push(like, like)
      }
    }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const total =
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM documents d ${whereSql}`, ...params)?.count ?? 0
    const rows = this.db.all<DocumentListRow>(
      `SELECT d.id, d.kind, d.folder_id, d.note_id, f.name AS folder_name, d.source_path, d.file_name,
              d.extension, d.file_hash, d.file_size, d.last_modified_at, d.indexing_status, d.indexed_at,
              d.active_generation, d.index_model_id, d.index_config_version, d.error_message
       FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
       ${whereSql}
       ORDER BY d.last_modified_at DESC
       LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize
    )
    return {
      items: rows.map((row) => toDocumentSummary(row as never, this.getConfig())),
      total,
      page,
      pageSize
    }
  }

  async preview(id: number): Promise<DocumentPreview> {
    const record = this.repository.getRecord(id)
    if (!record) throw new AppError('DOCUMENT_NOT_FOUND', '文档不存在或索引已被移除。')
    let root: string | null = null
    if (record.kind === 'note') {
      root = this.notesRoot
    } else if (record.folder_id !== null) {
      root =
        this.db.get<{ path: string }>('SELECT path FROM folders WHERE id = ?', record.folder_id)?.path ?? null
      if (!root) throw new AppError('FOLDER_NOT_FOUND', '文档所属资料夹已不存在。')
    }
    if (!root) throw new AppError('DOCUMENT_PATH_UNKNOWN', '无法确定文档的授权目录。')
    let canonical: string
    try {
      canonical = canonicalExistingPath(record.source_path)
    } catch {
      throw new AppError('FILE_MISSING', '原始文件不存在，可能已被移动或删除。请刷新资料夹。')
    }
    assertPathInside(root, canonical)
    let read: Awaited<ReturnType<typeof readTextFile>>
    try {
      read = await readTextFile(canonical, MAX_PREVIEW_BYTES)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('FILE_READ_FAILED', '读取文档失败，请检查文件权限。', error instanceof Error ? error.message : String(error))
    }
    const row = this.repository.getRecordWithFolder(id)!
    const summary = toDocumentSummary(row, this.getConfig())
    return {
      document: {
        ...summary,
        fileSize: read.totalBytes || summary.fileSize,
        fileName: basename(canonical) || summary.fileName,
        extension: extensionOf(canonical) || summary.extension
      },
      content: read.content,
      truncated: read.truncated,
      totalBytes: read.totalBytes,
      lineCount: countLines(read.content),
      language: languageOf(record.file_name),
      chunkCount: this.repository.chunkCount(id, record.active_generation)
    }
  }

  summaryForCitation(id: number): DocumentSummary | undefined {
    return this.repository.getSummary(id)
  }
}

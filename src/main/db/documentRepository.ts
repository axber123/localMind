import type { AppDatabase } from '../db/database'
import { nowIso } from '../db/database'
import type { DocumentSummary, IndexStatus } from '../../shared/types'
import type { CurrentIndexConfig } from '../indexing/indexConfig'
import { PARSER_VERSION } from '../indexing/indexConfig'
import { removeFts } from '../services/fts'

export interface DocumentRecord {
  id: number
  kind: 'file' | 'note'
  folder_id: number | null
  note_id: number | null
  source_path: string
  file_name: string
  extension: string
  file_hash: string
  file_size: number
  last_modified_at: string
  parser_version: number
  indexing_status: IndexStatus
  indexed_at: string | null
  active_generation: string | null
  index_model_id: string | null
  index_config_version: string | null
  error_message: string | null
  content_text: string | null
  last_scanned_at: string | null
  created_at: string
  updated_at: string
}

interface DocumentRow extends DocumentRecord {
  folder_name: string | null
}

export function toDocumentSummary(row: DocumentRow, config: CurrentIndexConfig): DocumentSummary {
  const hasIndex = Boolean(row.active_generation)
  return {
    id: row.id,
    folderId: row.folder_id,
    folderName: row.folder_name,
    noteId: row.note_id,
    kind: row.kind,
    fileName: row.file_name,
    sourcePath: row.source_path,
    extension: row.extension,
    fileSize: row.file_size,
    lastModifiedAt: row.last_modified_at,
    indexingStatus: row.indexing_status,
    indexedAt: row.indexed_at,
    errorMessage: row.error_message,
    hasIndex,
    indexModelId: row.index_model_id,
    isStale:
      hasIndex &&
      (row.index_model_id !== config.modelId || row.index_config_version !== config.configVersion)
  }
}

export class DocumentRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly getConfig: () => CurrentIndexConfig
  ) {}

  getRecord(id: number): DocumentRecord | undefined {
    return this.db.get<DocumentRecord>(
      `SELECT d.*, f.name AS folder_name
       FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
       WHERE d.id = ?`,
      id
    )
  }

  getRecordWithFolder(id: number): DocumentRow | undefined {
    return this.db.get<DocumentRow>(
      `SELECT d.*, f.name AS folder_name
       FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
       WHERE d.id = ?`,
      id
    )
  }

  getSummary(id: number): DocumentSummary | undefined {
    const row = this.getRecordWithFolder(id)
    return row ? toDocumentSummary(row, this.getConfig()) : undefined
  }

  findByPath(path: string): DocumentRecord | undefined {
    return this.db.get<DocumentRecord>('SELECT * FROM documents WHERE source_path = ? COLLATE NOCASE', path)
  }

  listForFolder(folderId: number): DocumentRecord[] {
    return this.db.all<DocumentRecord>(
      "SELECT * FROM documents WHERE folder_id = ? AND kind = 'file' ORDER BY source_path",
      folderId
    )
  }

  insertFile(input: {
    folderId: number
    sourcePath: string
    fileName: string
    extension: string
    hash: string
    size: number
    modifiedAt: string
    parserVersion: number
    content: string | null
    status: IndexStatus
    errorMessage?: string | null
  }): number {
    const now = nowIso()
    const result = this.db.run(
      `INSERT INTO documents(
        kind, folder_id, note_id, source_path, file_name, extension, file_hash, file_size,
        last_modified_at, parser_version, indexing_status, error_message, content_text,
        last_scanned_at, created_at, updated_at
      ) VALUES ('file', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.folderId,
      input.sourcePath,
      input.fileName,
      input.extension,
      input.hash,
      input.size,
      input.modifiedAt,
      input.parserVersion,
      input.status,
      input.errorMessage ?? null,
      input.content,
      now,
      now,
      now
    )
    return result.lastInsertRowid
  }

  insertNote(input: {
    noteId: number
    sourcePath: string
    fileName: string
    hash: string
    size: number
    modifiedAt: string
    content: string
    status: IndexStatus
  }): number {
    const now = nowIso()
    const result = this.db.run(
      `INSERT INTO documents(
        kind, folder_id, note_id, source_path, file_name, extension, file_hash, file_size,
        last_modified_at, parser_version, indexing_status, error_message, content_text,
        last_scanned_at, created_at, updated_at
      ) VALUES ('note', NULL, ?, ?, ?, '.md', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      input.noteId,
      input.sourcePath,
      input.fileName,
      input.hash,
      input.size,
      input.modifiedAt,
      PARSER_VERSION,
      input.status,
      input.content,
      now,
      now,
      now
    )
    return result.lastInsertRowid
  }

  findDocumentForNote(noteId: number): DocumentRecord | undefined {
    return this.db.get<DocumentRecord>('SELECT * FROM documents WHERE note_id = ?', noteId)
  }

  updateNoteDocument(
    documentId: number,
    input: { sourcePath: string; fileName: string; hash: string; size: number; modifiedAt: string; content: string }
  ): void {
    this.db.run(
      `UPDATE documents SET source_path = ?, file_name = ?, file_hash = ?, file_size = ?,
        last_modified_at = ?, content_text = ?, indexing_status = 'pending', error_message = NULL,
        last_scanned_at = ?, updated_at = ? WHERE id = ?`,
      input.sourcePath,
      input.fileName,
      input.hash,
      input.size,
      input.modifiedAt,
      input.content,
      nowIso(),
      nowIso(),
      documentId
    )
  }

  updateFile(
    id: number,
    input: {
      sourcePath?: string
      fileName?: string
      hash: string
      size: number
      modifiedAt: string
      content: string | null
      status: IndexStatus
      errorMessage?: string | null
      resetIndex?: boolean
    }
  ): void {
    const now = nowIso()
    this.db.run(
      `UPDATE documents SET
        source_path = COALESCE(?, source_path),
        file_name = COALESCE(?, file_name),
        file_hash = ?, file_size = ?, last_modified_at = ?, content_text = ?,
        last_scanned_at = ?, indexing_status = ?, error_message = ?,
        active_generation = CASE WHEN ? = 1 THEN NULL ELSE active_generation END,
        index_model_id = CASE WHEN ? = 1 THEN NULL ELSE index_model_id END,
        index_config_version = CASE WHEN ? = 1 THEN NULL ELSE index_config_version END,
        updated_at = ?
       WHERE id = ?`,
      input.sourcePath ?? null,
      input.fileName ?? null,
      input.hash,
      input.size,
      input.modifiedAt,
      input.content,
      now,
      input.status,
      input.errorMessage ?? null,
      input.resetIndex ? 1 : 0,
      input.resetIndex ? 1 : 0,
      input.resetIndex ? 1 : 0,
      now,
      id
    )
  }

  renameFile(id: number, newPath: string, newName: string, modifiedAt: string): void {
    this.db.run(
      'UPDATE documents SET source_path = ?, file_name = ?, last_modified_at = ?, updated_at = ? WHERE id = ?',
      newPath,
      newName,
      modifiedAt,
      nowIso(),
      id
    )
  }

  remove(id: number): void {
    removeFts(this.db, 'document', id)
    this.db.run('DELETE FROM documents WHERE id = ?', id)
  }

  setStatus(id: number, status: IndexStatus, errorMessage: string | null = null): void {
    this.db.run(
      'UPDATE documents SET indexing_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
      status,
      errorMessage,
      nowIso(),
      id
    )
  }

  markPendingForReindex(id: number): void {
    this.db.run(
      "UPDATE documents SET indexing_status = 'pending', error_message = NULL, updated_at = ? WHERE id = ?",
      nowIso(),
      id
    )
  }

  recoverInterrupted(): void {
    this.db.run(
      "UPDATE documents SET indexing_status = 'failed', error_message = '上次索引任务被中断，请重试。', updated_at = ? WHERE indexing_status = 'processing'",
      nowIso()
    )
  }

  chunkCount(documentId: number, generation: string | null): number {
    if (!generation) return 0
    return (
      this.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM document_chunks WHERE document_id = ? AND generation = ?',
        documentId,
        generation
      )?.count ?? 0
    )
  }
}

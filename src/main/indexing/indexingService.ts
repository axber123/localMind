import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type { DocumentRecord, DocumentRepository } from '../db/documentRepository'
import type { DocumentScanner, ScanCancelledError } from './scanner'
import type { CurrentIndexConfig } from './indexConfig'
import { PARSER_VERSION, chunkConfigVersion } from './indexConfig'
import type { EmbeddingClient } from '../model/embeddingClient'
import type { ModelManager } from '../model/modelManager'
import type { SettingsService } from '../services/settingsService'
import type { IndexJob, IndexProgressEvent, JobStatus } from '../../shared/types'
import { chunkText } from './chunker'
import { readWholeTextFile } from './fileReader'
import { MAX_PARSE_BYTES, extensionOf, isSupportedFile } from './fileTypes'
import { assertPathInside, canonicalExistingPath, sha256Hex } from '../security/paths'
import { upsertFts } from '../services/fts'
import { vectorToBlob } from '../rag/vectorStore'

interface JobRow {
  id: string
  kind: 'scan' | 'index'
  folder_id: number | null
  status: JobStatus
  total: number
  processed: number
  failed: number
  message: string | null
  error: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export class IndexingService {
  private activeJobId: string | null = null
  private activeController: AbortController | null = null
  private pendingNoteDocs = new Set<number>()
  private noteTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly documents: DocumentRepository,
    private readonly scanner: DocumentScanner,
    private readonly embeddings: EmbeddingClient,
    private readonly models: ModelManager,
    private readonly settings: SettingsService,
    private readonly notesRoot: string,
    private readonly emit: (event: IndexProgressEvent) => void
  ) {}

  recoverInterrupted(): void {
    this.documents.recoverInterrupted()
    this.db.run(
      "UPDATE index_jobs SET status = 'failed', error = '应用上次退出时任务未完成。', finished_at = ? WHERE status IN ('pending', 'processing')",
      nowIso()
    )
  }

  currentConfig(): CurrentIndexConfig {
    const rag = this.settings.getRag()
    return {
      modelId: this.models.status().modelId,
      configVersion: chunkConfigVersion(rag.chunkSize, rag.chunkOverlap)
    }
  }

  listJobs(): IndexJob[] {
    return this.db.all<JobRow>('SELECT * FROM index_jobs ORDER BY created_at DESC LIMIT 30').map((row) => this.mapJob(row))
  }

  getJob(id: string): IndexJob {
    const row = this.db.get<JobRow>('SELECT * FROM index_jobs WHERE id = ?', id)
    if (!row) throw new AppError('JOB_NOT_FOUND', '索引任务不存在。')
    return this.mapJob(row)
  }

  startScan(folderId: number): IndexJob {
    this.assertIdle()
    const folder = this.getFolder(folderId)
    const job = this.createJob('scan', folderId)
    const controller = new AbortController()
    this.activeJobId = job.id
    this.activeController = controller
    void this.runScan(job.id, folderId, folder.path, controller.signal)
    return job
  }

  startIndex(folderId: number | null, documentIds?: number[], force = false): IndexJob {
    this.assertIdle()
    if (folderId !== null) this.getFolder(folderId)
    const docs = this.pickDocuments(folderId, documentIds)
    const job = this.createJob('index', folderId, docs.length)
    const controller = new AbortController()
    this.activeJobId = job.id
    this.activeController = controller
    void this.runIndex(job.id, docs, force, controller.signal)
    return job
  }

  startRetryFailed(folderId: number): IndexJob {
    const docs = this.db.all<DocumentRecord>(
      "SELECT * FROM documents WHERE folder_id = ? AND kind = 'file' AND indexing_status = 'failed'",
      folderId
    )
    return this.startIndex(folderId, docs.map((doc) => doc.id), true)
  }

  cancel(id: string): IndexJob {
    if (this.activeJobId !== id || !this.activeController) {
      throw new AppError('JOB_NOT_RUNNING', '该任务当前没有运行。')
    }
    this.activeController.abort()
    this.db.run("UPDATE index_jobs SET message = '正在取消…' WHERE id = ?", id)
    this.emitJob(id)
    return this.getJob(id)
  }

  scheduleNoteIndex(documentId: number): void {
    this.pendingNoteDocs.add(documentId)
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null
      this.flushNoteIndex()
    }, 2_500)
  }

  private flushNoteIndex(): void {
    if (this.activeJobId || this.pendingNoteDocs.size === 0) {
      if (this.pendingNoteDocs.size > 0) {
        this.noteTimer = setTimeout(() => this.flushNoteIndex(), 4_000)
      }
      return
    }
    const ids = [...this.pendingNoteDocs]
    this.pendingNoteDocs.clear()
    try {
      this.startIndex(null, ids, true)
    } catch {
      for (const id of ids) this.pendingNoteDocs.add(id)
      this.noteTimer = setTimeout(() => this.flushNoteIndex(), 4_000)
    }
  }

  shutdown(): void {
    this.activeController?.abort()
    if (this.noteTimer) clearTimeout(this.noteTimer)
  }

  private pickDocuments(folderId: number | null, documentIds?: number[]): DocumentRecord[] {
    if (documentIds && documentIds.length > 0) {
      const docs: DocumentRecord[] = []
      for (const id of documentIds) {
        const doc = this.documents.getRecord(id)
        if (doc) docs.push(doc)
      }
      return docs
    }
    if (folderId === null) return []
    return this.documents.listForFolder(folderId)
  }

  private async runScan(jobId: string, folderId: number, path: string, signal: AbortSignal): Promise<void> {
    let lastEmit = 0
    try {
      const result = await this.scanner.scanFolder(folderId, path, {
        isCancelled: () => signal.aborted,
        onProgress: (processed, total, currentFile) => {
          const now = Date.now()
          if (now - lastEmit < 180 && processed < total) return
          lastEmit = now
          this.db.run(
            'UPDATE index_jobs SET total = ?, processed = ?, message = ? WHERE id = ?',
            total,
            processed,
            currentFile ? `扫描：${currentFile}` : '扫描完成',
            jobId
          )
          this.emitJob(jobId)
        }
      })
      this.db.run(
        "UPDATE index_jobs SET status = 'completed', total = ?, processed = ?, failed = ?, message = ?, finished_at = ? WHERE id = ?",
        result.total,
        result.processed,
        result.failed,
        `扫描完成：${result.total} 个文件，${result.removed} 个移除，${result.renamed} 个重命名，${result.failed} 个失败`,
        nowIso(),
        jobId
      )
    } catch (error) {
      if (signal.aborted || (error as Error).name === 'ScanCancelledError') {
        this.db.run("UPDATE index_jobs SET status = 'cancelled', message = '扫描已取消', finished_at = ? WHERE id = ?", nowIso(), jobId)
      } else {
        this.db.run(
          "UPDATE index_jobs SET status = 'failed', error = ?, message = '扫描失败', finished_at = ? WHERE id = ?",
          error instanceof Error ? error.message : String(error),
          nowIso(),
          jobId
        )
      }
    } finally {
      this.activeJobId = null
      this.activeController = null
      this.emitJob(jobId)
    }
  }

  private async runIndex(jobId: string, docs: DocumentRecord[], force: boolean, signal: AbortSignal): Promise<void> {
    let processed = 0
    let failed = 0
    try {
      this.models.markLoading()
      await this.embeddings.ensureLoaded(this.models.modelDir, signal)
      this.models.markReady()
      const rag = this.settings.getRag()
      const config = this.currentConfig()
      const vectorCache = new Map<string, Float32Array>()
      for (const original of docs) {
        if (signal.aborted) throw new AppError('INDEX_CANCELLED', '索引任务已取消。')
        const doc = this.documents.getRecord(original.id)
        if (!doc) {
          processed += 1
          continue
        }
        this.documents.setStatus(doc.id, 'processing')
        this.db.run(
          'UPDATE index_jobs SET processed = ?, failed = ?, message = ? WHERE id = ?',
          processed,
          failed,
          `索引：${doc.file_name}`,
          jobId
        )
        this.emitJob(jobId)
        try {
          await this.indexDocument(doc, jobId, force, config, rag.chunkSize, rag.chunkOverlap, vectorCache, signal)
          processed += 1
        } catch (error) {
          if (signal.aborted) {
            if (doc.active_generation) {
              this.documents.setStatus(doc.id, 'indexed', '索引任务已取消，继续使用旧索引。')
            } else {
              this.documents.setStatus(doc.id, 'cancelled', '索引任务已取消。')
            }
            throw error
          }
          failed += 1
          processed += 1
          this.documents.setStatus(doc.id, 'failed', error instanceof Error ? error.message : String(error))
        }
        this.db.run(
          'UPDATE index_jobs SET processed = ?, failed = ?, message = ? WHERE id = ?',
          processed,
          failed,
          `已处理 ${processed}/${docs.length}`,
          jobId
        )
        this.emitJob(jobId)
      }
      if (signal.aborted) throw new AppError('INDEX_CANCELLED', '索引任务已取消。')
      const status: JobStatus = failed > 0 && failed === docs.length && docs.length > 0 ? 'failed' : 'completed'
      this.db.run(
        'UPDATE index_jobs SET status = ?, total = ?, processed = ?, failed = ?, message = ?, finished_at = ? WHERE id = ?',
        status,
        docs.length,
        processed,
        failed,
        `索引完成：${processed} 个处理，${failed} 个失败`,
        nowIso(),
        jobId
      )
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof AppError && error.code === 'INDEX_CANCELLED')
      if (cancelled) {
        this.db.run(
          "UPDATE index_jobs SET status = 'cancelled', processed = ?, failed = ?, message = '索引任务已取消', finished_at = ? WHERE id = ?",
          processed,
          failed,
          nowIso(),
          jobId
        )
      } else {
        this.models.markError(error instanceof Error ? error.message : String(error))
        this.db.run(
          "UPDATE index_jobs SET status = 'failed', processed = ?, failed = ?, error = ?, message = '索引任务失败', finished_at = ? WHERE id = ?",
          processed,
          failed,
          error instanceof Error ? error.message : String(error),
          nowIso(),
          jobId
        )
      }
    } finally {
      this.activeJobId = null
      this.activeController = null
      this.emitJob(jobId)
    }
  }

  private async indexDocument(
    doc: DocumentRecord,
    jobId: string,
    force: boolean,
    config: CurrentIndexConfig,
    chunkSize: number,
    chunkOverlap: number,
    vectorCache: Map<string, Float32Array>,
    signal: AbortSignal
  ): Promise<void> {
    if (!isSupportedFile(doc.file_name) && doc.kind === 'file') {
      throw new AppError('UNSUPPORTED_FILE', '该文件类型不支持建立知识库索引。')
    }
    let canonical: string
    try {
      canonical = canonicalExistingPath(doc.source_path)
    } catch {
      throw new AppError('FILE_MISSING', '原始文件不存在，请刷新资料夹。')
    }
    if (doc.kind === 'file' && doc.folder_id !== null) {
      const folder = this.getFolder(doc.folder_id)
      assertPathInside(folder.path, canonical)
    } else if (doc.kind === 'note') {
      assertPathInside(this.notesRoot, canonical)
    }
    const info = await stat(canonical)
    if (info.size > MAX_PARSE_BYTES) {
      throw new AppError('FILE_TOO_LARGE', `文件超过 ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)} MB 索引上限。`)
    }
    const read = await readWholeTextFile(canonical)
    const hash = sha256Hex(read.buffer)
    const unchanged =
      !force &&
      doc.active_generation &&
      doc.file_hash === hash &&
      doc.index_model_id === config.modelId &&
      doc.index_config_version === config.configVersion &&
      doc.indexing_status === 'indexed'
    if (unchanged) {
      this.documents.setStatus(doc.id, 'indexed')
      return
    }
    const generation = randomUUID()
    const chunks = await chunkText(read.content, { chunkSize, chunkOverlap }, (texts) =>
      this.embeddings.countTokens(texts, signal)
    )
    const vectors = new Map<number, Float32Array>()
    const batchSize = 8
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      if (signal.aborted) throw new AppError('INDEX_CANCELLED', '索引任务已取消。')
      const batch = chunks.slice(offset, offset + batchSize)
      const needed: Array<{ index: number; content: string; key: string }> = []
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index]!
        const key = sha256Hex(chunk.content)
        const cached = vectorCache.get(key)
        if (cached) {
          vectors.set(offset + index, cached)
        } else {
          needed.push({ index: offset + index, content: chunk.content, key })
        }
      }
      if (needed.length > 0) {
        const embedded = await this.embeddings.embed(
          needed.map((item) => item.content),
          'passage',
          signal
        )
        needed.forEach((item, index) => {
          const vector = embedded[index]!
          vectors.set(item.index, vector)
          vectorCache.set(item.key, vector)
        })
      }
      this.db.run(
        'UPDATE index_jobs SET message = ? WHERE id = ?',
        `生成向量：${Math.min(offset + batch.length, chunks.length)}/${chunks.length} 片段`,
        jobId
      )
      this.emitJob(jobId)
    }
    this.documents.setStatus(doc.id, 'processing')
    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO document_chunks(
          document_id, generation, chunk_index, content, heading_path, start_offset, end_offset,
          page_number, token_count, embedding, embedding_model_id, embedding_dim, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      chunks.forEach((chunk, index) => {
        const vector = vectors.get(index)
        if (!vector) return
        insert.run(
          doc.id,
          generation,
          chunk.chunkIndex,
          chunk.content,
          chunk.headingPath,
          chunk.startOffset,
          chunk.endOffset,
          null,
          chunk.tokenCount,
          vectorToBlob(vector),
          config.modelId,
          384,
          nowIso()
        )
      })
      this.db.run(
        'DELETE FROM document_chunks WHERE document_id = ? AND generation <> ?',
        doc.id,
        generation
      )
      this.db.run(
        `UPDATE documents SET
          file_hash = ?, file_size = ?, last_modified_at = ?, content_text = ?,
          parser_version = ?, indexing_status = 'indexed', indexed_at = ?, error_message = NULL,
          active_generation = ?, index_model_id = ?, index_config_version = ?,
          last_scanned_at = ?, updated_at = ?
         WHERE id = ?`,
        hash,
        read.size,
        info.mtime.toISOString(),
        read.content,
        PARSER_VERSION,
        nowIso(),
        generation,
        config.modelId,
        config.configVersion,
        nowIso(),
        nowIso(),
        doc.id
      )
      if (doc.kind === 'file') upsertFts(this.db, 'document', doc.id, doc.file_name, read.content)
    })
  }

  private createJob(kind: 'scan' | 'index', folderId: number | null, total = 0): IndexJob {
    const id = randomUUID()
    const now = nowIso()
    this.db.run(
      `INSERT INTO index_jobs(id, kind, folder_id, status, total, processed, failed, message, started_at, created_at)
       VALUES (?, ?, ?, 'processing', ?, 0, 0, ?, ?, ?)`,
      id,
      kind,
      folderId,
      total,
      kind === 'scan' ? '准备扫描…' : '准备索引…',
      now,
      now
    )
    this.emitJob(id)
    return this.getJob(id)
  }

  private assertIdle(): void {
    if (this.activeJobId) throw new AppError('JOB_ALREADY_RUNNING', '已有扫描或索引任务正在运行，请等待完成或先取消。')
  }

  private getFolder(id: number): { id: number; path: string } {
    const folder = this.db.get<{ id: number; path: string }>('SELECT id, path FROM folders WHERE id = ?', id)
    if (!folder) throw new AppError('FOLDER_NOT_FOUND', '文件夹不存在或已被移除。')
    return folder
  }

  private emitJob(id: string): void {
    const job = this.db.get<JobRow>('SELECT * FROM index_jobs WHERE id = ?', id)
    if (!job) return
    this.emit({
      jobId: job.id,
      kind: job.kind,
      folderId: job.folder_id,
      status: job.status,
      total: job.total,
      processed: job.processed,
      failed: job.failed,
      currentFile: job.message,
      message: job.message
    })
  }

  private mapJob(row: JobRow): IndexJob {
    return {
      id: row.id,
      kind: row.kind,
      folderId: row.folder_id,
      status: row.status,
      total: row.total,
      processed: row.processed,
      failed: row.failed,
      message: row.message,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }
  }
}

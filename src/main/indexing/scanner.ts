import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AppDatabase } from '../db/database'
import { AppError } from '../db/database'
import type { DocumentRepository, DocumentRecord } from '../db/documentRepository'
import { decodeBuffer } from './fileReader'
import {
  EXCLUDED_DIRECTORIES,
  MAX_PARSE_BYTES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_FILES,
  extensionOf,
  isSupportedFile
} from './fileTypes'
import { sha256Hex } from '../security/paths'
import { upsertFts } from '../services/fts'
import { PARSER_VERSION } from './indexConfig'

export class ScanCancelledError extends Error {
  constructor() {
    super('扫描已取消')
    this.name = 'ScanCancelledError'
  }
}

export interface ScanFileResult {
  path: string
  name: string
  size: number
  hash: string
  modifiedAt: string
  content: string | null
  error: string | null
}

export interface ScanResult {
  total: number
  processed: number
  failed: number
  removed: number
  renamed: number
}

export interface ScanCallbacks {
  isCancelled: () => boolean
  onProgress: (processed: number, total: number, currentFile: string | null) => void
}

export class DocumentScanner {
  constructor(
    private readonly db: AppDatabase,
    private readonly documents: DocumentRepository
  ) {}

  async scanFolder(folderId: number, root: string, callbacks: ScanCallbacks): Promise<ScanResult> {
    const paths = await this.collectFiles(root, callbacks.isCancelled)
    const total = paths.length
    callbacks.onProgress(0, total, null)
    const scanned: ScanFileResult[] = []
    for (let index = 0; index < paths.length; index += 1) {
      if (callbacks.isCancelled()) throw new ScanCancelledError()
      const filePath = paths[index]!
      callbacks.onProgress(index, total, basename(filePath))
      scanned.push(await this.readOne(filePath))
    }
    callbacks.onProgress(total, total, null)
    if (callbacks.isCancelled()) throw new ScanCancelledError()
    return this.reconcile(folderId, scanned)
  }

  private async collectFiles(root: string, isCancelled: () => boolean): Promise<string[]> {
    const result: string[] = []
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (isCancelled()) throw new ScanCancelledError()
      if (depth > MAX_SCAN_DEPTH) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (isCancelled()) throw new ScanCancelledError()
        if (entry.isSymbolicLink()) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue
          await visit(fullPath, depth + 1)
        } else if (entry.isFile() && isSupportedFile(entry.name)) {
          result.push(fullPath)
          if (result.length > MAX_SCAN_FILES) {
            throw new AppError(
              'SCAN_TOO_LARGE',
              `目录中受支持的文件超过 ${MAX_SCAN_FILES} 个。请选择更小的资料目录，或先整理目录结构。`
            )
          }
        }
      }
    }
    await visit(root, 0)
    return result
  }

  private async readOne(filePath: string): Promise<ScanFileResult> {
    const base = basename(filePath)
    const info = await stat(filePath)
    if (info.size > MAX_PARSE_BYTES) {
      return {
        path: filePath,
        name: base,
        size: info.size,
        hash: '',
        modifiedAt: info.mtime.toISOString(),
        content: null,
        error: `文件超过 ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)} MB 解析上限，未建立索引。`
      }
    }
    try {
      const { readFile } = await import('node:fs/promises')
      const buffer = await readFile(filePath)
      const content = decodeBuffer(buffer)
      return {
        path: filePath,
        name: base,
        size: buffer.length,
        hash: sha256Hex(buffer),
        modifiedAt: info.mtime.toISOString(),
        content,
        error: null
      }
    } catch (error) {
      return {
        path: filePath,
        name: base,
        size: info.size,
        hash: '',
        modifiedAt: info.mtime.toISOString(),
        content: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private reconcile(folderId: number, scanned: ScanFileResult[]): ScanResult {
    return this.db.transaction(() => {
      const existing = this.documents.listForFolder(folderId)
      const existingByPath = new Map<string, DocumentRecord>()
      for (const doc of existing) existingByPath.set(doc.source_path.toLowerCase(), doc)
      const seenPaths = new Set<string>()
      const newFiles: ScanFileResult[] = []
      let failed = 0
      const now = new Date().toISOString()

      for (const file of scanned) {
        const key = file.path.toLowerCase()
        seenPaths.add(key)
        if (file.error) failed += 1
        const current = existingByPath.get(key)
        if (!current) {
          newFiles.push(file)
          continue
        }
        if (file.hash && current.file_hash === file.hash && file.content !== null) {
          this.db.run(
            'UPDATE documents SET file_size = ?, last_modified_at = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?',
            file.size,
            file.modifiedAt,
            now,
            now,
            current.id
          )
          if (current.indexing_status === 'failed') {
            this.db.run(
              "UPDATE documents SET indexing_status = 'pending', error_message = NULL WHERE id = ?",
              current.id
            )
          }
          continue
        }
        if (file.content === null) {
          this.documents.updateFile(current.id, {
            hash: file.hash || current.file_hash,
            size: file.size,
            modifiedAt: file.modifiedAt,
            content: null,
            status: 'failed',
            errorMessage: file.error ?? '无法解析文件内容。'
          })
          continue
        }
        this.documents.updateFile(current.id, {
          hash: file.hash,
          size: file.size,
          modifiedAt: file.modifiedAt,
          content: file.content,
          status: 'pending',
          errorMessage: null
        })
        upsertFts(this.db, 'document', current.id, file.name, file.content)
      }

      const missing = existing.filter((doc) => !seenPaths.has(doc.source_path.toLowerCase()))
      const candidateByHash = new Map<string, ScanFileResult[]>()
      for (const file of newFiles) {
        if (!file.hash) continue
        const list = candidateByHash.get(file.hash) ?? []
        list.push(file)
        candidateByHash.set(file.hash, list)
      }
      const used = new Set<string>()
      let renamed = 0
      const stillMissing: DocumentRecord[] = []
      for (const doc of missing) {
        const candidates = candidateByHash.get(doc.file_hash) ?? []
        const candidate = candidates.find((item) => !used.has(item.path))
        if (candidate) {
          used.add(candidate.path)
          this.documents.renameFile(doc.id, candidate.path, candidate.name, candidate.modifiedAt)
          this.db.run(
            'UPDATE documents SET file_size = ?, last_scanned_at = ? WHERE id = ?',
            candidate.size,
            now,
            doc.id
          )
          if (candidate.content !== null) upsertFts(this.db, 'document', doc.id, candidate.name, candidate.content)
          renamed += 1
        } else {
          stillMissing.push(doc)
        }
      }
      for (const doc of stillMissing) this.documents.remove(doc.id)

      for (const file of newFiles) {
        if (used.has(file.path)) continue
        const status = file.content === null ? 'failed' : 'pending'
        const id = this.documents.insertFile({
          folderId,
          sourcePath: file.path,
          fileName: file.name,
          extension: extensionOf(file.name) || extname(file.name),
          hash: file.hash,
          size: file.size,
          modifiedAt: file.modifiedAt,
          parserVersion: PARSER_VERSION,
          content: file.content,
          status,
          errorMessage: file.error
        })
        if (file.content !== null) upsertFts(this.db, 'document', id, file.name, file.content)
      }
      return {
        total: scanned.length,
        processed: scanned.length,
        failed,
        removed: stillMissing.length,
        renamed
      }
    })
  }
}

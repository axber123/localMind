import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type { DocumentRepository } from '../db/documentRepository'
import type { Note, NoteCreateInput, NoteSaveInput, NoteSaveResult } from '../../shared/types'
import { assertPathInside, canonicalExistingPath, sha256Hex } from '../security/paths'
import { removeFts, searchFts, upsertFts } from './fts'

interface NoteRow {
  id: number
  title: string
  file_path: string
  content_hash: string
  created_at: string
  updated_at: string
  last_opened_at: string | null
}

const MAX_NOTE_BYTES = 2 * 1024 * 1024

export class NoteService {
  private onSaved: ((documentId: number) => void) | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly documents: DocumentRepository,
    private readonly notesRoot: string,
    private readonly trashFile: (path: string) => Promise<void>
  ) {}

  setSaveListener(listener: (documentId: number) => void): void {
    this.onSaved = listener
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.notesRoot, { recursive: true })
  }

  private noteFilePath(id: number): string {
    return join(this.notesRoot, `${id}.md`)
  }

  private documentForNote(noteId: number) {
    return this.documents.findDocumentForNote(noteId)
  }

  private async readNoteContent(row: NoteRow): Promise<string> {
    let canonical: string
    try {
      canonical = canonicalExistingPath(row.file_path)
    } catch {
      throw new AppError('NOTE_FILE_MISSING', '笔记文件不存在，可能已被外部移动或删除。')
    }
    assertPathInside(this.notesRoot, canonical)
    const info = await stat(canonical)
    if (info.size > MAX_NOTE_BYTES) {
      throw new AppError('NOTE_TOO_LARGE', '笔记超过 2 MB，无法在编辑器中打开。')
    }
    return readFile(canonical, 'utf8')
  }

  private titleFor(content: string): string {
    const heading = content.match(/^#{1,3}\s+(.+)$/m)?.[1]
    const line = heading ?? content.split('\n').find((item) => item.trim().length > 0)
    const title = (line ?? '未命名笔记')
      .replace(/^#+\s*/, '')
      .replace(/[*_`>#]/g, '')
      .trim()
      .slice(0, 80)
    return title || '未命名笔记'
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  }

  private toNote(row: NoteRow, content: string): Note {
    const doc = this.documentForNote(row.id)
    return {
      id: row.id,
      documentId: doc?.id ?? null,
      title: row.title,
      content,
      revision: row.content_hash,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      indexingStatus: doc?.indexing_status ?? 'pending',
      errorMessage: doc?.error_message ?? null,
      indexedAt: doc?.indexed_at ?? null
    }
  }

  async list(query: string): Promise<Note[]> {
    const term = query.trim()
    let ids: number[] = []
    if (term) {
      ids = searchFts(this.db, term, ['note'], 500).map((hit) => hit.entityId)
    }
    const rows = term
      ? this.db.all<NoteRow>(
          `SELECT * FROM notes WHERE title LIKE ? OR id IN (${ids.length ? ids.map(() => '?').join(', ') : 'NULL'})
           ORDER BY updated_at DESC LIMIT 300`,
          `%${term}%`,
          ...ids
        )
      : this.db.all<NoteRow>('SELECT * FROM notes ORDER BY updated_at DESC LIMIT 300')
    return rows.map((row) => this.toNote(row, ''))
  }

  async get(id: number): Promise<Note> {
    const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id)
    if (!row) throw new AppError('NOTE_NOT_FOUND', '笔记不存在或已被删除。')
    const content = await this.readNoteContent(row)
    this.db.run('UPDATE notes SET last_opened_at = ? WHERE id = ?', nowIso(), id)
    return this.toNote(row, content)
  }

  async create(input: NoteCreateInput = {}): Promise<Note> {
    await this.ensureRoot()
    const id = randomUUID()
    const filePath = join(this.notesRoot, `${id}.md`)
    const content = input.content ?? '# 新笔记\n\n'
    const title = (input.title?.trim() || this.titleFor(content)).slice(0, 80)
    const hash = sha256Hex(content)
    const now = nowIso()
    try {
      await this.writeAtomic(filePath, content)
      const noteId = this.db.transaction(() => {
        const result = this.db.run(
          'INSERT INTO notes(title, file_path, content_hash, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)',
          title,
          filePath,
          hash,
          now,
          now,
          now
        )
        this.documents.insertNote({
          noteId: result.lastInsertRowid,
          sourcePath: filePath,
          fileName: `${title}.md`,
          hash,
          size: Buffer.byteLength(content, 'utf8'),
          modifiedAt: now,
          content,
          status: 'pending'
        })
        upsertFts(this.db, 'note', result.lastInsertRowid, title, content)
        return result.lastInsertRowid
      })
      const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', noteId)!
      return this.toNote(row, content)
    } catch (error) {
      await unlink(filePath).catch(() => undefined)
      throw error
    }
  }

  async save(input: NoteSaveInput): Promise<NoteSaveResult> {
    const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', input.id)
    if (!row) throw new AppError('NOTE_NOT_FOUND', '笔记不存在或已被删除。')
    if (Buffer.byteLength(input.content, 'utf8') > MAX_NOTE_BYTES) {
      throw new AppError('NOTE_TOO_LARGE', '笔记超过 2 MB，无法保存。')
    }
    const current = await this.readNoteContent(row)
    const currentHash = sha256Hex(current)
    if (currentHash !== input.expectedRevision) {
      throw new AppError('NOTE_CONFLICT', '笔记文件已被其他操作修改，请重新载入后再保存，以免覆盖新内容。')
    }
    const title = this.titleFor(input.content)
    const hash = sha256Hex(input.content)
    const now = nowIso()
    const canonical = canonicalExistingPath(row.file_path)
    assertPathInside(this.notesRoot, canonical)
    await this.writeAtomic(canonical, input.content)
    const documentId = this.db.transaction(() => {
      this.db.run(
        'UPDATE notes SET title = ?, content_hash = ?, updated_at = ? WHERE id = ?',
        title,
        hash,
        now,
        input.id
      )
      const doc = this.documentForNote(input.id)
      let documentId: number
      if (!doc) {
        documentId = this.documents.insertNote({
          noteId: input.id,
          sourcePath: canonical,
          fileName: `${title}.md`,
          hash,
          size: Buffer.byteLength(input.content, 'utf8'),
          modifiedAt: now,
          content: input.content,
          status: 'pending'
        })
      } else {
        documentId = doc.id
        this.documents.updateNoteDocument(doc.id, {
          sourcePath: canonical,
          fileName: `${title}.md`,
          hash,
          size: Buffer.byteLength(input.content, 'utf8'),
          modifiedAt: now,
          content: input.content
        })
      }
      upsertFts(this.db, 'note', input.id, title, input.content)
      return documentId
    })
    this.onSaved?.(documentId)
    return { id: input.id, revision: hash, updatedAt: now, savedAt: now }
  }

  async remove(id: number): Promise<void> {
    const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id)
    if (!row) throw new AppError('NOTE_NOT_FOUND', '笔记不存在或已被删除。')
    const doc = this.documentForNote(id)
    let canonical: string | null = null
    try {
      canonical = canonicalExistingPath(row.file_path)
      assertPathInside(this.notesRoot, canonical)
    } catch {
      canonical = null
    }
    if (canonical) {
      try {
        await this.trashFile(canonical)
      } catch (error) {
        throw new AppError(
          'NOTE_TRASH_FAILED',
          '无法把笔记移入系统回收站，笔记没有被删除。请检查文件是否被占用。',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    this.db.transaction(() => {
      if (doc) this.documents.remove(doc.id)
      removeFts(this.db, 'note', id)
      this.db.run('DELETE FROM notes WHERE id = ?', id)
    })
  }
}

import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type { Folder, FolderInput, Tag } from '../../shared/types'
import { removeFts } from './fts'

interface FolderRow {
  id: number
  name: string
  path: string
  note: string | null
  is_missing: number
  last_checked_at: string | null
  created_at: string
  updated_at: string
  document_count: number
  indexed_count: number
  failed_count: number
}

export class FolderService {
  constructor(private readonly db: AppDatabase) {}

  async list(): Promise<Folder[]> {
    const rows = this.db.all<FolderRow>(
      `SELECT f.*,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file') AS document_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file' AND d.indexing_status = 'indexed') AS indexed_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file' AND d.indexing_status = 'failed') AS failed_count
       FROM folders f ORDER BY f.created_at ASC`
    )
    const tags = this.tagsForFolders(rows.map((row) => row.id))
    const result: Folder[] = []
    for (const row of rows) {
      let missing = row.is_missing === 1
      try {
        const info = await stat(row.path)
        missing = !info.isDirectory()
      } catch {
        missing = true
      }
      if (missing !== (row.is_missing === 1)) {
        this.db.run('UPDATE folders SET is_missing = ?, last_checked_at = ? WHERE id = ?', missing ? 1 : 0, nowIso(), row.id)
      }
      result.push(this.map(row, tags.get(row.id) ?? [], missing))
    }
    return result
  }

  get(id: number): Folder {
    const row = this.db.get<FolderRow>(
      `SELECT f.*,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file') AS document_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file' AND d.indexing_status = 'indexed') AS indexed_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.kind = 'file' AND d.indexing_status = 'failed') AS failed_count
       FROM folders f WHERE f.id = ?`,
      id
    )
    if (!row) throw new AppError('FOLDER_NOT_FOUND', '文件夹不存在或已被移除。')
    return this.map(row, this.tagsForFolders([id]).get(id) ?? [], row.is_missing === 1)
  }

  add(canonicalPath: string, displayName?: string): Folder {
    const existing = this.db.get<{ id: number }>('SELECT id FROM folders WHERE path = ? COLLATE NOCASE', canonicalPath)
    if (existing) throw new AppError('FOLDER_EXISTS', '这个文件夹已经添加过了。')
    const now = nowIso()
    const result = this.db.run(
      'INSERT INTO folders(name, path, note, is_missing, last_checked_at, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?)',
      displayName?.trim() || basename(canonicalPath) || canonicalPath,
      canonicalPath,
      now,
      now,
      now
    )
    return this.get(result.lastInsertRowid)
  }

  update(id: number, input: FolderInput): Folder {
    this.db.transaction(() => {
      const existing = this.db.get<{ id: number }>('SELECT id FROM folders WHERE id = ?', id)
      if (!existing) throw new AppError('FOLDER_NOT_FOUND', '文件夹不存在或已被移除。')
      this.db.run(
        'UPDATE folders SET note = ?, updated_at = ? WHERE id = ?',
        input.note?.trim() || null,
        nowIso(),
        id
      )
      this.setTags(id, input.tags)
    })
    return this.get(id)
  }

  async checkById(id: number): Promise<Folder> {
    const folder = this.get(id)
    let missing = false
    try {
      const info = await stat(folder.path)
      missing = !info.isDirectory()
    } catch {
      missing = true
    }
    this.db.run('UPDATE folders SET is_missing = ?, last_checked_at = ? WHERE id = ?', missing ? 1 : 0, nowIso(), id)
    return this.get(id)
  }

  markMissing(id: number): void {
    this.db.run('UPDATE folders SET is_missing = 1, last_checked_at = ? WHERE id = ?', nowIso(), id)
  }

  reauthorize(id: number, canonicalPath: string, displayName?: string): Folder {
    this.db.transaction(() => {
      const existing = this.db.get<{ id: number }>('SELECT id FROM folders WHERE id = ?', id)
      if (!existing) throw new AppError('FOLDER_NOT_FOUND', '文件夹不存在或已被移除。')
      const duplicate = this.db.get<{ id: number }>(
        'SELECT id FROM folders WHERE path = ? COLLATE NOCASE AND id <> ?',
        canonicalPath,
        id
      )
      if (duplicate) throw new AppError('FOLDER_EXISTS', '这个文件夹已被另一个资料夹使用。')
      this.removeDocumentsOfFolder(id)
      this.db.run(
        'UPDATE folders SET path = ?, name = ?, is_missing = 0, last_checked_at = ?, updated_at = ? WHERE id = ?',
        canonicalPath,
        displayName?.trim() || basename(canonicalPath) || canonicalPath,
        nowIso(),
        nowIso(),
        id
      )
    })
    return this.get(id)
  }

  /** Removes only LocalMind's index for this folder. Original files are never touched. */
  removeIndex(id: number): void {
    this.db.transaction(() => {
      const existing = this.db.get<{ id: number }>('SELECT id FROM folders WHERE id = ?', id)
      if (!existing) throw new AppError('FOLDER_NOT_FOUND', '文件夹不存在或已被移除。')
      this.removeDocumentsOfFolder(id)
      this.db.run('DELETE FROM folders WHERE id = ?', id)
    })
  }

  private removeDocumentsOfFolder(folderId: number): void {
    const docs = this.db.all<{ id: number }>('SELECT id FROM documents WHERE folder_id = ? AND kind = ?', folderId, 'file')
    for (const doc of docs) removeFts(this.db, 'document', doc.id)
    this.db.run('DELETE FROM documents WHERE folder_id = ? AND kind = ?', folderId, 'file')
  }

  tags(): Tag[] {
    return this.db.all<{ id: number; name: string; color: string }>('SELECT id, name, color FROM tags ORDER BY name').map(
      (row) => ({ id: row.id, name: row.name, color: row.color })
    )
  }

  private tagsForFolders(ids: number[]): Map<number, Tag[]> {
    const map = new Map<number, Tag[]>()
    if (ids.length === 0) return map
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.all<{ folder_id: number; id: number; name: string; color: string }>(
      `SELECT ft.folder_id, t.id, t.name, t.color
       FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id
       WHERE ft.folder_id IN (${placeholders}) ORDER BY t.name`,
      ...ids
    )
    for (const row of rows) {
      const list = map.get(row.folder_id) ?? []
      list.push({ id: row.id, name: row.name, color: row.color })
      map.set(row.folder_id, list)
    }
    return map
  }

  private setTags(folderId: number, tagNames: string[]): void {
    this.db.run('DELETE FROM folder_tags WHERE folder_id = ?', folderId)
    const unique = [...new Set(tagNames.map((name) => name.trim()).filter(Boolean))].slice(0, 12)
    for (const name of unique) {
      let tag = this.db.get<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE', name)
      if (!tag) {
        const result = this.db.run(
          'INSERT INTO tags(name, color, created_at) VALUES (?, ?, ?)',
          name,
          '#64748b',
          nowIso()
        )
        tag = { id: result.lastInsertRowid }
      }
      this.db.run('INSERT OR IGNORE INTO folder_tags(folder_id, tag_id) VALUES (?, ?)', folderId, tag.id)
    }
  }

  private map(row: FolderRow, tags: Tag[], missing: boolean): Folder {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      note: row.note,
      isMissing: missing,
      lastCheckedAt: row.last_checked_at,
      tags,
      documentCount: row.document_count,
      indexedCount: row.indexed_count,
      failedCount: row.failed_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

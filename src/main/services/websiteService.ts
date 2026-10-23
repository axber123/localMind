import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type { Tag, Website, WebsiteGroup, WebsiteInput } from '../../shared/types'

interface WebsiteRow {
  id: number
  name: string
  url: string
  icon: string | null
  description: string | null
  group_id: number | null
  group_name: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

const TAG_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444']
function tagColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TAG_COLORS[hash % TAG_COLORS.length]!
}

export class WebsiteService {
  constructor(private readonly db: AppDatabase) {}

  list(filters: { query?: string; groupId?: number | null; tagId?: number | null } = {}): Website[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.query?.trim()) {
      const q = `%${filters.query.trim()}%`
      where.push('(w.name LIKE ? OR w.url LIKE ? OR w.description LIKE ?)')
      params.push(q, q, q)
    }
    if (typeof filters.groupId === 'number') {
      where.push('w.group_id = ?')
      params.push(filters.groupId)
    }
    if (typeof filters.tagId === 'number') {
      where.push('EXISTS (SELECT 1 FROM website_tags wt WHERE wt.website_id = w.id AND wt.tag_id = ?)')
      params.push(filters.tagId)
    }
    const rows = this.db.all<WebsiteRow>(
      `SELECT w.*, g.name AS group_name
       FROM websites w LEFT JOIN website_groups g ON g.id = w.group_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.sort_order ASC, w.created_at ASC`,
      ...params
    )
    const tagsByWebsite = this.tagsForWebsites(rows.map((row) => row.id))
    return rows.map((row) => this.map(row, tagsByWebsite.get(row.id) ?? []))
  }

  get(id: number): Website {
    const row = this.db.get<WebsiteRow>(
      `SELECT w.*, g.name AS group_name
       FROM websites w LEFT JOIN website_groups g ON g.id = w.group_id
       WHERE w.id = ?`,
      id
    )
    if (!row) throw new AppError('WEBSITE_NOT_FOUND', '网站不存在或已被删除。')
    return this.map(row, this.tagsForWebsites([id]).get(id) ?? [])
  }

  create(input: WebsiteInput): Website {
    return this.db.transaction(() => {
      const now = nowIso()
      const order = this.db.get<{ next: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM websites')?.next ?? 0
      const result = this.db.run(
        `INSERT INTO websites(name, url, icon, description, group_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.name.trim(),
        input.url.trim(),
        input.icon ?? null,
        input.description?.trim() || null,
        input.groupId ?? null,
        order,
        now,
        now
      )
      this.setTags(result.lastInsertRowid, input.tags)
      return this.get(result.lastInsertRowid)
    })
  }

  update(id: number, input: WebsiteInput): Website {
    return this.db.transaction(() => {
      const existing = this.db.get<{ id: number }>('SELECT id FROM websites WHERE id = ?', id)
      if (!existing) throw new AppError('WEBSITE_NOT_FOUND', '网站不存在或已被删除。')
      this.db.run(
        `UPDATE websites
         SET name = ?, url = ?, icon = ?, description = ?, group_id = ?, updated_at = ?
         WHERE id = ?`,
        input.name.trim(),
        input.url.trim(),
        input.icon ?? null,
        input.description?.trim() || null,
        input.groupId ?? null,
        nowIso(),
        id
      )
      this.setTags(id, input.tags)
      return this.get(id)
    })
  }

  remove(id: number): void {
    const result = this.db.run('DELETE FROM websites WHERE id = ?', id)
    if (result.changes === 0) throw new AppError('WEBSITE_NOT_FOUND', '网站不存在或已被删除。')
  }

  reorder(orderedIds: number[]): void {
    if (orderedIds.length === 0) return
    this.db.transaction(() => {
      const now = nowIso()
      orderedIds.forEach((id, index) => {
        this.db.run('UPDATE websites SET sort_order = ?, updated_at = ? WHERE id = ?', index, now, id)
      })
    })
  }

  groups(): WebsiteGroup[] {
    return this.db.all<{ id: number; name: string; color: string; sort_order: number }>(
      'SELECT * FROM website_groups ORDER BY sort_order, name'
    ).map((row) => ({ id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order }))
  }

  createGroup(name: string, color: string): WebsiteGroup {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError('INVALID_GROUP', '分组名称不能为空。')
    const now = nowIso()
    try {
      const order = this.db.get<{ next: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM website_groups'
      )?.next ?? 0
      const result = this.db.run(
        'INSERT INTO website_groups(name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        trimmed,
        color,
        order,
        now,
        now
      )
      return { id: result.lastInsertRowid, name: trimmed, color, sortOrder: order }
    } catch {
      throw new AppError('GROUP_EXISTS', '同名分组已存在。')
    }
  }

  updateGroup(id: number, name: string, color: string): WebsiteGroup {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError('INVALID_GROUP', '分组名称不能为空。')
    try {
      const result = this.db.run(
        'UPDATE website_groups SET name = ?, color = ?, updated_at = ? WHERE id = ?',
        trimmed,
        color,
        nowIso(),
        id
      )
      if (result.changes === 0) throw new AppError('GROUP_NOT_FOUND', '分组不存在。')
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('GROUP_EXISTS', '同名分组已存在。')
    }
    const row = this.db.get<{ id: number; name: string; color: string; sort_order: number }>(
      'SELECT * FROM website_groups WHERE id = ?',
      id
    )
    return { id: row!.id, name: row!.name, color: row!.color, sortOrder: row!.sort_order }
  }

  removeGroup(id: number): void {
    this.db.run('DELETE FROM website_groups WHERE id = ?', id)
  }

  tags(): Tag[] {
    return this.db.all<{ id: number; name: string; color: string }>('SELECT id, name, color FROM tags ORDER BY name').map(
      (row) => ({ id: row.id, name: row.name, color: row.color })
    )
  }

  private tagsForWebsites(ids: number[]): Map<number, Tag[]> {
    const map = new Map<number, Tag[]>()
    if (ids.length === 0) return map
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.all<{ website_id: number; id: number; name: string; color: string }>(
      `SELECT wt.website_id, t.id, t.name, t.color
       FROM website_tags wt JOIN tags t ON t.id = wt.tag_id
       WHERE wt.website_id IN (${placeholders}) ORDER BY t.name`,
      ...ids
    )
    for (const row of rows) {
      const list = map.get(row.website_id) ?? []
      list.push({ id: row.id, name: row.name, color: row.color })
      map.set(row.website_id, list)
    }
    return map
  }

  private setTags(websiteId: number, tagNames: string[]): void {
    this.db.run('DELETE FROM website_tags WHERE website_id = ?', websiteId)
    const unique = [...new Set(tagNames.map((name) => name.trim()).filter(Boolean))].slice(0, 12)
    for (const name of unique) {
      let tag = this.db.get<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE', name)
      if (!tag) {
        const result = this.db.run('INSERT INTO tags(name, color, created_at) VALUES (?, ?, ?)', name, tagColor(name), nowIso())
        tag = { id: result.lastInsertRowid }
      }
      this.db.run('INSERT OR IGNORE INTO website_tags(website_id, tag_id) VALUES (?, ?)', websiteId, tag.id)
    }
  }

  private map(row: WebsiteRow, tags: Tag[]): Website {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      icon: row.icon,
      description: row.description,
      groupId: row.group_id,
      groupName: row.group_name,
      sortOrder: row.sort_order,
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

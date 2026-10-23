import type { AppDatabase } from '../db/database'

export type FtsEntityType = 'document' | 'note' | 'chat'

/** FTS5 unicode61 treats a whole CJK sentence as one token. Spacing every Han
 * character makes Chinese substring/phrase matching work without an extension. */
export function normalizeCjkForIndex(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/(\p{Script=Han})/gu, ' $1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

export function buildFtsQuery(input: string): string {
  const groups: string[] = []
  const runRegex = /[\p{Script=Han}]+|[A-Za-z0-9_][A-Za-z0-9_+#.\-]*/gu
  for (const match of input.matchAll(runRegex)) {
    const value = match[0]
    if (/\p{Script=Han}/u.test(value)) {
      const chars = Array.from(value)
      if (chars.length === 1) {
        groups.push(quote(chars[0]!))
      } else if (chars.length === 2) {
        groups.push(quote(chars.join(' ')))
      } else {
        const bigrams: string[] = []
        for (let i = 0; i < chars.length - 1; i += 1) {
          bigrams.push(quote(`${chars[i]} ${chars[i + 1]}`))
        }
        groups.push(`(${bigrams.join(' OR ')})`)
      }
    } else if (value.length > 0) {
      groups.push(`${quote(value.toLowerCase())}*`)
    }
  }
  return groups.join(' AND ')
}

export function upsertFts(
  db: AppDatabase,
  entityType: FtsEntityType,
  entityId: number,
  title: string,
  body: string
): void {
  db.run('DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?', entityType, String(entityId))
  const bodyRaw = body.replace(/\u0000/g, '')
  db.run(
    'INSERT INTO search_fts(entity_type, entity_id, title, body, body_raw) VALUES (?, ?, ?, ?, ?)',
    entityType,
    String(entityId),
    normalizeCjkForIndex(title),
    normalizeCjkForIndex(`${title}\n${bodyRaw}`),
    bodyRaw
  )
}

export function removeFts(db: AppDatabase, entityType: FtsEntityType, entityId: number): void {
  db.run('DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?', entityType, String(entityId))
}

export function makeSnippet(raw: string, query: string, length = 180): string | null {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const terms = Array.from(query.matchAll(/[\p{Script=Han}]+|[A-Za-z0-9_+#.\-]+/gu)).map((m) => m[0])
  let index = -1
  for (const term of terms) {
    index = clean.toLowerCase().indexOf(term.toLowerCase())
    if (index >= 0) break
  }
  if (index < 0) return clean.slice(0, length) + (clean.length > length ? '…' : '')
  const start = Math.max(0, index - Math.floor(length / 3))
  const end = Math.min(clean.length, start + length)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

export interface FtsHit {
  entityType: FtsEntityType
  entityId: number
  title: string
  bodyRaw: string
  score: number
}

export function searchFts(db: AppDatabase, query: string, types: FtsEntityType[], limit: number): FtsHit[] {
  const match = buildFtsQuery(query)
  if (!match) return []
  const placeholders = types.map(() => '?').join(', ')
  try {
    const rows = db.all<{ entity_type: FtsEntityType; entity_id: string; title: string; body_raw: string; rank: number }>(
      `SELECT entity_type, entity_id, title, body_raw, bm25(search_fts) AS rank
       FROM search_fts
       WHERE search_fts MATCH ? AND entity_type IN (${placeholders})
       ORDER BY rank
       LIMIT ?`,
      match,
      ...types,
      limit
    )
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: Number(row.entity_id),
      title: row.title,
      bodyRaw: row.body_raw,
      score: row.rank
    }))
  } catch {
    return []
  }
}

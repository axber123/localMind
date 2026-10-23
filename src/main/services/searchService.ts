import type { AppDatabase } from '../db/database'
import type { SearchHit, SearchResults } from '../../shared/types'
import { makeSnippet, searchFts } from './fts'

export class SearchService {
  constructor(private readonly db: AppDatabase) {}

  global(rawQuery: string): SearchResults {
    const query = rawQuery.trim()
    if (!query) return { query: '', groups: [], total: 0 }
    const like = `%${query}%`
    const websiteHits = this.db
      .all<{ id: number; name: string; url: string; description: string | null }>(
        `SELECT DISTINCT w.id, w.name, w.url, w.description
         FROM websites w
         LEFT JOIN website_tags wt ON wt.website_id = w.id
         LEFT JOIN tags t ON t.id = wt.tag_id
         WHERE w.name LIKE ? OR w.url LIKE ? OR w.description LIKE ? OR t.name LIKE ?
         ORDER BY w.sort_order LIMIT 10`,
        like,
        like,
        like,
        like
      )
      .map<SearchHit>((row) => ({
        type: 'website',
        id: row.id,
        title: row.name,
        subtitle: row.url,
        snippet: row.description,
        meta: '网站'
      }))

    const folderHits = this.db
      .all<{ id: number; name: string; path: string; note: string | null }>(
        `SELECT DISTINCT f.id, f.name, f.path, f.note
         FROM folders f
         LEFT JOIN folder_tags ft ON ft.folder_id = f.id
         LEFT JOIN tags t ON t.id = ft.tag_id
         WHERE f.name LIKE ? OR f.path LIKE ? OR f.note LIKE ? OR t.name LIKE ?
         ORDER BY f.updated_at DESC LIMIT 10`,
        like,
        like,
        like,
        like
      )
      .map<SearchHit>((row) => ({
        type: 'folder',
        id: row.id,
        title: row.name,
        subtitle: row.path,
        snippet: row.note,
        meta: '资料夹'
      }))

    const docFts = searchFts(this.db, query, ['document'], 20)
    const docIds = docFts.map((hit) => hit.entityId)
    const docs = docIds.length
      ? this.db.all<{ id: number; file_name: string; source_path: string; content_text: string | null }>(
          `SELECT id, file_name, source_path, content_text FROM documents
           WHERE id IN (${docIds.map(() => '?').join(', ')}) AND kind = 'file'`,
          ...docIds
        )
      : this.db.all<{ id: number; file_name: string; source_path: string; content_text: string | null }>(
          `SELECT id, file_name, source_path, content_text FROM documents
           WHERE kind = 'file' AND (file_name LIKE ? OR source_path LIKE ?) LIMIT 20`,
          like,
          like
        )
    const documentHits = docs.map<SearchHit>((row) => ({
      type: 'document',
      id: row.id,
      title: row.file_name,
      subtitle: row.source_path,
      snippet: makeSnippet(row.content_text ?? '', query),
      meta: '文档'
    }))

    const noteFts = searchFts(this.db, query, ['note'], 20)
    const noteIds = noteFts.map((hit) => hit.entityId)
    const notes = noteIds.length
      ? this.db.all<{ id: number; title: string; content_hash: string }>(
          `SELECT id, title, content_hash FROM notes WHERE id IN (${noteIds.map(() => '?').join(', ')})`,
          ...noteIds
        )
      : this.db.all<{ id: number; title: string; content_hash: string }>(
          'SELECT id, title, content_hash FROM notes WHERE title LIKE ? LIMIT 20',
          like
        )
    const noteHits = notes.map<SearchHit>((row) => {
      const fts = noteFts.find((hit) => hit.entityId === row.id)
      return {
        type: 'note',
        id: row.id,
        title: row.title,
        subtitle: 'Markdown 笔记',
        snippet: fts ? makeSnippet(fts.bodyRaw, query) : null,
        meta: '笔记'
      }
    })

    const chatFts = searchFts(this.db, query, ['chat'], 30)
    const messageIds = chatFts.map((hit) => hit.entityId)
    const chatRows = messageIds.length
      ? this.db.all<{ id: number; title: string; content: string; chat_id: number }>(
          `SELECT m.id, c.title, m.content, m.chat_id
           FROM messages m JOIN chats c ON c.id = m.chat_id
           WHERE m.id IN (${messageIds.map(() => '?').join(', ')})
           ORDER BY m.created_at DESC LIMIT 20`,
          ...messageIds
        )
      : []
    const seenChats = new Set<number>()
    const chatHits: SearchHit[] = []
    for (const row of chatRows) {
      if (seenChats.has(row.chat_id)) continue
      seenChats.add(row.chat_id)
      chatHits.push({
        type: 'chat',
        id: row.chat_id,
        title: row.title,
        subtitle: '聊天记录',
        snippet: makeSnippet(row.content, query),
        meta: '对话'
      })
    }

    const groups = [
      { type: 'document' as const, label: '文档', hits: documentHits },
      { type: 'note' as const, label: '笔记', hits: noteHits },
      { type: 'folder' as const, label: '资料夹', hits: folderHits },
      { type: 'website' as const, label: '网站', hits: websiteHits },
      { type: 'chat' as const, label: '聊天记录', hits: chatHits }
    ].filter((group) => group.hits.length > 0)
    return {
      query,
      groups,
      total: groups.reduce((sum, group) => sum + group.hits.length, 0)
    }
  }
}

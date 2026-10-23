import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { upsertFts } from '../../src/main/services/fts'
import { SearchService } from '../../src/main/services/searchService'

describe('global search', () => {
  it('groups results from websites, folders, documents, notes and chat history', () => {
    const db = new AppDatabase(':memory:')
    db.run(`INSERT INTO website_groups(id, name, color, sort_order, created_at, updated_at) VALUES (1, '前端', '#6366f1', 0, '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO websites(id, name, url, group_id, sort_order, created_at, updated_at) VALUES (1, '闭包社区', 'https://closure.example', 1, 0, '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, '闭包资料', 'F:/docs', '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO documents(id, kind, folder_id, source_path, file_name, extension, file_hash, file_size, last_modified_at, parser_version, indexing_status, content_text, created_at, updated_at)
            VALUES (1, 'file', 1, 'F:/docs/closure.md', 'closure.md', '.md', 'hash', 20, '2024-01-01', 1, 'pending', '闭包与词法环境', '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO notes(id, title, file_path, content_hash, created_at, updated_at) VALUES (1, '闭包笔记', 'F:/notes/1.md', 'hash', '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO chats(id, title, mode, learning_mode, scope_json, created_at, updated_at) VALUES (1, '闭包讨论', 'general', 'free', '{}', '2024-01-01', '2024-01-01')`)
    db.run(`INSERT INTO messages(id, chat_id, role, content, status, citations_json, retrieval_json, created_at, updated_at)
            VALUES (1, 1, 'user', '闭包和词法环境有什么关系？', 'complete', '[]', '[]', '2024-01-01', '2024-01-01')`)
    upsertFts(db, 'document', 1, 'closure.md', '闭包与词法环境')
    upsertFts(db, 'note', 1, '闭包笔记', '闭包与词法环境')
    upsertFts(db, 'chat', 1, '闭包讨论', '闭包和词法环境有什么关系？')

    const results = new SearchService(db).global('闭包')
    expect(results.total).toBeGreaterThanOrEqual(5)
    const types = new Set(results.groups.flatMap((group) => group.hits.map((hit) => hit.type)))
    expect(types).toEqual(new Set(['website', 'folder', 'document', 'note', 'chat']))
    expect(results.groups.every((group) => group.hits.length > 0)).toBe(true)
    expect(new SearchService(db).global('完全不存在的词xyz').total).toBe(0)
    db.close()
  })
})

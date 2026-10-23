import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { DocumentRepository } from '../../src/main/db/documentRepository'
import { buildFtsQuery, normalizeCjkForIndex, removeFts, searchFts, upsertFts } from '../../src/main/services/fts'
import { MODEL_ID, PARSER_VERSION, chunkConfigVersion } from '../../src/main/indexing/indexConfig'

function setup() {
  const db = new AppDatabase(':memory:')
  const config = { modelId: MODEL_ID, configVersion: chunkConfigVersion(256, 48) }
  const repo = new DocumentRepository(db, () => config)
  db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, 'docs', 'F:/docs', '2024-01-01', '2024-01-01')`)
  const id = repo.insertFile({
    folderId: 1,
    sourcePath: 'F:/docs/closure.md',
    fileName: 'closure.md',
    extension: '.md',
    hash: 'abc',
    size: 20,
    modifiedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    content: 'JavaScript 的闭包与函数及其词法环境有关。',
    status: 'pending'
  })
  return { db, repo, id }
}

describe('FTS5 Chinese search', () => {
  it('normalizes CJK characters for unicode61 tokenization', () => {
    expect(normalizeCjkForIndex('闭包 environment')).toContain('闭 包')
    expect(buildFtsQuery('闭包')).toContain('闭 包')
  })

  it('finds a Chinese keyword inside a longer sentence', () => {
    const { db, id } = setup()
    upsertFts(db, 'document', id, 'closure.md', 'JavaScript 的闭包与函数及其词法环境有关。')
    const hits = searchFts(db, '闭包', ['document'], 10)
    expect(hits.some((hit) => hit.entityId === id)).toBe(true)
    db.close()
  })

  it('supports multi-character Chinese queries and removal', () => {
    const { db, id } = setup()
    upsertFts(db, 'document', id, 'closure.md', 'JavaScript 的闭包与函数及其词法环境有关。')
    expect(searchFts(db, '词法环境', ['document'], 10).length).toBeGreaterThan(0)
    removeFts(db, 'document', id)
    expect(searchFts(db, '闭包', ['document'], 10)).toEqual([])
    db.close()
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { DocumentRepository } from '../../src/main/db/documentRepository'
import { WebsiteService } from '../../src/main/services/websiteService'
import { NoteService } from '../../src/main/services/noteService'
import { MODEL_ID, chunkConfigVersion } from '../../src/main/indexing/indexConfig'

const tempDirs: string[] = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'localmind-db-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const config = { modelId: MODEL_ID, configVersion: chunkConfigVersion(256, 48) }

describe('SQLite persistence', () => {
  it('persists websites and tags after reopening the database', async () => {
    const dir = await tempDir()
    const path = join(dir, 'localmind.db')
    const first = new AppDatabase(path)
    const service = new WebsiteService(first)
    const group = service.createGroup('前端', '#6366f1')
    service.create({ name: 'MDN', url: 'https://developer.mozilla.org', tags: ['文档', '前端'], groupId: group.id })
    service.create({ name: 'Loose', url: 'https://example.com', tags: [] })
    first.close()

    const second = new AppDatabase(path)
    const websiteService = new WebsiteService(second)
    const websites = websiteService.list()
    expect(websites).toHaveLength(2)
    expect(websites.find((site) => site.name === 'MDN')?.tags.map((tag) => tag.name).sort()).toEqual(['前端', '文档'])
    expect(websiteService.list({ groupId: null })).toHaveLength(2)
    expect(websiteService.list({ groupId: group.id })).toHaveLength(1)
    second.close()
  })

  it('persists note files and rejects stale autosave revisions', async () => {
    const dir = await tempDir()
    const db = new AppDatabase(join(dir, 'localmind.db'))
    const repository = new DocumentRepository(db, () => config)
    const notesRoot = join(dir, 'notes')
    const notes = new NoteService(db, repository, notesRoot, async () => undefined)
    const note = await notes.create({ title: '闭包', content: '# 闭包\n\n词法环境。' })
    const saved = await notes.save({ id: note.id, content: '# 闭包\n\n词法环境与函数。', expectedRevision: note.revision })
    expect(saved.revision).not.toBe(note.revision)
    await expect(
      notes.save({ id: note.id, content: '# 闭包\n\n错误覆盖', expectedRevision: note.revision })
    ).rejects.toMatchObject({ code: 'NOTE_CONFLICT' })
    const reopened = await notes.get(note.id)
    expect(reopened.content).toContain('词法环境与函数')
    const doc = db.get<{ source_path: string }>('SELECT source_path FROM documents WHERE note_id = ?', note.id)
    expect(doc?.source_path).toBeTruthy()
    expect(await readFile(doc!.source_path, 'utf8')).toContain('词法环境与函数')
    db.close()
  })
})

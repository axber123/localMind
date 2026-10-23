import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { FolderService } from '../../src/main/services/folderService'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('FolderService safe removal', () => {
  it('removes only the index and never deletes original files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-folder-'))
    dirs.push(dir)
    const original = join(dir, 'keep-me.md')
    await writeFile(original, '# important', 'utf8')
    const db = new AppDatabase(join(dir, 'app.db'))
    const folders = new FolderService(db)
    const folder = folders.add(dir)
    await folders.checkById(folder.id)
    folders.removeIndex(folder.id)
    expect(existsSync(original)).toBe(true)
    expect(await folders.list()).toEqual([])
    db.close()
  })

  it('updates notes and tags without changing the folder path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-folder-'))
    dirs.push(dir)
    const db = new AppDatabase(join(dir, 'app.db'))
    const folders = new FolderService(db)
    const folder = folders.add(dir)
    const updated = folders.update(folder.id, { note: '重点资料', tags: ['JavaScript', '面试'] })
    expect(updated.note).toBe('重点资料')
    expect(updated.tags.map((tag) => tag.name).sort()).toEqual(['JavaScript', '面试'])
    expect(updated.path).toBe(folder.path)
    db.close()
  })

  it('marks a folder as missing when the directory disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'localmind-folder-'))
    dirs.push(root)
    const watched = join(root, 'watched')
    await mkdir(watched, { recursive: true })
    const db = new AppDatabase(join(root, 'app.db'))
    const folders = new FolderService(db)
    const folder = folders.add(watched)
    await rm(watched, { recursive: true, force: true })
    const checked = await folders.checkById(folder.id)
    expect(checked.isMissing).toBe(true)
    folders.markMissing(folder.id)
    expect(folders.get(folder.id).isMissing).toBe(true)
    db.close()
  })
})

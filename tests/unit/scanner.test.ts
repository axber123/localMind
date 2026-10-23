import { mkdtemp, rm, writeFile, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { DocumentRepository } from '../../src/main/db/documentRepository'
import { DocumentScanner } from '../../src/main/indexing/scanner'
import { MODEL_ID, chunkConfigVersion } from '../../src/main/indexing/indexConfig'

const tempDirs: string[] = []

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'localmind-scan-'))
  tempDirs.push(dir)
  const db = new AppDatabase(join(dir, 'test.db'))
  const config = { modelId: MODEL_ID, configVersion: chunkConfigVersion(256, 48) }
  const repository = new DocumentRepository(db, () => config)
  db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, 'docs', ?, '2024-01-01', '2024-01-01')`, dir)
  const scanner = new DocumentScanner(db, repository)
  await writeFile(join(dir, 'a.md'), 'JavaScript 的闭包与词法环境有关。', 'utf8')
  await writeFile(join(dir, 'b.txt'), 'Transformer 通过注意力机制处理序列。', 'utf8')
  return { dir, db, repository, scanner }
}

async function scan(scanner: DocumentScanner, dir: string) {
  return scanner.scanFolder(1, dir, { isCancelled: () => false, onProgress: () => undefined })
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('DocumentScanner incremental sync', () => {
  it('indexes supported files and ignores unsupported files', async () => {
    const { dir, db, scanner } = await setup()
    await writeFile(join(dir, 'image.png'), 'not really an image', 'utf8')
    const result = await scan(scanner, dir)
    expect(result.total).toBe(2)
    expect(db.all<{ file_name: string }>('SELECT file_name FROM documents ORDER BY file_name')).toEqual([
      { file_name: 'a.md' },
      { file_name: 'b.txt' }
    ])
    db.close()
  })

  it('updates changed files without duplicating rows', async () => {
    const { dir, db, repository, scanner } = await setup()
    await scan(scanner, dir)
    const before = repository.listForFolder(1).find((doc) => doc.file_name === 'a.md')!
    await writeFile(join(dir, 'a.md'), 'JavaScript 的闭包与词法环境有关，并且新增了内容。', 'utf8')
    await scan(scanner, dir)
    const docs = repository.listForFolder(1)
    expect(docs).toHaveLength(2)
    const after = docs.find((doc) => doc.file_name === 'a.md')!
    expect(after.id).toBe(before.id)
    expect(after.file_hash).not.toBe(before.file_hash)
    expect(after.indexing_status).toBe('pending')
    db.close()
  })

  it('detects a rename by content hash and keeps the same document id', async () => {
    const { dir, db, repository, scanner } = await setup()
    await scan(scanner, dir)
    const before = repository.listForFolder(1).find((doc) => doc.file_name === 'b.txt')!
    await rename(join(dir, 'b.txt'), join(dir, 'c.txt'))
    const result = await scan(scanner, dir)
    expect(result.renamed).toBe(1)
    const docs = repository.listForFolder(1)
    const renamed = docs.find((doc) => doc.id === before.id)!
    expect(renamed.source_path.toLowerCase()).toContain('c.txt')
    expect(renamed.file_name).toBe('c.txt')
    db.close()
  })

  it('removes deleted files from the index only', async () => {
    const { dir, db, repository, scanner } = await setup()
    await scan(scanner, dir)
    const before = repository.listForFolder(1).find((doc) => doc.file_name === 'a.md')!
    await unlink(join(dir, 'a.md'))
    const result = await scan(scanner, dir)
    expect(result.removed).toBe(1)
    expect(repository.getRecord(before.id)).toBeUndefined()
    db.close()
  })

  it('skips excluded node_modules directories', async () => {
    const { dir, db, scanner } = await setup()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'hidden.md'), 'should not be indexed', 'utf8')
    await scan(scanner, dir)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM documents')?.count).toBe(2)
    db.close()
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmbeddingClient } from '../../src/main/model/embeddingClient'
import type { ModelManager } from '../../src/main/model/modelManager'
import type { SettingsService } from '../../src/main/services/settingsService'
import type { DocumentScanner } from '../../src/main/indexing/scanner'
import { AppDatabase } from '../../src/main/db/database'
import { DocumentRepository } from '../../src/main/db/documentRepository'
import { IndexingService } from '../../src/main/indexing/indexingService'
import { MODEL_ID, chunkConfigVersion } from '../../src/main/indexing/indexConfig'
import type { IndexProgressEvent } from '../../src/shared/types'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeEmbeddingClient {
  mode: 'success' | 'fail' | 'hang' = 'success'
  embedCalls = 0

  async ensureLoaded(): Promise<void> {}

  async countTokens(texts: string[]): Promise<number[]> {
    return texts.map((text) => Math.max(1, Math.ceil(text.length / 4)))
  }

  async embed(texts: string[], _prefix: 'query' | 'passage', signal?: AbortSignal): Promise<Float32Array[]> {
    this.embedCalls += 1
    if (this.mode === 'fail') throw new Error('fake embedding failure')
    if (this.mode === 'hang') {
      return new Promise<Float32Array[]>((_resolve, reject) => {
        const abort = (): void => reject(new Error('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }
    return texts.map(() => {
      const vector = new Float32Array(384)
      vector[0] = 1
      return vector
    })
  }
}

describe('indexing job state machine', () => {
  it('reports progress, cancels a running job, and retries a failed document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-jobs-'))
    dirs.push(dir)
    const docsDir = join(dir, 'docs')
    const notesDir = join(dir, 'notes')
    await mkdir(docsDir, { recursive: true })
    await mkdir(notesDir, { recursive: true })
    const filePath = join(docsDir, 'cancel-me.md')
    await writeFile(filePath, '# 长文\n\n' + '闭包与词法环境。'.repeat(30), 'utf8')

    const db = new AppDatabase(join(dir, 'localmind.db'))
    db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, 'docs', ?, '2024-01-01', '2024-01-01')`, docsDir)
    const config = { modelId: MODEL_ID, configVersion: chunkConfigVersion(256, 48) }
    const repository = new DocumentRepository(db, () => config)
    const fake = new FakeEmbeddingClient()
    const models = {
      modelDir: docsDir,
      status: () => ({
        state: 'ready',
        modelId: MODEL_ID,
        displayName: 'fake',
        license: 'MIT',
        dimensions: 384,
        maxTokens: 512,
        downloadedBytes: 1,
        totalBytes: 1,
        progress: 1,
        message: null,
        installedAt: '2024-01-01',
        needsReindex: false
      }),
      markLoading: () => undefined,
      markReady: () => undefined,
      markError: () => undefined
    } as unknown as ModelManager
    const settings = {
      getRag: () => ({ topK: 3, scoreThreshold: 0.2, maxContextChars: 4000, chunkSize: 256, chunkOverlap: 48 })
    } as unknown as SettingsService
    const events: IndexProgressEvent[] = []
    const indexing = new IndexingService(
      db,
      repository,
      {} as DocumentScanner,
      fake as unknown as EmbeddingClient,
      models,
      settings,
      notesDir,
      (event) => events.push(event)
    )
    const first = repository.insertFile({
      folderId: 1,
      sourcePath: filePath,
      fileName: 'cancel-me.md',
      extension: '.md',
      hash: 'first',
      size: 100,
      modifiedAt: '2024-01-01',
      parserVersion: 1,
      content: '闭包内容',
      status: 'pending'
    })
    const secondPath = join(docsDir, 'retry-me.md')
    await writeFile(secondPath, '# 重试\n\n需要重试的闭包文档。', 'utf8')
    const second = repository.insertFile({
      folderId: 1,
      sourcePath: secondPath,
      fileName: 'retry-me.md',
      extension: '.md',
      hash: 'second',
      size: 60,
      modifiedAt: '2024-01-01',
      parserVersion: 1,
      content: '需要重试',
      status: 'pending'
    })

    fake.mode = 'hang'
    const cancelJob = indexing.startIndex(null, [first], true)
    for (let index = 0; index < 100 && fake.embedCalls === 0; index += 1) await wait(20)
    expect(fake.embedCalls).toBeGreaterThan(0)
    expect(indexing.cancel(cancelJob.id).id).toBe(cancelJob.id)
    const cancelled = await waitJob(indexing, cancelJob.id)
    expect(cancelled.status).toBe('cancelled')
    expect(repository.getRecord(first)?.indexing_status).toBe('cancelled')
    expect(events.some((event) => event.status === 'cancelled')).toBe(true)

    fake.mode = 'fail'
    const failedJob = indexing.startIndex(null, [second], true)
    const failed = await waitJob(indexing, failedJob.id)
    expect(failed.status).toBe('failed')
    expect(repository.getRecord(second)?.indexing_status).toBe('failed')
    expect(repository.getRecord(second)?.error_message).toContain('fake embedding failure')

    fake.mode = 'success'
    const retryJob = indexing.startRetryFailed(1)
    const retried = await waitJob(indexing, retryJob.id)
    expect(retried.status).toBe('completed')
    expect(repository.getRecord(second)?.indexing_status).toBe('indexed')
    const chunks = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM document_chunks WHERE document_id = ?', second)
    expect(chunks?.count).toBeGreaterThan(0)
    expect(events.some((event) => event.status === 'processing')).toBe(true)
    expect(events.some((event) => event.status === 'completed')).toBe(true)
    db.close()
  }, 30_000)
})

async function waitJob(service: IndexingService, id: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const job = service.getJob(id)
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return service.getJob(id)
    }
    if (Date.now() > deadline) throw new Error('job timeout')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

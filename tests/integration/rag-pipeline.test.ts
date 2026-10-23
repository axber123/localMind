import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { DocumentRepository } from '../../src/main/db/documentRepository'
import { DocumentScanner } from '../../src/main/indexing/scanner'
import { IndexingService } from '../../src/main/indexing/indexingService'
import { MODEL_ID, chunkConfigVersion } from '../../src/main/indexing/indexConfig'
import { EmbeddingClient } from '../../src/main/model/embeddingClient'
import { ModelManager } from '../../src/main/model/modelManager'
import { CredentialVault } from '../../src/main/security/credentialVault'
import { SettingsService } from '../../src/main/services/settingsService'
import { FolderService } from '../../src/main/services/folderService'
import { VectorStore } from '../../src/main/rag/vectorStore'
import { RetrievalService } from '../../src/main/rag/retrievalService'
import { RagService } from '../../src/main/rag/ragService'
import { searchFts } from '../../src/main/services/fts'

const enabled = process.env.LOCALMIND_RUN_MODEL_TESTS === '1'
const modelRoot = join(process.env.APPDATA || process.cwd(), 'LocalMind', 'models')
const modelDir = join(modelRoot, 'multilingual-e5-small-ca456c06b3a9')
const tempDirs: string[] = []

let db: AppDatabase
let root: string
let docs: string
let folderId: number
let embeddingClient: EmbeddingClient
let indexing: IndexingService
let repository: DocumentRepository
let retrieval: RetrievalService
let settings: SettingsService

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJob(jobId: string, timeoutMs = 180_000): Promise<ReturnType<IndexingService['getJob']>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = indexing.getJob(jobId)
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      await wait(120)
      return indexing.getJob(jobId)
    }
    if (Date.now() > deadline) throw new Error(`job timeout: ${jobId} last=${job.status} ${job.message ?? ''}`)
    await wait(120)
  }
}

describe.skipIf(!enabled || !existsSync(join(modelDir, 'onnx', 'model.onnx')))('real local RAG pipeline', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'localmind-pipeline-'))
    tempDirs.push(root)
    docs = join(root, '学习资料')
    await mkdir(docs, { recursive: true })
    await writeFile(
      join(docs, 'closure.md'),
      '# JavaScript 闭包\n\nJavaScript 的闭包与函数及其词法环境有关。闭包可以捕获外层作用域中的变量。\n\n## 示例\n\n```js\nfunction makeCounter() {\n  let count = 0\n  return () => ++count\n}\n```\n',
      'utf8'
    )
    await writeFile(
      join(docs, 'transformer.md'),
      '# Transformer 注意力机制\n\nTransformer 通过注意力机制处理序列中不同位置的信息。Self-Attention 让每个 token 关注其他 token，从而聚合上下文。\n',
      'utf8'
    )
    await writeFile(join(docs, 'fib.py'), 'def fibonacci(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n', 'utf8')

    db = new AppDatabase(join(root, 'localmind.db'))
    const vault = new CredentialVault(join(root, 'secrets.bin'), {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8')
    })
    settings = new SettingsService(db, vault)
    settings.update({ rag: { topK: 5, scoreThreshold: 0.2, chunkSize: 256, chunkOverlap: 48 } })
    const getConfig = () => ({
      modelId: MODEL_ID,
      configVersion: chunkConfigVersion(settings.getRag().chunkSize, settings.getRag().chunkOverlap)
    })
    repository = new DocumentRepository(db, getConfig)
    const models = new ModelManager(db, modelRoot, getConfig, () => undefined)
    await models.refreshInstalledState()
    expect(models.status().state).toBe('ready')

    embeddingClient = new EmbeddingClient({
      launch: () => ({
        command: process.env.LOCALMIND_PYTHON || 'python',
        args: [join(process.cwd(), 'python', 'embedding_worker.py')],
        cwd: process.cwd()
      }),
      onLog: () => undefined
    })
    const scanner = new DocumentScanner(db, repository)
    indexing = new IndexingService(db, repository, scanner, embeddingClient, models, settings, join(root, 'notes'), () => undefined)
    const folders = new FolderService(db)
    folderId = folders.add(realpathSync.native(docs)).id
    retrieval = new RetrievalService(settings, models, embeddingClient, new VectorStore(db))
  }, 60_000)

  afterAll(async () => {
    await embeddingClient?.shutdown()
    db?.close()
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('scans real files, chunks, embeds locally, retrieves with sources, updates incrementally and removes deleted docs', async () => {
    const scanJob = await waitForJob(indexing.startScan(folderId).id)
    expect(scanJob.status).toBe('completed')
    expect(scanJob.total).toBe(3)
    const afterScan = repository.listForFolder(folderId)
    expect(afterScan).toHaveLength(3)
    console.log('SCAN', { total: scanJob.total, processed: scanJob.processed, failed: scanJob.failed })

    const indexJob = await waitForJob(indexing.startIndex(folderId, undefined, false).id)
    expect(indexJob.status).toBe('completed')
    expect(indexJob.failed).toBe(0)
    const indexed = repository.listForFolder(folderId)
    for (const doc of indexed) expect(doc.indexing_status).toBe('indexed')
    const closure = indexed.find((doc) => doc.file_name === 'closure.md')!
    const transformer = indexed.find((doc) => doc.file_name === 'transformer.md')!
    expect(closure.active_generation).toBeTruthy()
    expect(transformer.active_generation).toBeTruthy()
    console.log('INDEX', {
      processed: indexJob.processed,
      failed: indexJob.failed,
      docs: indexed.map((doc) => ({
        file: doc.file_name,
        status: doc.indexing_status,
        generation: doc.active_generation,
        chunks: db.get<{ count: number }>('SELECT COUNT(*) AS count FROM document_chunks WHERE document_id = ?', doc.id)?.count
      }))
    })

    const ftsHits = searchFts(db, '词法环境', ['document'], 10)
    expect(ftsHits.some((hit) => hit.entityId === closure.id)).toBe(true)

    const results = await retrieval.retrieve('闭包和词法环境有什么关系？', {}, new AbortController().signal)
    console.log(
      'RETRIEVAL closure question',
      results.map((result) => ({
        file: result.fileName,
        score: Number(result.score.toFixed(4)),
        path: result.sourcePath,
        heading: result.headingPath,
        snippet: result.content.slice(0, 90).replace(/\s+/g, ' ')
      }))
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.fileName).toBe('closure.md')
    expect(results[0]?.sourcePath).toBe(join(docs, 'closure.md'))
    expect(results[0]?.score).toBeGreaterThan(0.2)
    expect(results[0]?.content).toContain('闭包')

    const rag = new RagService(settings, retrieval)
    const preparation = await rag.prepare({
      question: '闭包和词法环境有什么关系？',
      learningMode: 'javascript',
      scope: {},
      history: [],
      signal: new AbortController().signal
    })
    expect(preparation.insufficient).toBe(false)
    expect(preparation.sources[0]?.sourceId).toBe('S1')
    expect(preparation.sources[0]?.fileName).toBe('closure.md')
    expect(preparation.sources[0]?.sourcePath).toBe(join(docs, 'closure.md'))
    expect(preparation.sources[0]?.startOffset).toBeGreaterThanOrEqual(0)
    expect(preparation.messages.at(-1)?.content).toContain('<source id="S1"')
    console.log('CITATIONS', {
      sourceId: preparation.sources[0]?.sourceId,
      file: preparation.sources[0]?.fileName,
      path: preparation.sources[0]?.sourcePath,
      heading: preparation.sources[0]?.headingPath,
      score: prepScore(preparation.sources[0]?.score),
      snippet: preparation.sources[0]?.content.slice(0, 90).replace(/\s+/g, ' ')
    })

    const transformerChunkIdsBefore = db
      .all<{ id: number }>('SELECT id FROM document_chunks WHERE document_id = ?', transformer.id)
      .map((row) => row.id)
    const closureGenerationBefore = closure.active_generation
    const transformerGenerationBefore = transformer.active_generation

    await writeFile(
      join(docs, 'closure.md'),
      '# JavaScript 闭包\n\nJavaScript 的闭包与函数及其词法环境有关。闭包可以捕获外层作用域中的变量。\n\n## 计数器示例\n\n下面的计数器使用闭包保存 count 状态。\n\n```js\nfunction makeCounter() {\n  let count = 0\n  return () => ++count\n}\n```\n',
      'utf8'
    )
    const rescan = await waitForJob(indexing.startScan(folderId).id)
    expect(rescan.status).toBe('completed')
    expect(repository.getRecord(closure.id)?.indexing_status).toBe('pending')
    expect(repository.getRecord(transformer.id)?.indexing_status).toBe('indexed')

    const reindex = await waitForJob(indexing.startIndex(folderId, undefined, false).id)
    expect(reindex.status).toBe('completed')
    const closureAfter = repository.getRecord(closure.id)!
    const transformerAfter = repository.getRecord(transformer.id)!
    const transformerChunkIdsAfter = db
      .all<{ id: number }>('SELECT id FROM document_chunks WHERE document_id = ?', transformer.id)
      .map((row) => row.id)
    expect(closureAfter.active_generation).not.toBe(closureGenerationBefore)
    expect(closureAfter.file_hash).not.toBe(closure.file_hash)
    expect(transformerAfter.active_generation).toBe(transformerGenerationBefore)
    expect(transformerChunkIdsAfter).toEqual(transformerChunkIdsBefore)
    console.log('INCREMENTAL', {
      closure: {
        hashChanged: closureAfter.file_hash !== closure.file_hash,
        generationChanged: closureAfter.active_generation !== closureGenerationBefore,
        status: closureAfter.indexing_status
      },
      transformer: {
        generationReused: transformerAfter.active_generation === transformerGenerationBefore,
        chunkIdsReused: JSON.stringify(transformerChunkIdsAfter) === JSON.stringify(transformerChunkIdsBefore),
        status: transformerAfter.indexing_status
      },
      reindexJob: { processed: reindex.processed, failed: reindex.failed }
    })

    await unlink(join(docs, 'transformer.md'))
    const deletionScan = await waitForJob(indexing.startScan(folderId).id)
    expect(deletionScan.status).toBe('completed')
    expect(repository.getRecord(transformer.id)).toBeUndefined()
    const remainingChunks = db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM document_chunks WHERE document_id = ?',
      transformer.id
    )?.count
    expect(remainingChunks).toBe(0)
    expect(searchFts(db, 'Self-Attention', ['document'], 10).some((hit) => hit.entityId === transformer.id)).toBe(false)
    console.log('DELETION', {
      removedDocument: true,
      remainingChunks,
      ftsHitCount: searchFts(db, 'Self-Attention', ['document'], 10).length,
      docsLeft: repository.listForFolder(folderId).map((doc) => doc.file_name)
    })
  }, 240_000)
})

function prepScore(score: number | undefined): number | null {
  return typeof score === 'number' ? Number(score.toFixed(4)) : null
}

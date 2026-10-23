import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { EmbeddingClient } from '../../src/main/model/embeddingClient'
import { VectorStore, vectorToBlob } from '../../src/main/rag/vectorStore'
import { MODEL_DIMENSIONS, MODEL_ID } from '../../src/main/indexing/indexConfig'

const enabled = process.env.LOCALMIND_RUN_MODEL_TESTS === '1'
const modelDir =
  process.env.LOCALMIND_MODEL_DIR ||
  join(process.env.APPDATA || process.cwd(), 'LocalMind', 'models', 'multilingual-e5-small-ca456c06b3a9')
const runnerDir = join(process.cwd())
const tempDirs: string[] = []
const db = new AppDatabase(':memory:')

const client = new EmbeddingClient({
  launch: () => ({
    command: process.env.LOCALMIND_PYTHON || 'python',
    args: [join(process.cwd(), 'python', 'embedding_worker.py')],
    cwd: runnerDir
  }),
  onLog: () => undefined
})

afterAll(async () => {
  await client.shutdown()
  db.close()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function seed() {
  const texts = [
    ['JavaScript 的闭包与函数及其词法环境有关。闭包可以捕获外层作用域中的变量。', 'closure.md'],
    ['Transformer 通过注意力机制处理序列中不同位置的信息。Self-Attention 让每个 token 关注其他 token。', 'transformer.md']
  ] as const
  const vectors = await client.embed(texts.map(([text]) => text), 'passage')
  expect(vectors).toHaveLength(2)
  db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, 'docs', 'F:/docs', '2024-01-01', '2024-01-01')`)
  texts.forEach(([, fileName], index) => {
    db.run(
      `INSERT INTO documents(id, kind, folder_id, source_path, file_name, extension, file_hash, file_size,
        last_modified_at, parser_version, indexing_status, active_generation, index_model_id, index_config_version,
        content_text, created_at, updated_at)
       VALUES (?, 'file', 1, ?, ?, '.md', ?, ?, '2024-01-01', 1, 'indexed', 'g1', ?, 'chunk-v1:256:48', ?, '2024-01-01', '2024-01-01')`,
      index + 1,
      `F:/docs/${fileName}`,
      fileName,
      `hash${index}`,
      texts[index]![0].length,
      MODEL_ID,
      texts[index]![0]
    )
    db.run(
      `INSERT INTO document_chunks(document_id, generation, chunk_index, content, heading_path, start_offset, end_offset,
        page_number, token_count, embedding, embedding_model_id, embedding_dim, created_at)
       VALUES (?, 'g1', 0, ?, NULL, 0, ?, NULL, 20, ?, ?, ?, '2024-01-01')`,
      index + 1,
      texts[index]![0],
      texts[index]![0].length,
      vectorToBlob(vectors[index]!),
      MODEL_ID,
      MODEL_DIMENSIONS
    )
  })
}

describe.skipIf(!enabled || !existsSync(modelDir))('real local embedding retrieval', () => {
  it('loads a 384-dimensional local model and retrieves the matching knowledge point', async () => {
    await client.ensureLoaded(modelDir)
    const vector = await client.embed(['闭包和词法环境有什么关系？'], 'query')
    expect(vector[0]).toHaveLength(384)
    let norm = 0
    for (const value of vector[0]!) norm += value * value
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4)
    await seed()
    const store = new VectorStore(db)
    const closure = await store.search({
      queryVector: vector[0]!,
      modelId: MODEL_ID,
      dimensions: MODEL_DIMENSIONS,
      scope: {},
      topK: 2,
      threshold: 0.2
    })
    expect(closure[0]?.fileName).toBe('closure.md')

    const transformerVector = await client.embed(['Transformer 如何处理不同位置的信息？'], 'query')
    const transformer = await store.search({
      queryVector: transformerVector[0]!,
      modelId: MODEL_ID,
      dimensions: MODEL_DIMENSIONS,
      scope: {},
      topK: 2,
      threshold: 0.2
    })
    expect(transformer[0]?.fileName).toBe('transformer.md')
  }, 120_000)

  it('returns no match for a completely unrelated question', async () => {
    await client.ensureLoaded(modelDir)
    const vector = await client.embed(['如何制作法式甜点舒芙蕾？'], 'query')
    const results = await new VectorStore(db).search({
      queryVector: vector[0]!,
      modelId: MODEL_ID,
      dimensions: MODEL_DIMENSIONS,
      scope: {},
      topK: 2,
      threshold: 0.95
    })
    expect(results).toEqual([])
  }, 120_000)
})

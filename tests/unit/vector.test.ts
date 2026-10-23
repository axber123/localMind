import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/db/database'
import { PropertyVectorTestHelper } from './vectorTestHelper'

describe('VectorStore', () => {
  it('returns the most similar local chunk and respects threshold', async () => {
    const helper = new PropertyVectorTestHelper()
    try {
      helper.addChunk(1, '闭包与词法环境', [1, 0, 0, 0])
      helper.addChunk(2, 'Transformer 注意力机制', [0, 1, 0, 0])
      const results = await helper.search([1, 0, 0, 0])
      expect(results).toHaveLength(1)
      expect(results[0]?.chunkId).toBe(1)
      expect(results[0]?.score).toBeGreaterThan(0.99)
      expect(results[0]?.fileName).toBe('a.md')
    } finally {
      helper.close()
    }
  })

  it('returns an empty array for an empty knowledge base', async () => {
    const db = new AppDatabase(':memory:')
    const { VectorStore } = await import('../../src/main/rag/vectorStore')
    const results = await new VectorStore(db).search({
      queryVector: new Float32Array([1, 0]),
      modelId: 'model',
      dimensions: 2,
      scope: {},
      topK: 5,
      threshold: 0.1
    })
    expect(results).toEqual([])
    db.close()
  })

  it('never mixes vectors from another embedding model', async () => {
    const helper = new PropertyVectorTestHelper()
    try {
      helper.addChunk(1, 'old model content', [1, 0, 0, 0], 'old-model')
      const results = await helper.search([1, 0, 0, 0])
      expect(results).toEqual([])
    } finally {
      helper.close()
    }
  })

  it('only searches chunks belonging to the active generation', async () => {
    const helper = new PropertyVectorTestHelper()
    try {
      helper.addChunk(1, 'old content', [1, 0, 0, 0], helper.modelId, 'old-generation')
      const results = await helper.search([1, 0, 0, 0])
      expect(results).toEqual([])
    } finally {
      helper.close()
    }
  })

  it('applies folder, document and tag scope filters locally', async () => {
    const helper = new PropertyVectorTestHelper()
    try {
      helper.addChunk(1, '闭包与词法环境', [1, 0, 0, 0])
      const queryVector = new Float32Array(384)
      queryVector[0] = 1
      const base = {
        queryVector,
        modelId: helper.modelId,
        dimensions: 384,
        topK: 5,
        threshold: 0.5
      }
      const store = new (await import('../../src/main/rag/vectorStore')).VectorStore(helper.db)
      expect(await store.search({ ...base, scope: { folderIds: [1] } })).toHaveLength(1)
      expect(await store.search({ ...base, scope: { folderIds: [2] } })).toHaveLength(0)
      expect(await store.search({ ...base, scope: { documentIds: [1] } })).toHaveLength(1)
      expect(await store.search({ ...base, scope: { documentIds: [2] } })).toHaveLength(0)
      helper.db.run("INSERT INTO tags(id, name, color, created_at) VALUES (1, 'JavaScript', '#000000', '2024-01-01')")
      helper.db.run('INSERT INTO folder_tags(folder_id, tag_id) VALUES (1, 1)')
      expect(await store.search({ ...base, scope: { tagIds: [1] } })).toHaveLength(1)
      expect(await store.search({ ...base, scope: { tagIds: [2] } })).toHaveLength(0)
    } finally {
      helper.close()
    }
  })
})

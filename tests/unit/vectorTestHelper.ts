import { AppDatabase } from '../../src/main/db/database'
import { VectorStore } from '../../src/main/rag/vectorStore'
import { MODEL_DIMENSIONS, MODEL_ID, chunkConfigVersion } from '../../src/main/indexing/indexConfig'

export class PropertyVectorTestHelper {
  readonly db: AppDatabase
  readonly modelId = MODEL_ID
  readonly config = { modelId: MODEL_ID, configVersion: chunkConfigVersion(256, 48) }

  constructor() {
    this.db = new AppDatabase(':memory:')
    this.db.run(`INSERT INTO folders(id, name, path, created_at, updated_at) VALUES (1, 'docs', 'F:/docs', '2024-01-01', '2024-01-01')`)
    this.db.run(
      `INSERT INTO documents(id, kind, folder_id, source_path, file_name, extension, file_hash, file_size,
        last_modified_at, parser_version, indexing_status, active_generation, index_model_id, index_config_version,
        content_text, created_at, updated_at)
       VALUES (1, 'file', 1, 'F:/docs/a.md', 'a.md', '.md', 'hash', 10, '2024-01-01', 1, 'indexed', 'active', ?, ?, 'content', '2024-01-01', '2024-01-01')`,
      MODEL_ID,
      this.config.configVersion
    )
  }

  addChunk(id: number, content: string, vector: number[], modelId = this.modelId, generation = 'active'): void {
    const full = new Float32Array(MODEL_DIMENSIONS)
    vector.forEach((value, index) => {
      full[index] = value
    })
    this.db.run(
      `INSERT INTO document_chunks(id, document_id, generation, chunk_index, content, heading_path, start_offset, end_offset,
        page_number, token_count, embedding, embedding_model_id, embedding_dim, created_at)
       VALUES (?, 1, ?, ?, ?, 'test', 0, ?, NULL, 10, ?, ?, ?, '2024-01-01')`,
      id,
      generation,
      id,
      content,
      content.length,
      Buffer.from(full.buffer),
      modelId,
      MODEL_DIMENSIONS
    )
  }

  async search(query: number[]) {
    const full = new Float32Array(MODEL_DIMENSIONS)
    query.forEach((value, index) => {
      full[index] = value
    })
    return new VectorStore(this.db).search({
      queryVector: full,
      modelId: this.modelId,
      dimensions: MODEL_DIMENSIONS,
      scope: {},
      topK: 5,
      threshold: 0.5
    })
  }

  close(): void {
    this.db.close()
  }
}

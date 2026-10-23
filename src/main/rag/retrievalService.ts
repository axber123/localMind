import type { AppError as AppErrorType } from '../db/database'
import { AppError } from '../db/database'
import type { RetrievalScope } from '../../shared/types'
import type { EmbeddingClient } from '../model/embeddingClient'
import type { ModelManager } from '../model/modelManager'
import type { SettingsService } from '../services/settingsService'
import type { VectorStore } from './vectorStore'
import type { RetrievedChunk } from './contextBuilder'
import { MODEL_DIMENSIONS, MODEL_ID } from '../indexing/indexConfig'

export class RetrievalService {
  constructor(
    private readonly settings: SettingsService,
    private readonly models: ModelManager,
    private readonly embeddings: EmbeddingClient,
    private readonly vectors: VectorStore
  ) {}

  async retrieve(question: string, scope: RetrievalScope, signal: AbortSignal): Promise<RetrievedChunk[]> {
    const trimmed = question.trim()
    if (!trimmed) return []
    const modelStatus = this.models.status()
    if (modelStatus.state !== 'ready' && modelStatus.state !== 'loading') {
      throw new AppError('MODEL_NOT_READY', '本地 Embedding 模型尚未就绪，请先在设置中下载并加载模型。')
    }
    this.models.markLoading()
    try {
      await this.embeddings.ensureLoaded(this.models.modelDir, signal)
      this.models.markReady()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.models.markError(message)
      throw error
    }
    if (signal.aborted) throw new AppError('RETRIEVAL_ABORTED', '检索已取消。')
    const [queryVector] = await this.embeddings.embed([`${trimmed}`], 'query', signal)
    if (!queryVector) return []
    const rag = this.settings.getRag()
    return this.vectors.search({
      queryVector,
      modelId: MODEL_ID,
      dimensions: MODEL_DIMENSIONS,
      scope,
      topK: rag.topK,
      threshold: rag.scoreThreshold
    })
  }
}

export type AppErrorShape = AppErrorType

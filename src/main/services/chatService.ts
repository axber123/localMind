import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type {
  Chat,
  ChatCreateInput,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatMode,
  ChatSendInput,
  ChatStartResult,
  ChatStreamEvent,
  Citation,
  LearningMode,
  MessageStatus,
  RetrievalScope
} from '../../shared/types'
import type { SettingsService } from './settingsService'
import type { RagService } from '../rag/ragService'
import type { ModelManager } from '../model/modelManager'
import type { LlmMessage } from '../llm/client'
import { callLlm, isLoopbackHost, originOf } from '../llm/client'
import { learningModeDefinition } from '../../shared/prompts'
import { removeFts, upsertFts } from './fts'
import type { ContextSource } from '../rag/contextBuilder'

interface ChatRow {
  id: number
  title: string
  mode: ChatMode
  learning_mode: LearningMode
  scope_json: string
  created_at: string
  updated_at: string
  message_count: number
}

interface MessageRow {
  id: number
  chat_id: number
  role: ChatMessage['role']
  content: string
  status: MessageStatus
  citations_json: string
  retrieval_json: string
  error_message: string | null
  created_at: string
  updated_at: string
}

interface ActiveStream {
  streamId: string
  chatId: number
  assistantId: number
  controller: AbortController
  content: string
  sources: ContextSource[]
}

export interface ChatEvents {
  onStream: (event: ChatStreamEvent) => void
  onDone: (event: ChatDoneEvent) => void
  onError: (event: ChatErrorEvent) => void
}

const DEFAULT_SCOPE: RetrievalScope = {}

export class ChatService {
  private active = new Map<string, ActiveStream>()

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsService,
    private readonly rag: RagService,
    private readonly models: ModelManager,
    private readonly events: ChatEvents
  ) {}

  list(): Chat[] {
    return this.db
      .all<ChatRow>(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
         FROM chats c ORDER BY c.updated_at DESC LIMIT 200`
      )
      .map((row) => this.mapChat(row))
  }

  get(id: number): Chat {
    const row = this.db.get<ChatRow>(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
       FROM chats c WHERE c.id = ?`,
      id
    )
    if (!row) throw new AppError('CHAT_NOT_FOUND', '会话不存在或已被删除。')
    return this.mapChat(row)
  }

  messages(chatId: number): ChatMessage[] {
    this.get(chatId)
    return this.db.all<MessageRow>('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC', chatId).map((row) => this.mapMessage(row))
  }

  create(input: ChatCreateInput): Chat {
    const now = nowIso()
    const result = this.db.run(
      'INSERT INTO chats(title, mode, learning_mode, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.title?.trim() || '新对话',
      input.mode,
      input.learningMode,
      JSON.stringify(input.scope ?? DEFAULT_SCOPE),
      now,
      now
    )
    return this.get(result.lastInsertRowid)
  }

  update(
    id: number,
    patch: { title?: string; mode?: ChatMode; learningMode?: LearningMode; scope?: RetrievalScope }
  ): Chat {
    const chat = this.get(id)
    this.db.run(
      'UPDATE chats SET title = ?, mode = ?, learning_mode = ?, scope_json = ?, updated_at = ? WHERE id = ?',
      patch.title?.trim() || chat.title,
      patch.mode ?? chat.mode,
      patch.learningMode ?? chat.learningMode,
      JSON.stringify(patch.scope ?? chat.scope),
      nowIso(),
      id
    )
    return this.get(id)
  }

  remove(id: number): void {
    const messages = this.db.all<{ id: number }>('SELECT id FROM messages WHERE chat_id = ?', id)
    this.db.transaction(() => {
      for (const message of messages) removeFts(this.db, 'chat', message.id)
      this.db.run('DELETE FROM chats WHERE id = ?', id)
    })
  }

  start(input: ChatSendInput): ChatStartResult {
    const content = input.content.trim()
    if (!content) throw new AppError('EMPTY_MESSAGE', '消息不能为空。')
    const chat = this.get(input.chatId)
    this.assertChatIdle(chat.id)
    this.preflight(input.mode)
    if (input.mode === 'rag' && this.models.status().state === 'not_installed') {
      throw new AppError('MODEL_NOT_READY', '资料问答需要本地 Embedding 模型，请先在设置中下载模型。')
    }
    const now = nowIso()
    const updated = this.update(chat.id, {
      mode: input.mode,
      learningMode: input.learningMode,
      scope: input.scope
    })
    const history = this.historyBefore(chat.id)
    const userResult = this.db.run(
      'INSERT INTO messages(chat_id, role, content, status, citations_json, retrieval_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      chat.id,
      'user',
      content,
      'complete',
      '[]',
      '[]',
      now,
      now
    )
    const userMessage = this.getMessage(userResult.lastInsertRowid)!
    if (chat.title === '新对话' || !chat.title.trim()) {
      this.db.run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', content.slice(0, 36), now, chat.id)
    } else {
      this.db.run('UPDATE chats SET updated_at = ? WHERE id = ?', now, chat.id)
    }
    upsertFts(this.db, 'chat', userMessage.id, updated.title, content)
    return this.beginGeneration(updated, userMessage, history, content)
  }

  retry(chatId: number, messageId: number): ChatStartResult {
    return this.regenerate(chatId, messageId)
  }

  regenerate(chatId: number, messageId: number): ChatStartResult {
    const chat = this.get(chatId)
    this.assertChatIdle(chat.id)
    const target = this.getMessage(messageId)
    if (!target || target.chatId !== chatId) throw new AppError('MESSAGE_NOT_FOUND', '消息不存在。')
    const user = this.db.get<MessageRow>(
      "SELECT * FROM messages WHERE chat_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1",
      chatId,
      messageId
    )
    if (!user) throw new AppError('NO_USER_MESSAGE', '找不到可重新生成的问题。')
    this.preflight(chat.mode)
    if (chat.mode === 'rag' && this.models.status().state === 'not_installed') {
      throw new AppError('MODEL_NOT_READY', '资料问答需要本地 Embedding 模型，请先在设置中下载模型。')
    }
    const history = this.historyBefore(chatId, user.id)
    const removed = this.db.all<{ id: number }>('SELECT id FROM messages WHERE chat_id = ? AND id >= ?', chatId, messageId)
    this.db.transaction(() => {
      for (const message of removed) removeFts(this.db, 'chat', message.id)
      this.db.run('DELETE FROM messages WHERE chat_id = ? AND id >= ?', chatId, messageId)
    })
    const userMessage = this.getMessage(user.id)!
    return this.beginGeneration(chat, userMessage, history, user.content)
  }

  stop(streamId: string): void {
    const active = this.active.get(streamId)
    if (!active) return
    active.controller.abort()
  }

  shutdown(): void {
    for (const stream of this.active.values()) {
      stream.controller.abort()
      this.db.run(
        "UPDATE messages SET content = ?, status = 'stopped', updated_at = ? WHERE id = ?",
        stream.content,
        nowIso(),
        stream.assistantId
      )
    }
    this.active.clear()
  }

  exportMarkdown(chatId: number): { markdown: string; fileName: string } {
    const chat = this.get(chatId)
    const messages = this.messages(chatId)
    const lines = [`# ${chat.title}`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}`, '']
    for (const message of messages) {
      if (message.role === 'system') continue
      lines.push(`## ${message.role === 'user' ? '我' : 'LocalMind'}`, '', message.content || '（无内容）', '')
      const used = message.citations.filter((citation) => citation.used)
      if (used.length > 0) {
        lines.push('**参考来源**', '')
        for (const citation of used) {
          lines.push(
            `- [${citation.sourceId}] ${citation.fileName}${citation.headingPath ? ` · ${citation.headingPath}` : ''}`
          )
          lines.push(`  - 路径：${citation.sourcePath}`)
          if (citation.snippet) lines.push(`  - 片段：${citation.snippet.replace(/\n/g, ' ').slice(0, 300)}`)
        }
        lines.push('')
      }
    }
    const safeTitle = chat.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 50) || 'LocalMind-对话'
    return { markdown: lines.join('\n'), fileName: `${safeTitle}.md` }
  }

  private beginGeneration(
    chat: Chat,
    userMessage: ChatMessage,
    history: LlmMessage[],
    question: string
  ): ChatStartResult {
    const now = nowIso()
    const result = this.db.run(
      'INSERT INTO messages(chat_id, role, content, status, citations_json, retrieval_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      chat.id,
      'assistant',
      '',
      'streaming',
      '[]',
      '[]',
      now,
      now
    )
    const assistantMessage = this.getMessage(result.lastInsertRowid)!
    const streamId = randomUUID()
    const controller = new AbortController()
    this.active.set(streamId, {
      streamId,
      chatId: chat.id,
      assistantId: assistantMessage.id,
      controller,
      content: '',
      sources: []
    })
    void this.generate(streamId, chat, userMessage, assistantMessage, history, question)
    return { streamId, userMessage, assistantMessage }
  }

  private async generate(
    streamId: string,
    chat: Chat,
    userMessage: ChatMessage,
    assistantMessage: ChatMessage,
    history: LlmMessage[],
    question: string
  ): Promise<void> {
    const active = this.active.get(streamId)
    if (!active) return
    const llm = this.settings.getLlm()
    const apiKey = this.settings.getApiKey()
    try {
      let messages: LlmMessage[]
      let sources: ContextSource[] = []
      if (chat.mode === 'rag') {
        const prepared = await this.rag.prepare({
          question,
          learningMode: chat.learningMode,
          scope: chat.scope,
          history,
          signal: active.controller.signal
        })
        if (prepared.insufficient) {
          const content = '根据当前知识库中没有检索到足够相关的资料，因此无法基于本地文档回答这个问题。\n\n你可以尝试：\n- 确认相关文件夹已经扫描并建立索引；\n- 换一种更具体的问法；\n- 切换到普通问答，让模型给出不依赖资料的回答。'
          this.completeStream(streamId, content, 'complete', [], null)
          return
        }
        messages = prepared.messages
        sources = prepared.sources
        active.sources = sources
      } else {
        const learning = learningModeDefinition(chat.learningMode)
        messages = [
          {
            role: 'system',
            content: `你是 LocalMind 学习助手。当前学习模式：${learning.label}。${learning.prompt}\n用清晰的中文回答，技术问题优先提供简短示例。不要声称阅读了用户未提供的本地文件。`
          },
          ...history.slice(-10),
          { role: 'user', content: question }
        ]
      }
      const result = await callLlm({
        messages,
        settings: llm,
        apiKey,
        signal: active.controller.signal,
        onDelta: (delta) => {
          const current = this.active.get(streamId)
          if (!current) return
          current.content += delta
          this.events.onStream({
            streamId,
            chatId: current.chatId,
            messageId: current.assistantId,
            delta
          })
        }
      })
      const citations = this.buildCitations(result.content, sources)
      this.completeStream(streamId, result.content, 'complete', citations, null)
    } catch (error) {
      const current = this.active.get(streamId)
      if (!current) return
      if (current.controller.signal.aborted) {
        this.completeStream(streamId, current.content, 'stopped', this.buildCitations(current.content, current.sources), null)
        return
      }
      const message = error instanceof AppError ? error : new AppError('CHAT_FAILED', '生成回答失败，请重试。', String(error))
      this.completeStream(streamId, current.content, 'error', this.buildCitations(current.content, current.sources), message)
    }
  }

  private completeStream(
    streamId: string,
    content: string,
    status: MessageStatus,
    citations: Citation[],
    error: AppError | null
  ): void {
    const active = this.active.get(streamId)
    if (!active) return
    this.active.delete(streamId)
    const now = nowIso()
    this.db.run(
      'UPDATE messages SET content = ?, status = ?, citations_json = ?, retrieval_json = ?, error_message = ?, updated_at = ? WHERE id = ?',
      content,
      status,
      JSON.stringify(citations),
      JSON.stringify(active.sources),
      error?.message ?? null,
      now,
      active.assistantId
    )
    this.db.run('UPDATE chats SET updated_at = ? WHERE id = ?', now, active.chatId)
    if (content.trim()) {
      const chat = this.db.get<{ title: string }>('SELECT title FROM chats WHERE id = ?', active.chatId)
      upsertFts(this.db, 'chat', active.assistantId, chat?.title ?? '对话', content)
    }
    const message = this.getMessage(active.assistantId)
    if (!message) return
    if (error) {
      this.events.onError({
        streamId,
        chatId: active.chatId,
        message,
        error: { code: error.code, message: error.message, details: error.details }
      })
    } else {
      this.events.onDone({ streamId, chatId: active.chatId, message })
    }
  }

  private buildCitations(content: string, sources: ContextSource[]): Citation[] {
    const usedIds = new Set<string>()
    for (const match of content.matchAll(/\[(S\d+)\]/g)) usedIds.add(match[1]!)
    return sources.map((source) => ({
      sourceId: source.sourceId,
      chunkId: source.chunkId,
      documentId: source.documentId,
      fileName: source.fileName,
      sourcePath: source.sourcePath,
      headingPath: source.headingPath,
      snippet: source.content.slice(0, 500),
      score: source.score,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      pageNumber: source.pageNumber,
      used: usedIds.has(source.sourceId)
    }))
  }

  private preflight(mode: ChatMode): void {
    const llm = this.settings.getLlm()
    const origin = originOf(llm.baseUrl)
    if (!isLoopbackHost(llm.baseUrl) && !this.settings.hasCloudConsent(origin)) {
      throw new AppError(
        'CLOUD_CONSENT_REQUIRED',
        '首次使用云端模型前需要确认数据发送行为。你的问题、必要对话以及本轮 RAG 检索到的文档片段会发送到所配置的模型服务。',
        origin
      )
    }
    if (!this.settings.getApiKey() && !isLoopbackHost(llm.baseUrl)) {
      throw new AppError('LLM_NO_KEY', '尚未配置 API Key，请先在设置中保存密钥。')
    }
    if (!llm.baseUrl.trim() || !llm.model.trim()) {
      throw new AppError('LLM_NOT_CONFIGURED', '请先配置模型服务的 Base URL 和模型名称。')
    }
    void mode
  }

  private historyBefore(chatId: number, beforeId?: number): LlmMessage[] {
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE chat_id = ? AND role IN ('user', 'assistant') ${beforeId ? 'AND id < ?' : ''}
       ORDER BY id DESC LIMIT 12`,
      chatId,
      ...(beforeId ? [beforeId] : [])
    )
    return rows
      .reverse()
      .filter((row) => row.content.trim().length > 0)
      .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }))
  }

  private assertChatIdle(chatId: number): void {
    for (const stream of this.active.values()) {
      if (stream.chatId === chatId) throw new AppError('CHAT_BUSY', '这个会话正在生成回答，请先停止或等待完成。')
    }
  }

  private getMessage(id: number): ChatMessage | null {
    const row = this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)
    return row ? this.mapMessage(row) : null
  }

  private mapChat(row: ChatRow): Chat {
    let scope: RetrievalScope = {}
    try {
      scope = JSON.parse(row.scope_json) as RetrievalScope
    } catch {
      scope = {}
    }
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      learningMode: row.learning_mode,
      scope,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count
    }
  }

  private mapMessage(row: MessageRow): ChatMessage {
    let citations: Citation[] = []
    try {
      citations = JSON.parse(row.citations_json) as Citation[]
    } catch {
      citations = []
    }
    return {
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      content: row.content,
      status: row.status,
      citations,
      createdAt: row.created_at,
      errorMessage: row.error_message
    }
  }
}

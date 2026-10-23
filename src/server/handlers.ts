import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import type { AppDatabase } from '../main/db/database'
import { AppError } from '../main/db/database'
import type { WebsiteService } from '../main/services/websiteService'
import type { FolderService } from '../main/services/folderService'
import type { DocumentService } from '../main/services/documentService'
import type { NoteService } from '../main/services/noteService'
import type { SearchService } from '../main/services/searchService'
import type { TaskService } from '../main/services/taskService'
import type { SettingsService } from '../main/services/settingsService'
import type { ChatService } from '../main/services/chatService'
import type { IndexingService } from '../main/indexing/indexingService'
import type { ModelManager } from '../main/model/modelManager'
import type { EmbeddingClient } from '../main/model/embeddingClient'
import type { AppLogger } from '../main/logging/logger'
import { callLlm, isLoopbackHost, originOf } from '../main/llm/client'
import { openDirectory } from '../main/platform/openDirectory'
import { IPC } from '../shared/ipc'
import type {
  ApiResult,
  AppInfo,
  ChatCreateInput,
  ChatSendInput,
  DashboardStats,
  DocumentQuery,
  FolderInput,
  NoteCreateInput,
  NoteSaveInput,
  RetrievalScope,
  SettingsPatch,
  TaskInput,
  WebsiteInput
} from '../shared/types'

export interface ServerServices {
  db: AppDatabase
  websites: WebsiteService
  folders: FolderService
  documents: DocumentService
  notes: NoteService
  search: SearchService
  tasks: TaskService
  settings: SettingsService
  chat: ChatService
  indexing: IndexingService
  models: ModelManager
  embeddings: EmbeddingClient
}

export interface ServerHandlerContext {
  services: ServerServices
  logger: AppLogger
  paths: {
    userData: string
    database: string
    notes: string
    models: string
    logs: string
    pythonWorker: string
  }
  appVersion: string
  broadcast: (channel: string, payload: unknown) => void
}

export interface ServerHandlers {
  invoke: (channel: string, args: unknown[]) => Promise<ApiResult<unknown>>
  has: (channel: string) => boolean
}

const idSchema = z.number().int().positive()
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(12)
const websiteInputSchema: z.ZodType<WebsiteInput> = z.object({
  name: z.string().trim().min(1, '网站名称不能为空').max(100),
  url: z.string().trim().url('请输入有效 URL').max(2048),
  description: z.string().max(1000).optional(),
  groupId: z.number().int().positive().nullable().optional(),
  tags: tagsSchema,
  icon: z.string().max(250_000).nullable().optional()
})
const folderInputSchema: z.ZodType<FolderInput> = z.object({
  note: z.string().max(2000).optional(),
  tags: tagsSchema
})
const documentQuerySchema: z.ZodType<DocumentQuery> = z.object({
  query: z.string().max(500).optional(),
  folderId: z.number().int().positive().nullable().optional(),
  status: z.enum(['pending', 'processing', 'indexed', 'failed', 'cancelled', 'all']).optional(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(200)
})
const noteCreateSchema: z.ZodType<NoteCreateInput> = z.object({
  title: z.string().max(80).optional(),
  content: z.string().max(2_000_000).optional()
})
const noteSaveSchema: z.ZodType<NoteSaveInput> = z.object({
  id: idSchema,
  content: z.string().max(2_000_000),
  expectedRevision: z.string().min(1).max(128)
})
const scopeSchema: z.ZodType<RetrievalScope> = z.object({
  folderIds: z.array(idSchema).max(100).optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  tagIds: z.array(idSchema).max(100).optional()
})
const chatCreateSchema: z.ZodType<ChatCreateInput> = z.object({
  title: z.string().max(120).optional(),
  mode: z.enum(['general', 'rag']),
  learningMode: z.enum(['free', 'frontend-interview', 'javascript', 'python', 'ai-app', 'algorithm']),
  scope: scopeSchema
})
const chatSendSchema: z.ZodType<ChatSendInput> = z.object({
  chatId: idSchema,
  content: z.string().trim().min(1).max(50_000),
  mode: z.enum(['general', 'rag']),
  learningMode: z.enum(['free', 'frontend-interview', 'javascript', 'python', 'ai-app', 'algorithm']),
  scope: scopeSchema
})
const taskSchema: z.ZodType<TaskInput> = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  completed: z.boolean().optional()
})
const settingsPatchSchema: z.ZodType<SettingsPatch> = z.object({
  llm: z
    .object({
      baseUrl: z.string().trim().url().max(2048).optional(),
      model: z.string().trim().min(1).max(200).optional(),
      timeoutMs: z.number().int().min(5000).max(300000).optional(),
      stream: z.boolean().optional(),
      temperature: z.number().min(0).max(2).optional()
    })
    .optional(),
  rag: z
    .object({
      topK: z.number().int().min(1).max(20).optional(),
      scoreThreshold: z.number().min(-1).max(1).optional(),
      maxContextChars: z.number().int().min(1000).max(30000).optional(),
      chunkSize: z.number().int().min(64).max(480).optional(),
      chunkOverlap: z.number().int().min(0).max(400).optional()
    })
    .optional()
})

type HandlerFn = (...args: unknown[]) => unknown

export function createHandlers(context: ServerHandlerContext): ServerHandlers {
  const { services, logger, paths, appVersion, broadcast } = context
  const { db, websites, folders, documents, notes, search, tasks, settings, chat, indexing, models, embeddings } = services
  const handlers = new Map<string, HandlerFn>()

  function handle(channel: string, fn: HandlerFn): void {
    handlers.set(channel, fn)
  }

  async function invoke(channel: string, args: unknown[]): Promise<ApiResult<unknown>> {
    const fn = handlers.get(channel)
    if (!fn) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `未知接口：${channel}` } }
    }
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map((issue) => issue.message).join('；')
        return { ok: false, error: { code: 'INVALID_INPUT', message: issues || '请求参数无效。' } }
      }
      if (error instanceof AppError) {
        logger.warn(`${channel}: ${error.code} ${error.message}`)
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
      }
      logger.error(`${channel} failed`, error)
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '操作失败，请查看服务端日志。' } }
    }
  }

  handle(IPC.app.info, () => {
    const info: AppInfo = {
      version: appVersion,
      userDataPath: paths.userData,
      databasePath: paths.database,
      notesPath: paths.notes,
      modelsPath: paths.models,
      logsPath: paths.logs,
      platform: process.platform,
      electronVersion: '',
      pythonWorker: paths.pythonWorker
    }
    return info
  })

  handle(IPC.app.stats, () => {
    const count = (sql: string): number => db.get<{ count: number }>(sql)?.count ?? 0
    const active = db.get<{
      id: string
      kind: 'scan' | 'index'
      folder_id: number | null
      status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
      total: number
      processed: number
      failed: number
      message: string | null
      error: string | null
      started_at: string | null
      finished_at: string | null
    }>("SELECT * FROM index_jobs WHERE status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1")
    const stats: DashboardStats = {
      websites: count('SELECT COUNT(*) AS count FROM websites'),
      folders: count('SELECT COUNT(*) AS count FROM folders'),
      documents: count("SELECT COUNT(*) AS count FROM documents WHERE kind = 'file'"),
      notes: count('SELECT COUNT(*) AS count FROM notes'),
      chats: count('SELECT COUNT(*) AS count FROM chats'),
      openTasks: count('SELECT COUNT(*) AS count FROM tasks WHERE completed = 0'),
      indexedDocuments: count("SELECT COUNT(*) AS count FROM documents WHERE kind = 'file' AND indexing_status = 'indexed'"),
      failedDocuments: count("SELECT COUNT(*) AS count FROM documents WHERE kind = 'file' AND indexing_status = 'failed'"),
      modelState: models.status().state,
      activeJob: active
        ? {
            id: active.id,
            kind: active.kind,
            folderId: active.folder_id,
            status: active.status,
            total: active.total,
            processed: active.processed,
            failed: active.failed,
            message: active.message,
            error: active.error,
            startedAt: active.started_at,
            finishedAt: active.finished_at
          }
        : null
    }
    return stats
  })

  handle(IPC.app.recent, () => {
    return db
      .all<{ kind: 'document' | 'note'; id: number; title: string; subtitle: string; updated_at: string }>(
        `SELECT 'document' AS kind, id, file_name AS title, source_path AS subtitle, updated_at
         FROM documents WHERE kind = 'file'
         UNION ALL
         SELECT 'note' AS kind, id, title, 'Markdown 笔记' AS subtitle, updated_at FROM notes
         ORDER BY updated_at DESC LIMIT 8`
      )
      .map((row) => ({ kind: row.kind, id: row.id, title: row.title, subtitle: row.subtitle, updatedAt: row.updated_at }))
  })

  handle(IPC.app.openPath, async (target) => {
    const key = z.enum(['userData', 'database', 'notes', 'models', 'logs']).parse(target)
    const pathsMap = {
      userData: paths.userData,
      database: paths.userData,
      notes: paths.notes,
      models: paths.models,
      logs: paths.logs
    }
    const directory = pathsMap[key]
    await mkdir(directory, { recursive: true }).catch(() => undefined)
    await openDirectory(directory)
  })

  handle(IPC.app.openExternal, async (value) => {
    const url = z.string().url().max(2048).parse(value)
    return { url: assertHttpUrl(url) }
  })

  handle(IPC.websites.list, (filters) => {
    const parsed = z
      .object({
        query: z.string().max(200).optional(),
        groupId: z.number().int().positive().nullable().optional(),
        tagId: z.number().int().positive().nullable().optional()
      })
      .parse(filters ?? {})
    return websites.list(parsed)
  })
  handle(IPC.websites.create, async (input) => {
    const parsed = websiteInputSchema.parse(input)
    const icon = await resolveIcon(parsed.url, parsed.icon)
    return websites.create({ ...parsed, icon })
  })
  handle(IPC.websites.update, async (idValue, input) => {
    const id = idSchema.parse(idValue)
    const parsed = websiteInputSchema.parse(input)
    const icon = await resolveIcon(parsed.url, parsed.icon)
    return websites.update(id, { ...parsed, icon })
  })
  handle(IPC.websites.remove, (idValue) => websites.remove(idSchema.parse(idValue)))
  handle(IPC.websites.reorder, (ids) => websites.reorder(z.array(idSchema).max(1000).parse(ids)))
  handle(IPC.websites.groups, () => websites.groups())
  handle(IPC.websites.createGroup, (name, color) =>
    websites.createGroup(
      z.string().trim().min(1).max(60).parse(name),
      z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(color)
    )
  )
  handle(IPC.websites.updateGroup, (idValue, name, color) =>
    websites.updateGroup(
      idSchema.parse(idValue),
      z.string().trim().min(1).max(60).parse(name),
      z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(color)
    )
  )
  handle(IPC.websites.removeGroup, (idValue) => websites.removeGroup(idSchema.parse(idValue)))
  handle(IPC.websites.tags, () => websites.tags())
  handle(IPC.websites.open, (idValue) => {
    const website = websites.get(idSchema.parse(idValue))
    return { url: assertHttpUrl(website.url) }
  })

  handle(IPC.folders.list, () => folders.list())
  handle(IPC.folders.pick, () => {
    throw new AppError('UPLOAD_REQUIRED', '网页版请点击“添加文件夹”选择本机文件上传。')
  })
  handle(IPC.folders.update, (idValue, input) =>
    folders.update(idSchema.parse(idValue), folderInputSchema.parse(input))
  )
  handle(IPC.folders.remove, (idValue, deleteIndexOnly) => {
    if (deleteIndexOnly !== true) {
      throw new AppError('CONFIRMATION_REQUIRED', '移除索引需要明确确认；原始文件不会被删除。')
    }
    folders.removeIndex(idSchema.parse(idValue))
  })
  handle(IPC.folders.open, async (idValue) => {
    const id = idSchema.parse(idValue)
    const folder = folders.get(id)
    try {
      await openDirectory(folder.path)
    } catch (error) {
      if (error instanceof AppError && error.code === 'FOLDER_MISSING') folders.markMissing(id)
      throw error
    }
  })
  handle(IPC.folders.reauthorize, () => {
    throw new AppError('UPLOAD_REQUIRED', '网页版请通过上传新文件重新定位资料夹。')
  })
  handle(IPC.folders.refresh, async (idValue) => {
    const id = idSchema.parse(idValue)
    const folder = await folders.checkById(id)
    if (!folder.isMissing) {
      try {
        indexing.startScan(id)
      } catch {
        // A job is already running.
      }
    }
    return folder
  })
  handle(IPC.folders.scan, (idValue) => indexing.startScan(idSchema.parse(idValue)))
  handle(IPC.folders.tags, () => folders.tags())

  handle(IPC.documents.list, (query) => documents.list(documentQuerySchema.parse(query)))
  handle(IPC.documents.preview, (idValue) => documents.preview(idSchema.parse(idValue)))
  handle(IPC.documents.indexOne, (idValue) => {
    const id = idSchema.parse(idValue)
    const doc = documents.summaryForCitation(id)
    if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', '文档不存在。')
    return indexing.startIndex(doc.folderId, [id], true)
  })
  handle(IPC.documents.retryFailed, (folderValue) => indexing.startRetryFailed(idSchema.parse(folderValue)))
  handle(IPC.documents.reindexFolder, (folderValue) => indexing.startIndex(idSchema.parse(folderValue), undefined, false))

  handle(IPC.notes.list, (query) => notes.list(z.string().max(500).parse(query ?? '')))
  handle(IPC.notes.get, (idValue) => notes.get(idSchema.parse(idValue)))
  handle(IPC.notes.create, (input) => notes.create(noteCreateSchema.parse(input ?? {})))
  handle(IPC.notes.save, (input) => notes.save(noteSaveSchema.parse(input)))
  handle(IPC.notes.remove, (idValue) => notes.remove(idSchema.parse(idValue)))

  handle(IPC.indexing.jobs, () => indexing.listJobs())
  handle(IPC.indexing.job, (jobId) => indexing.getJob(z.string().uuid().parse(jobId)))
  handle(IPC.indexing.cancel, (jobId) => indexing.cancel(z.string().uuid().parse(jobId)))

  handle(IPC.model.status, async () => {
    await models.refreshInstalledState()
    return models.status()
  })
  handle(IPC.model.download, async () => {
    const status = await models.download()
    return { state: status.state, message: status.message ?? '' }
  })
  handle(IPC.model.cancelDownload, () => {
    models.cancelDownload()
  })
  handle(IPC.model.test, async () => {
    await models.refreshInstalledState()
    if (models.status().state === 'not_installed') {
      throw new AppError('MODEL_NOT_INSTALLED', '请先下载本地 Embedding 模型。')
    }
    models.markLoading()
    const started = Date.now()
    try {
      await embeddings.ensureLoaded(models.modelDir)
      const vectors = await embeddings.embed(['LocalMind 模型测试'], 'query')
      models.markReady()
      return { latencyMs: Date.now() - started, dimensions: vectors[0]?.length ?? 0, message: '本地模型工作正常。' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      models.markError(message)
      throw error
    }
  })

  handle(IPC.chat.list, () => chat.list())
  handle(IPC.chat.get, (idValue) => chat.get(idSchema.parse(idValue)))
  handle(IPC.chat.messages, (idValue) => chat.messages(idSchema.parse(idValue)))
  handle(IPC.chat.create, (input) => chat.create(chatCreateSchema.parse(input)))
  handle(IPC.chat.update, (idValue, patch) => {
    const id = idSchema.parse(idValue)
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        mode: z.enum(['general', 'rag']).optional(),
        learningMode: z.enum(['free', 'frontend-interview', 'javascript', 'python', 'ai-app', 'algorithm']).optional(),
        scope: scopeSchema.optional()
      })
      .parse(patch)
    return chat.update(id, parsed)
  })
  handle(IPC.chat.remove, (idValue) => chat.remove(idSchema.parse(idValue)))
  handle(IPC.chat.start, (input) => chat.start(chatSendSchema.parse(input)))
  handle(IPC.chat.stop, (streamId) => chat.stop(z.string().uuid().parse(streamId)))
  handle(IPC.chat.retry, (chatId, messageId) => chat.retry(idSchema.parse(chatId), idSchema.parse(messageId)))
  handle(IPC.chat.regenerate, (chatId, messageId) => chat.regenerate(idSchema.parse(chatId), idSchema.parse(messageId)))
  handle(IPC.chat.export, (inputValue) => {
    const input = z.object({ chatId: idSchema }).parse(inputValue)
    return chat.exportMarkdown(input.chatId)
  })

  handle(IPC.search.global, (query) => search.global(z.string().max(500).parse(query ?? '')))

  handle(IPC.tasks.list, (filter) => tasks.list(z.enum(['all', 'open', 'completed']).parse(filter)))
  handle(IPC.tasks.create, (input) => tasks.create(taskSchema.parse(input)))
  handle(IPC.tasks.update, (idValue, input) => tasks.update(idSchema.parse(idValue), taskSchema.parse(input)))
  handle(IPC.tasks.toggle, (idValue, completed) => tasks.toggle(idSchema.parse(idValue), z.boolean().parse(completed)))
  handle(IPC.tasks.remove, (idValue) => tasks.remove(idSchema.parse(idValue)))

  handle(IPC.settings.get, () => settings.get())
  handle(IPC.settings.update, (patch) => settings.update(settingsPatchSchema.parse(patch)))
  handle(IPC.settings.setApiKey, (key) => settings.setApiKey(z.string().trim().min(1).max(4096).parse(key)))
  handle(IPC.settings.clearApiKey, () => settings.clearApiKey())
  handle(IPC.settings.testLlm, async () => {
    const llm = settings.getLlm()
    const origin = originOf(llm.baseUrl)
    if (!isLoopbackHost(llm.baseUrl) && !settings.hasCloudConsent(origin)) {
      throw new AppError(
        'CLOUD_CONSENT_REQUIRED',
        '测试云端模型会把一条测试消息发送到模型服务，请先确认数据传输提示。',
        origin
      )
    }
    const controller = new AbortController()
    const start = Date.now()
    try {
      const result = await callLlm({
        messages: [{ role: 'user', content: '请只回复 OK' }],
        settings: { ...llm, stream: false, timeoutMs: Math.min(llm.timeoutMs, 30_000) },
        apiKey: settings.getApiKey(),
        signal: controller.signal,
        maxTokens: 4
      })
      return { ok: true, latencyMs: Date.now() - start, message: result.content.slice(0, 120) }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('LLM_TEST_FAILED', '模型连接测试失败。', String(error))
    }
  })
  handle(IPC.settings.acceptCloudConsent, (origin, version) =>
    settings.acceptCloudConsent(z.string().url().parse(origin), z.number().int().min(1).max(1000).parse(version))
  )

  void broadcast
  return { invoke, has: (channel) => handlers.has(channel) }
}

function assertHttpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('UNSAFE_URL', '链接格式无效。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('UNSAFE_URL', '只允许打开 http/https 链接。')
  }
  if (url.username || url.password) throw new AppError('UNSAFE_URL', '链接不能包含登录凭据。')
  return url.toString()
}

async function resolveIcon(siteUrl: string, provided: string | null | undefined): Promise<string | null> {
  if (provided && /^data:image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,/i.test(provided)) {
    return provided.length <= 250_000 ? provided : null
  }
  try {
    const url = new URL(siteUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const iconUrl = new URL('/favicon.ico', url)
    const response = await fetch(iconUrl, { signal: AbortSignal.timeout(5_000), redirect: 'follow' })
    if (!response.ok) return null
    const type = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() ?? ''
    if (!type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > 120_000) return null
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}
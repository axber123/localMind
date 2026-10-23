import { copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AppDatabase } from '../main/db/database'
import { DocumentRepository } from '../main/db/documentRepository'
import { AppLogger } from '../main/logging/logger'
import { CredentialVault } from '../main/security/credentialVault'
import { SettingsService } from '../main/services/settingsService'
import { WebsiteService } from '../main/services/websiteService'
import { FolderService } from '../main/services/folderService'
import { DocumentService } from '../main/services/documentService'
import { NoteService } from '../main/services/noteService'
import { SearchService } from '../main/services/searchService'
import { TaskService } from '../main/services/taskService'
import { ChatService } from '../main/services/chatService'
import { ModelManager } from '../main/model/modelManager'
import { EmbeddingClient } from '../main/model/embeddingClient'
import { DocumentScanner } from '../main/indexing/scanner'
import { IndexingService } from '../main/indexing/indexingService'
import { MODEL_ID, chunkConfigVersion } from '../main/indexing/indexConfig'
import { VectorStore } from '../main/rag/vectorStore'
import { RetrievalService } from '../main/rag/retrievalService'
import { RagService } from '../main/rag/ragService'
import { IPC } from '../shared/ipc'
import type { ChatDoneEvent, ChatErrorEvent, ChatStreamEvent, IndexProgressEvent, ModelProgressEvent } from '../shared/types'
import { createEventBus } from './events'
import { createHandlers } from './handlers'
import { createHttpServer } from './http'
import { resolveServerPaths, type ServerPaths } from './paths'
import { createFileEncryptionAdapter } from './secrets'

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

async function moveToTrash(paths: ServerPaths, source: string): Promise<void> {
  const target = join(paths.trash, `${Date.now()}-${basename(source)}`)
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(source, target)
  } catch {
    await copyFile(source, target)
    await unlink(source)
  }
}

async function main(): Promise<void> {
  const paths = resolveServerPaths()
  const logger = new AppLogger(paths.logs)
  const version = appVersion()
  const eventBus = createEventBus()

  const database = new AppDatabase(paths.database)
  if (!database.ftsAvailable()) {
    throw new Error('当前 SQLite 构建不支持 FTS5，无法安全启动全文检索。')
  }
  const vault = new CredentialVault(join(paths.userData, 'secrets.bin'), createFileEncryptionAdapter(paths.userData))
  const settings = new SettingsService(database, vault)
  const getConfig = (): { modelId: string; configVersion: string } => {
    const rag = settings.getRag()
    return { modelId: MODEL_ID, configVersion: chunkConfigVersion(rag.chunkSize, rag.chunkOverlap) }
  }
  const documentRepository = new DocumentRepository(database, getConfig)
  const documents = new DocumentService(database, documentRepository, paths.notes, getConfig)
  const websites = new WebsiteService(database)
  const folders = new FolderService(database)
  const notes = new NoteService(database, documentRepository, paths.notes, (target) => moveToTrash(paths, target))
  const search = new SearchService(database)
  const tasks = new TaskService(database)

  const models = new ModelManager(database, paths.models, getConfig, (event: ModelProgressEvent) => {
    eventBus.emit(IPC.model.progress, event)
  })

  const python = process.env.LOCALMIND_PYTHON || 'python'
  const workerScript = join(process.cwd(), 'python', 'embedding_worker.py')
  if (!existsSync(workerScript)) {
    logger.warn(`embedding worker script not found: ${workerScript}`)
  }
  const embeddings = new EmbeddingClient({
    launch: () => ({ command: python, args: [workerScript], cwd: process.cwd() }),
    onLog: (line) => logger.info(`embedding worker: ${line}`),
    onLoaded: () => models.markReady(),
    onError: (message) => models.markError(message)
  })

  const scanner = new DocumentScanner(database, documentRepository)
  const indexing = new IndexingService(
    database,
    documentRepository,
    scanner,
    embeddings,
    models,
    settings,
    paths.notes,
    (event: IndexProgressEvent) => eventBus.emit(IPC.indexing.progress, event)
  )
  indexing.recoverInterrupted()

  const vectors = new VectorStore(database)
  const retrieval = new RetrievalService(settings, models, embeddings, vectors)
  const rag = new RagService(settings, retrieval)
  const chat = new ChatService(database, settings, rag, models, {
    onStream: (event: ChatStreamEvent) => eventBus.emit(IPC.chat.stream, event),
    onDone: (event: ChatDoneEvent) => eventBus.emit(IPC.chat.done, event),
    onError: (event: ChatErrorEvent) => eventBus.emit(IPC.chat.error, event)
  })
  notes.setSaveListener((documentId) => indexing.scheduleNoteIndex(documentId))

  const handlers = createHandlers({
    services: {
      db: database,
      websites,
      folders,
      documents,
      notes,
      search,
      tasks,
      settings,
      chat,
      indexing,
      models,
      embeddings
    },
    logger,
    paths: {
      userData: paths.userData,
      database: paths.database,
      notes: paths.notes,
      models: paths.models,
      logs: paths.logs,
      pythonWorker: paths.pythonWorker
    },
    appVersion: version,
    broadcast: (channel, payload) => eventBus.emit(channel, payload)
  })

  const port = Number(process.env.LOCALMIND_PORT ?? 8787)
  const host = process.env.LOCALMIND_HOST ?? '127.0.0.1'
  const http = await createHttpServer({
    handlers,
    events: eventBus,
    services: {
      db: database,
      websites,
      folders,
      documents,
      notes,
      search,
      tasks,
      settings,
      chat,
      indexing,
      models,
      embeddings
    },
    paths,
    logger,
    staticDir: join(process.cwd(), 'dist', 'web'),
    host,
    port,
    version
  })

  await models.refreshInstalledState()

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down LocalMind web server')
    chat.shutdown()
    indexing.shutdown()
    await embeddings.shutdown().catch(() => undefined)
    await http.close().catch(() => undefined)
    try {
      database.close()
    } catch {
      // Best effort during shutdown.
    }
  }

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0))
  })
  process.on('uncaughtException', (error) => logger.error('uncaught exception', error))
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason))

  const model = models.status()
  console.log('')
  console.log('  LocalMind 网页版已启动')
  console.log(`  打开:        ${http.url}`)
  console.log(`  数据目录:    ${paths.userData}`)
  console.log(`  数据库:      ${paths.database}`)
  console.log(`  模型目录:    ${paths.models} (${model.state})`)
  console.log(`  Python:      ${python}`)
  console.log(`  上传资料库:  ${paths.library}`)
  console.log('')
  console.log('  按 Ctrl+C 停止服务')
  console.log('')
}

main().catch((error) => {
  console.error('LocalMind 启动失败：', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
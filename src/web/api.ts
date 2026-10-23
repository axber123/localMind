import type {
  ApiResult,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatStreamEvent,
  IndexProgressEvent,
  LocalMindApi,
  ModelProgressEvent
} from '../shared/types'
import { IPC } from '../shared/ipc'

function failure<T>(code: string, message: string, details?: string): ApiResult<T> {
  return { ok: false, error: { code, message, details } }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<ApiResult<T>> {
  try {
    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
    if (!response.ok) return failure<T>('HTTP_ERROR', `请求失败：HTTP ${response.status}`)
    return (await response.json()) as ApiResult<T>
  } catch (error) {
    return failure<T>('NETWORK_ERROR', error instanceof Error ? error.message : '无法连接 LocalMind 服务。')
  }
}

const listeners = new Map<string, Set<(payload: unknown) => void>>()
let eventSource: EventSource | null = null

function ensureEventSource(): void {
  if (eventSource) return
  eventSource = new EventSource('/api/events')
  eventSource.addEventListener('localmind', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as { channel: string; payload: unknown }
      listeners.get(data.channel)?.forEach((listener) => listener(data.payload))
    } catch {
      // Ignore malformed events.
    }
  })
}

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  ensureEventSource()
  const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>()
  const wrapped = (payload: unknown): void => listener(payload as T)
  set.add(wrapped)
  listeners.set(channel, set)
  return () => {
    set.delete(wrapped)
    if (set.size === 0) listeners.delete(channel)
  }
}

function hasFiles(list: FileList | null): list is FileList {
  return Boolean(list && list.length > 0)
}

async function uploadSelection(files: FileList, folderId?: number): Promise<ApiResult<unknown>> {
  const relativePaths = Array.from(files).map((file) => {
    const withPath = file as File & { webkitRelativePath?: string }
    return withPath.webkitRelativePath || file.name
  })
  const rootName = relativePaths[0]?.split('/')[0] || '上传资料'
  const form = new FormData()
  form.append('name', rootName)
  if (folderId) form.append('folderId', String(folderId))
  form.append('relativePaths', JSON.stringify(relativePaths))
  for (const file of Array.from(files)) form.append('files', file, file.name)
  try {
    const response = await fetch('/api/folders/upload', { method: 'POST', body: form })
    if (!response.ok) return failure('UPLOAD_FAILED', `上传失败：HTTP ${response.status}`)
    return (await response.json()) as ApiResult<unknown>
  } catch (error) {
    return failure('UPLOAD_FAILED', error instanceof Error ? error.message : '上传失败。')
  }
}

function pickAndUpload(folderId?: number): Promise<ApiResult<unknown>> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.setAttribute('webkitdirectory', '')
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const files = input.files
      input.remove()
      if (!hasFiles(files)) {
        resolve({ ok: true, data: null })
        return
      }
      void uploadSelection(files, folderId).then(resolve)
    })
    input.addEventListener('cancel', () => {
      input.remove()
      resolve({ ok: true, data: null })
    })
    document.body.appendChild(input)
    input.click()
  })
}

function openUrlResult(result: ApiResult<{ url: string }>): ApiResult<void> {
  if (result.ok && result.data?.url) {
    window.open(result.data.url, '_blank', 'noopener,noreferrer')
    return { ok: true, data: undefined }
  }
  return result.ok ? { ok: true, data: undefined } : result
}

export function createWebApi(): LocalMindApi {
  return {
    app: {
      getInfo: () => invoke(IPC.app.info),
      getStats: () => invoke(IPC.app.stats),
      getRecent: () => invoke(IPC.app.recent),
      openPath: (target) => invoke(IPC.app.openPath, target),
      openExternal: async (url) => openUrlResult(await invoke<{ url: string }>(IPC.app.openExternal, url))
    },
    websites: {
      list: (filters) => invoke(IPC.websites.list, filters),
      create: (input) => invoke(IPC.websites.create, input),
      update: (id, input) => invoke(IPC.websites.update, id, input),
      remove: (id) => invoke(IPC.websites.remove, id),
      reorder: (orderedIds) => invoke(IPC.websites.reorder, orderedIds),
      groups: () => invoke(IPC.websites.groups),
      createGroup: (name, color) => invoke(IPC.websites.createGroup, name, color),
      updateGroup: (id, name, color) => invoke(IPC.websites.updateGroup, id, name, color),
      removeGroup: (id) => invoke(IPC.websites.removeGroup, id),
      tags: () => invoke(IPC.websites.tags),
      open: async (id) => openUrlResult(await invoke<{ url: string }>(IPC.websites.open, id))
    },
    folders: {
      list: () => invoke(IPC.folders.list),
      pick: () => pickAndUpload() as unknown as ReturnType<LocalMindApi['folders']['pick']>,
      update: (id, input) => invoke(IPC.folders.update, id, input),
      remove: (id, deleteIndexOnly) => invoke(IPC.folders.remove, id, deleteIndexOnly),
      open: (id) => invoke(IPC.folders.open, id),
      reauthorize: (id) => pickAndUpload(id) as unknown as ReturnType<LocalMindApi['folders']['reauthorize']>,
      refresh: (id) => invoke(IPC.folders.refresh, id),
      scan: (id) => invoke(IPC.folders.scan, id),
      tags: () => invoke(IPC.folders.tags)
    },
    documents: {
      list: (query) => invoke(IPC.documents.list, query),
      preview: (id) => invoke(IPC.documents.preview, id),
      indexOne: (id) => invoke(IPC.documents.indexOne, id),
      retryFailed: (folderId) => invoke(IPC.documents.retryFailed, folderId),
      reindexFolder: (folderId) => invoke(IPC.documents.reindexFolder, folderId)
    },
    notes: {
      list: (query) => invoke(IPC.notes.list, query),
      get: (id) => invoke(IPC.notes.get, id),
      create: (input) => invoke(IPC.notes.create, input),
      save: (input) => invoke(IPC.notes.save, input),
      remove: (id) => invoke(IPC.notes.remove, id)
    },
    indexing: {
      listJobs: () => invoke(IPC.indexing.jobs),
      getJob: (id) => invoke(IPC.indexing.job, id),
      cancel: (id) => invoke(IPC.indexing.cancel, id)
    },
    model: {
      status: () => invoke(IPC.model.status),
      download: () => invoke(IPC.model.download),
      cancelDownload: () => invoke(IPC.model.cancelDownload),
      test: () => invoke(IPC.model.test)
    },
    chat: {
      list: () => invoke(IPC.chat.list),
      get: (id) => invoke(IPC.chat.get, id),
      messages: (chatId) => invoke(IPC.chat.messages, chatId),
      create: (input) => invoke(IPC.chat.create, input),
      update: (id, patch) => invoke(IPC.chat.update, id, patch),
      remove: (id) => invoke(IPC.chat.remove, id),
      start: (input) => invoke(IPC.chat.start, input),
      stop: (streamId) => invoke(IPC.chat.stop, streamId),
      retry: (chatId, messageId) => invoke(IPC.chat.retry, chatId, messageId),
      regenerate: (chatId, messageId) => invoke(IPC.chat.regenerate, chatId, messageId),
      export: async (input) => {
        const result = await invoke<{ markdown: string; fileName: string }>(IPC.chat.export, input)
        if (!result.ok || !result.data) return result.ok ? { ok: true, data: null } : result
        const blob = new Blob([result.data.markdown], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = result.data.fileName
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        return { ok: true, data: result.data.fileName }
      },
      onStream: (listener) => subscribe<ChatStreamEvent>(IPC.chat.stream, listener),
      onDone: (listener) => subscribe<ChatDoneEvent>(IPC.chat.done, listener),
      onError: (listener) => subscribe<ChatErrorEvent>(IPC.chat.error, listener)
    },
    search: {
      global: (query) => invoke(IPC.search.global, query)
    },
    tasks: {
      list: (filter) => invoke(IPC.tasks.list, filter),
      create: (input) => invoke(IPC.tasks.create, input),
      update: (id, input) => invoke(IPC.tasks.update, id, input),
      toggle: (id, completed) => invoke(IPC.tasks.toggle, id, completed),
      remove: (id) => invoke(IPC.tasks.remove, id)
    },
    settings: {
      get: () => invoke(IPC.settings.get),
      update: (patch) => invoke(IPC.settings.update, patch),
      setApiKey: (key) => invoke(IPC.settings.setApiKey, key),
      clearApiKey: () => invoke(IPC.settings.clearApiKey),
      testLlm: () => invoke(IPC.settings.testLlm),
      acceptCloudConsent: (origin, version) => invoke(IPC.settings.acceptCloudConsent, origin, version)
    },
    indexingEvents: {
      onProgress: (listener) => subscribe<IndexProgressEvent>(IPC.indexing.progress, listener)
    },
    modelEvents: {
      onProgress: (listener) => subscribe<ModelProgressEvent>(IPC.model.progress, listener)
    }
  }
}
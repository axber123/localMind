export type IndexStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'cancelled'
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
export type ChatMode = 'general' | 'rag'
export type LearningMode = 'free' | 'frontend-interview' | 'javascript' | 'python' | 'ai-app' | 'algorithm'
export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface ApiError {
  code: string
  message: string
  details?: string
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export interface Tag {
  id: number
  name: string
  color: string
}

export interface WebsiteGroup {
  id: number
  name: string
  color: string
  sortOrder: number
}

export interface Website {
  id: number
  name: string
  url: string
  icon: string | null
  description: string | null
  groupId: number | null
  groupName: string | null
  sortOrder: number
  tags: Tag[]
  createdAt: string
  updatedAt: string
}

export interface WebsiteInput {
  name: string
  url: string
  description?: string
  groupId?: number | null
  tags: string[]
  icon?: string | null
}

export interface Folder {
  id: number
  name: string
  path: string
  note: string | null
  isMissing: boolean
  lastCheckedAt: string | null
  tags: Tag[]
  documentCount: number
  indexedCount: number
  failedCount: number
  createdAt: string
  updatedAt: string
}

export interface FolderInput {
  note?: string
  tags: string[]
}

export interface DocumentSummary {
  id: number
  folderId: number | null
  folderName: string | null
  noteId: number | null
  kind: 'file' | 'note'
  fileName: string
  sourcePath: string
  extension: string
  fileSize: number
  lastModifiedAt: string
  indexingStatus: IndexStatus
  indexedAt: string | null
  errorMessage: string | null
  hasIndex: boolean
  indexModelId: string | null
  isStale: boolean
}

export interface DocumentPreview {
  document: DocumentSummary
  content: string
  truncated: boolean
  totalBytes: number
  lineCount: number
  language: string
  chunkCount: number
}

export interface Note {
  id: number
  documentId: number | null
  title: string
  content: string
  revision: string
  updatedAt: string
  createdAt: string
  indexingStatus: IndexStatus
  errorMessage: string | null
  indexedAt: string | null
}

export interface NoteCreateInput {
  title?: string
  content?: string
}

export interface NoteSaveInput {
  id: number
  content: string
  expectedRevision: string
}

export interface NoteSaveResult {
  id: number
  revision: string
  updatedAt: string
  savedAt: string
}

export interface Task {
  id: number
  title: string
  description: string | null
  priority: TaskPriority
  dueDate: string | null
  completed: boolean
  createdAt: string
  updatedAt: string
}

export interface TaskInput {
  title: string
  description?: string
  priority: TaskPriority
  dueDate?: string | null
  completed?: boolean
}

export interface Citation {
  sourceId: string
  chunkId: number
  documentId: number
  fileName: string
  sourcePath: string
  headingPath: string | null
  snippet: string
  score: number
  startOffset: number
  endOffset: number
  pageNumber: number | null
  used: boolean
}

export interface RetrievalScope {
  folderIds?: number[]
  documentIds?: number[]
  tagIds?: number[]
}

export interface Chat {
  id: number
  title: string
  mode: ChatMode
  learningMode: LearningMode
  scope: RetrievalScope
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface ChatMessage {
  id: number
  chatId: number
  role: MessageRole
  content: string
  status: MessageStatus
  citations: Citation[]
  createdAt: string
  errorMessage: string | null
}

export interface ChatCreateInput {
  title?: string
  mode: ChatMode
  learningMode: LearningMode
  scope: RetrievalScope
}

export interface ChatSendInput {
  chatId: number
  content: string
  mode: ChatMode
  learningMode: LearningMode
  scope: RetrievalScope
}

export interface ChatStartResult {
  streamId: string
  userMessage: ChatMessage
  assistantMessage: ChatMessage
}

export interface ChatStreamEvent {
  streamId: string
  chatId: number
  messageId: number
  delta: string
}

export interface ChatDoneEvent {
  streamId: string
  chatId: number
  message: ChatMessage
}

export interface ChatErrorEvent {
  streamId: string
  chatId: number
  message: ChatMessage | null
  error: ApiError
}

export interface LlmSettings {
  baseUrl: string
  model: string
  timeoutMs: number
  stream: boolean
  temperature: number
}

export interface RagSettings {
  topK: number
  scoreThreshold: number
  maxContextChars: number
  chunkSize: number
  chunkOverlap: number
}

export interface AppSettings {
  llm: LlmSettings
  rag: RagSettings
  hasApiKey: boolean
  apiKeyHint: string | null
  cloudConsentOrigins: string[]
  cloudConsentVersion: number
}

export interface SettingsPatch {
  llm?: Partial<LlmSettings>
  rag?: Partial<RagSettings>
}

export interface ModelStatus {
  state: 'not_installed' | 'downloading' | 'loading' | 'ready' | 'error'
  modelId: string
  displayName: string
  license: string
  dimensions: number
  maxTokens: number
  downloadedBytes: number
  totalBytes: number
  progress: number
  message: string | null
  installedAt: string | null
  needsReindex: boolean
}

export interface IndexJob {
  id: string
  kind: 'scan' | 'index'
  folderId: number | null
  status: JobStatus
  total: number
  processed: number
  failed: number
  message: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface IndexProgressEvent {
  jobId: string
  kind: 'scan' | 'index'
  folderId: number | null
  status: JobStatus
  total: number
  processed: number
  failed: number
  currentFile: string | null
  message: string | null
}

export interface ModelProgressEvent {
  state: ModelStatus['state']
  progress: number
  downloadedBytes: number
  totalBytes: number
  message: string | null
}

export interface SearchHit {
  type: 'website' | 'folder' | 'document' | 'note' | 'chat'
  id: number
  title: string
  subtitle: string | null
  snippet: string | null
  meta: string | null
}

export interface SearchResults {
  query: string
  groups: { type: SearchHit['type']; label: string; hits: SearchHit[] }[]
  total: number
}

export interface DashboardStats {
  websites: number
  folders: number
  documents: number
  notes: number
  chats: number
  openTasks: number
  indexedDocuments: number
  failedDocuments: number
  modelState: ModelStatus['state']
  activeJob: IndexJob | null
}

export interface RecentItem {
  kind: 'document' | 'note'
  id: number
  title: string
  subtitle: string
  updatedAt: string
}

export interface AppInfo {
  version: string
  userDataPath: string
  databasePath: string
  notesPath: string
  modelsPath: string
  logsPath: string
  platform: string
  electronVersion: string
  pythonWorker: string
}

export interface DocumentQuery {
  query?: string
  folderId?: number | null
  status?: IndexStatus | 'all'
  page: number
  pageSize: number
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ChatExportInput {
  chatId: number
}

export interface ModelDownloadResult {
  state: ModelStatus['state']
  message: string
}

export interface OpenDocumentTarget {
  documentId: number
  offset: number
  snippet: string
}

export interface TestLlmResult {
  ok: boolean
  latencyMs: number
  message: string
}

export interface TestModelResult {
  latencyMs: number
  dimensions: number
  message: string
}

export interface LocalMindApi {
  app: {
    getInfo: () => Promise<ApiResult<AppInfo>>
    getStats: () => Promise<ApiResult<DashboardStats>>
    getRecent: () => Promise<ApiResult<RecentItem[]>>
    openPath: (target: 'userData' | 'database' | 'notes' | 'models' | 'logs') => Promise<ApiResult<void>>
    openExternal: (url: string) => Promise<ApiResult<void>>
  }
  websites: {
    list: (filters: { query?: string; groupId?: number | null; tagId?: number | null }) => Promise<ApiResult<Website[]>>
    create: (input: WebsiteInput) => Promise<ApiResult<Website>>
    update: (id: number, input: WebsiteInput) => Promise<ApiResult<Website>>
    remove: (id: number) => Promise<ApiResult<void>>
    reorder: (orderedIds: number[]) => Promise<ApiResult<void>>
    groups: () => Promise<ApiResult<WebsiteGroup[]>>
    createGroup: (name: string, color: string) => Promise<ApiResult<WebsiteGroup>>
    updateGroup: (id: number, name: string, color: string) => Promise<ApiResult<WebsiteGroup>>
    removeGroup: (id: number) => Promise<ApiResult<void>>
    tags: () => Promise<ApiResult<Tag[]>>
    open: (id: number) => Promise<ApiResult<void>>
  }
  folders: {
    list: () => Promise<ApiResult<Folder[]>>
    pick: () => Promise<ApiResult<Folder | null>>
    update: (id: number, input: FolderInput) => Promise<ApiResult<Folder>>
    remove: (id: number, deleteIndexOnly: boolean) => Promise<ApiResult<void>>
    open: (id: number) => Promise<ApiResult<void>>
    reauthorize: (id: number) => Promise<ApiResult<Folder | null>>
    refresh: (id: number) => Promise<ApiResult<Folder>>
    scan: (id: number) => Promise<ApiResult<IndexJob>>
    tags: () => Promise<ApiResult<Tag[]>>
  }
  documents: {
    list: (query: DocumentQuery) => Promise<ApiResult<Paginated<DocumentSummary>>>
    preview: (id: number) => Promise<ApiResult<DocumentPreview>>
    indexOne: (id: number) => Promise<ApiResult<IndexJob>>
    retryFailed: (folderId: number) => Promise<ApiResult<IndexJob>>
    reindexFolder: (folderId: number) => Promise<ApiResult<IndexJob>>
  }
  notes: {
    list: (query: string) => Promise<ApiResult<Note[]>>
    get: (id: number) => Promise<ApiResult<Note>>
    create: (input: NoteCreateInput) => Promise<ApiResult<Note>>
    save: (input: NoteSaveInput) => Promise<ApiResult<NoteSaveResult>>
    remove: (id: number) => Promise<ApiResult<void>>
  }
  indexing: {
    listJobs: () => Promise<ApiResult<IndexJob[]>>
    getJob: (id: string) => Promise<ApiResult<IndexJob>>
    cancel: (id: string) => Promise<ApiResult<IndexJob>>
  }
  model: {
    status: () => Promise<ApiResult<ModelStatus>>
    download: () => Promise<ApiResult<ModelDownloadResult>>
    cancelDownload: () => Promise<ApiResult<void>>
    test: () => Promise<ApiResult<TestModelResult>>
  }
  chat: {
    list: () => Promise<ApiResult<Chat[]>>
    get: (id: number) => Promise<ApiResult<Chat>>
    messages: (chatId: number) => Promise<ApiResult<ChatMessage[]>>
    create: (input: ChatCreateInput) => Promise<ApiResult<Chat>>
    update: (id: number, patch: { title?: string; mode?: ChatMode; learningMode?: LearningMode; scope?: RetrievalScope }) => Promise<ApiResult<Chat>>
    remove: (id: number) => Promise<ApiResult<void>>
    start: (input: ChatSendInput) => Promise<ApiResult<ChatStartResult>>
    stop: (streamId: string) => Promise<ApiResult<void>>
    retry: (chatId: number, messageId: number) => Promise<ApiResult<ChatStartResult>>
    regenerate: (chatId: number, messageId: number) => Promise<ApiResult<ChatStartResult>>
    export: (input: ChatExportInput) => Promise<ApiResult<string | null>>
    onStream: (listener: (event: ChatStreamEvent) => void) => () => void
    onDone: (listener: (event: ChatDoneEvent) => void) => () => void
    onError: (listener: (event: ChatErrorEvent) => void) => () => void
  }
  search: {
    global: (query: string) => Promise<ApiResult<SearchResults>>
  }
  tasks: {
    list: (filter: 'all' | 'open' | 'completed') => Promise<ApiResult<Task[]>>
    create: (input: TaskInput) => Promise<ApiResult<Task>>
    update: (id: number, input: TaskInput) => Promise<ApiResult<Task>>
    toggle: (id: number, completed: boolean) => Promise<ApiResult<Task>>
    remove: (id: number) => Promise<ApiResult<void>>
  }
  settings: {
    get: () => Promise<ApiResult<AppSettings>>
    update: (patch: SettingsPatch) => Promise<ApiResult<AppSettings>>
    setApiKey: (key: string) => Promise<ApiResult<AppSettings>>
    clearApiKey: () => Promise<ApiResult<AppSettings>>
    testLlm: () => Promise<ApiResult<TestLlmResult>>
    acceptCloudConsent: (origin: string, version: number) => Promise<ApiResult<AppSettings>>
  }
  indexingEvents: {
    onProgress: (listener: (event: IndexProgressEvent) => void) => () => void
  }
  modelEvents: {
    onProgress: (listener: (event: ModelProgressEvent) => void) => () => void
  }
}

declare global {
  interface Window {
    localMind: LocalMindApi
  }
}

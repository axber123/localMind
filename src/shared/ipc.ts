export const IPC = {
  app: {
    info: 'app:info',
    stats: 'app:stats',
    recent: 'app:recent',
    openPath: 'app:openPath',
    openExternal: 'app:openExternal'
  },
  websites: {
    list: 'websites:list',
    create: 'websites:create',
    update: 'websites:update',
    remove: 'websites:remove',
    reorder: 'websites:reorder',
    groups: 'websites:groups',
    createGroup: 'websites:createGroup',
    updateGroup: 'websites:updateGroup',
    removeGroup: 'websites:removeGroup',
    tags: 'websites:tags',
    open: 'websites:open'
  },
  folders: {
    list: 'folders:list',
    pick: 'folders:pick',
    update: 'folders:update',
    remove: 'folders:remove',
    open: 'folders:open',
    reauthorize: 'folders:reauthorize',
    refresh: 'folders:refresh',
    scan: 'folders:scan',
    tags: 'folders:tags'
  },
  documents: {
    list: 'documents:list',
    preview: 'documents:preview',
    indexOne: 'documents:indexOne',
    retryFailed: 'documents:retryFailed',
    reindexFolder: 'documents:reindexFolder'
  },
  notes: {
    list: 'notes:list',
    get: 'notes:get',
    create: 'notes:create',
    save: 'notes:save',
    remove: 'notes:remove'
  },
  indexing: {
    jobs: 'indexing:jobs',
    job: 'indexing:job',
    cancel: 'indexing:cancel',
    progress: 'indexing:progress'
  },
  model: {
    status: 'model:status',
    download: 'model:download',
    cancelDownload: 'model:cancelDownload',
    test: 'model:test',
    progress: 'model:progress'
  },
  chat: {
    list: 'chat:list',
    get: 'chat:get',
    messages: 'chat:messages',
    create: 'chat:create',
    update: 'chat:update',
    remove: 'chat:remove',
    start: 'chat:start',
    stop: 'chat:stop',
    retry: 'chat:retry',
    regenerate: 'chat:regenerate',
    export: 'chat:export',
    stream: 'chat:stream',
    done: 'chat:done',
    error: 'chat:error'
  },
  search: {
    global: 'search:global'
  },
  tasks: {
    list: 'tasks:list',
    create: 'tasks:create',
    update: 'tasks:update',
    toggle: 'tasks:toggle',
    remove: 'tasks:remove'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    setApiKey: 'settings:setApiKey',
    clearApiKey: 'settings:clearApiKey',
    testLlm: 'settings:testLlm',
    acceptCloudConsent: 'settings:acceptCloudConsent'
  }
} as const

export const CLOUD_CONSENT_VERSION = 1

import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { AppError } from '../main/db/database'
import { assertAbsoluteDirectoryPath } from '../main/security/paths'
import type { AppLogger } from '../main/logging/logger'
import type { EventBus } from './events'
import type { ServerHandlers, ServerServices } from './handlers'
import type { ServerPaths } from './paths'

export interface HttpServerOptions {
  handlers: ServerHandlers
  events: EventBus
  services: ServerServices
  paths: ServerPaths
  logger: AppLogger
  staticDir: string
  host: string
  port: number
  version: string
  maxJsonBytes?: number
  maxUploadBytes?: number
}

export interface RunningHttpServer {
  url: string
  close: () => Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  response.end(body)
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new AppError('PAYLOAD_TOO_LARGE', '上传内容超过大小限制。')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function sanitizeRootName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 60)
  return cleaned || '上传资料'
}

function sanitizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..' && !/^[a-zA-Z]:$/.test(segment))
  if (segments.length === 0) throw new AppError('INVALID_UPLOAD', '上传文件路径无效。')
  return segments.join(sep)
}

export async function createHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const {
    handlers,
    events,
    services,
    paths,
    logger,
    staticDir,
    host,
    port,
    version,
    maxJsonBytes = 16 * 1024 * 1024,
    maxUploadBytes = 320 * 1024 * 1024
  } = options
  const sseClients = new Set<ServerResponse>()

  const unsubscribe = events.subscribe((channel, payload) => {
    const message = `event: localmind\ndata: ${JSON.stringify({ channel, payload })}\n\n`
    for (const client of sseClients) {
      try {
        client.write(message)
      } catch {
        sseClients.delete(client)
      }
    }
  })

  async function handleInvoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '请求来源校验失败。' } })
      return
    }
    const body = await readBody(request, maxJsonBytes)
    let parsed: { channel?: unknown; args?: unknown }
    try {
      parsed = JSON.parse(body.toString('utf8')) as { channel?: unknown; args?: unknown }
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON。' } })
      return
    }
    if (typeof parsed.channel !== 'string') {
      sendJson(response, 400, { ok: false, error: { code: 'INVALID_CHANNEL', message: '缺少接口名。' } })
      return
    }
    const args = Array.isArray(parsed.args) ? parsed.args : []
    const result = await handlers.invoke(parsed.channel, args)
    sendJson(response, 200, result)
  }

  async function handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: '请求来源校验失败。' } })
      return
    }
    const contentType = request.headers['content-type'] ?? ''
    if (!contentType.startsWith('multipart/form-data')) {
      sendJson(response, 400, { ok: false, error: { code: 'INVALID_UPLOAD', message: '请使用表单上传文件。' } })
      return
    }
    try {
      const body = await readBody(request, maxUploadBytes)
      const formRequest = new Request('http://localhost/api/folders/upload', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(body)
      })
      const form = await formRequest.formData()
      const name = sanitizeRootName(String(form.get('name') ?? '上传资料'))
      const folderIdValue = form.get('folderId')
      const folderId = typeof folderIdValue === 'string' && folderIdValue ? Number(folderIdValue) : null
      const rawPaths = form.get('relativePaths')
      let pathsList: string[] = []
      if (typeof rawPaths === 'string' && rawPaths.trim()) {
        try {
          const parsed = JSON.parse(rawPaths) as unknown
          if (Array.isArray(parsed)) pathsList = parsed.map(String)
        } catch {
          pathsList = rawPaths
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((value) => value.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
        }
      }
      const files = form.getAll('files').filter((value): value is File => typeof value === 'object' && value !== null && 'arrayBuffer' in value)
      if (files.length === 0) throw new AppError('NO_FILES', '没有收到上传文件。')
      if (files.length > 2000) throw new AppError('TOO_MANY_FILES', '一次最多上传 2000 个文件。')

      const root = join(paths.library, `${name}-${Date.now().toString(36)}`)
      await mkdir(root, { recursive: true })
      const rootFolderName = pathsList[0]?.split('/')[0] ?? ''
      let totalBytes = 0
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const rawRelative = pathsList[index] ?? file.name ?? `file-${index}`
        const withoutRoot =
          rootFolderName && rawRelative.startsWith(`${rootFolderName}/`)
            ? rawRelative.slice(rootFolderName.length + 1)
            : rawRelative
        const relativePath = sanitizeRelativePath(withoutRoot)
        const target = join(root, relativePath)
        const buffer = Buffer.from(await file.arrayBuffer())
        totalBytes += buffer.length
        if (buffer.length > 25 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', `文件过大：${relativePath}`)
        if (totalBytes > 300 * 1024 * 1024) throw new AppError('UPLOAD_TOO_LARGE', '本次上传总大小超过 300 MB。')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, buffer)
      }

      const canonical = assertAbsoluteDirectoryPath(root)
      const folder = folderId
        ? services.folders.reauthorize(folderId, canonical, name)
        : services.folders.add(canonical, name)
      try {
        services.indexing.startScan(folder.id)
      } catch {
        // Another job may be running; the folder still exists and can be scanned later.
      }
      logger.info(`uploaded ${files.length} files to ${canonical}`)
      sendJson(response, 200, { ok: true, data: services.folders.get(folder.id) })
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(response, 200, { ok: false, error: { code: error.code, message: error.message, details: error.details } })
        return
      }
      logger.error('folder upload failed', error)
      sendJson(response, 200, { ok: false, error: { code: 'UPLOAD_FAILED', message: '上传失败，请查看服务端日志。' } })
    }
  }

  function handleEvents(request: IncomingMessage, response: ServerResponse): void {
    if (!sameOrigin(request)) {
      response.writeHead(403)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    response.write('retry: 2000\n\n')
    response.write(`event: ready\ndata: ${JSON.stringify({ version })}\n\n`)
    sseClients.add(response)
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
        sseClients.delete(response)
      }
    }, 25_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      sseClients.delete(response)
    })
  }

  function serveStatic(request: IncomingMessage, response: ServerResponse): void {
    if (!existsSync(staticDir)) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('网页前端尚未构建。请先运行：npm run build')
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const decoded = decodeURIComponent(url.pathname)
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
    let filePath = resolve(staticDir, normalize(relativePath))
    if (!filePath.startsWith(resolve(staticDir) + sep) && filePath !== resolve(staticDir)) {
      response.writeHead(403)
      response.end()
      return
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      const hasExtension = extname(filePath) !== ''
      if (!hasExtension) {
        filePath = join(staticDir, 'index.html')
      }
    }
    if (!existsSync(filePath)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    response.writeHead(200, {
      'content-type': type,
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
    })
    createReadStream(filePath).pipe(response)
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname === '/api/health') {
          sendJson(response, 200, { ok: true, version })
          return
        }
        if (url.pathname === '/api/invoke' && request.method === 'POST') {
          await handleInvoke(request, response)
          return
        }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          handleEvents(request, response)
          return
        }
        if (url.pathname === '/api/folders/upload' && request.method === 'POST') {
          await handleUpload(request, response)
          return
        }
        if (url.pathname.startsWith('/api/')) {
          sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在。' } })
          return
        }
        serveStatic(request, response)
      } catch (error) {
        logger.error('http request failed', error)
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务端错误。' } })
        else response.end()
      }
    })()
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolvePromise())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}`
  logger.info(`http server listening on ${url}`)

  return {
    url,
    close: async () => {
      unsubscribe()
      for (const client of sseClients) client.end()
      sseClients.clear()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  }
}
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AppError } from '../db/database'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: { message?: string; type?: string }
}

export interface WorkerLaunchConfig {
  command: string
  args: string[]
  cwd: string
}

export interface EmbeddingClientOptions {
  launch: () => WorkerLaunchConfig
  onLog?: (line: string) => void
  onLoaded?: (dimensions: number) => void
  onError?: (message: string) => void
}

export class EmbeddingClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private buffer = ''
  private stderrBuffer = ''
  private closing = false

  constructor(private readonly options: EmbeddingClientOptions) {}

  async ensureLoaded(modelDir: string, signal?: AbortSignal): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.load(modelDir, signal).finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async load(modelDir: string, signal?: AbortSignal): Promise<void> {
    if (readonlyDirectoryMissing(modelDir)) {
      throw new AppError('MODEL_NOT_INSTALLED', '本地 Embedding 模型尚未下载，请先在设置中下载模型。')
    }
    this.spawnWorker(modelDir)
    try {
      await this.request('load', {}, 180_000, signal)
      this.loaded = true
      this.options.onLoaded?.(384)
    } catch (error) {
      this.markBroken()
      const message = error instanceof Error ? error.message : String(error)
      this.options.onError?.(message)
      throw new AppError('EMBEDDING_LOAD_FAILED', '本地 Embedding 模型加载失败，请重试或重新下载模型。', message)
    }
  }

  private spawnWorker(modelDir: string): void {
    if (this.process && !this.process.killed) return
    const config = this.options.launch()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      LOCALMIND_EMBED_THREADS: process.env.LOCALMIND_EMBED_THREADS ?? '4'
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(config.command, [...config.args, '--model-dir', modelDir], {
      cwd: config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.process = child
    this.buffer = ''
    this.stderrBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      const lines = this.stderrBuffer.split(/\r?\n/)
      this.stderrBuffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.options.onLog?.(line.trim())
    })
    child.on('error', (error) => this.failAll(new AppError('EMBEDDING_WORKER_SPAWN', '无法启动本地 Embedding 进程。', error.message)))
    child.on('exit', (code, signal) => {
      this.process = null
      this.loaded = false
      if (!this.closing) {
        this.failAll(
          new AppError(
            'EMBEDDING_WORKER_EXIT',
            `本地 Embedding 进程意外退出（${signal ?? code ?? 'unknown'}）。请重试。`
          )
        )
      }
    })
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let response: WorkerResponse
      try {
        response = JSON.parse(line) as WorkerResponse
      } catch {
        this.options.onLog?.(`worker 输出无法解析：${line.slice(0, 200)}`)
        continue
      }
      const pending = this.pending.get(response.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if (response.ok) {
        pending.resolve(response.result)
      } else {
        pending.reject(new Error(response.error?.message ?? 'Embedding worker error'))
      }
    }
  }

  private request<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (!this.process) return Promise.reject(new AppError('EMBEDDING_WORKER_NOT_RUNNING', '本地 Embedding 进程未启动。'))
    if (signal?.aborted) return Promise.reject(new AppError('EMBEDDING_ABORTED', 'Embedding 任务已取消。'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('EMBEDDING_TIMEOUT', '本地 Embedding 请求超时。'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (this.pending.delete(id)) {
              clearTimeout(timer)
              reject(new AppError('EMBEDDING_ABORTED', 'Embedding 任务已取消。'))
            }
          },
          { once: true }
        )
      }
      try {
        this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new AppError('EMBEDDING_WORKER_WRITE', '无法向本地 Embedding 进程发送请求。', String(error)))
      }
    })
  }

  async embed(texts: string[], prefix: 'query' | 'passage', signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (!this.loaded) throw new AppError('MODEL_NOT_LOADED', '本地 Embedding 模型尚未加载。')
    const result = await this.request<{ data: string; count: number; dimensions: number }>(
      'embed',
      { texts, prefix },
      180_000,
      signal
    )
    const bytes = Buffer.from(result.data, 'base64')
    const copy = Uint8Array.from(bytes)
    const flat = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
    const vectors: Float32Array[] = []
    for (let index = 0; index < result.count; index += 1) {
      vectors.push(flat.slice(index * result.dimensions, (index + 1) * result.dimensions))
    }
    return vectors
  }

  async countTokens(texts: string[], signal?: AbortSignal): Promise<number[]> {
    if (!this.loaded) throw new AppError('MODEL_NOT_LOADED', '本地 Embedding 模型尚未加载。')
    const result = await this.request<{ counts: number[] }>('count_tokens', { texts }, 60_000, signal)
    return result.counts
  }

  isLoaded(): boolean {
    return this.loaded
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private markBroken(): void {
    this.loaded = false
  }

  async shutdown(): Promise<void> {
    this.closing = true
    if (!this.process) return
    try {
      await this.request('shutdown', {}, 2_000)
    } catch {
      // Process may already be gone.
    }
    this.process?.kill()
    this.process = null
    this.loaded = false
  }
}

function readonlyDirectoryMissing(path: string): boolean {
  try {
    return !existsSync(path)
  } catch {
    return true
  }
}

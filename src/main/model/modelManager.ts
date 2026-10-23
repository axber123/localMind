import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppDatabase } from '../db/database'
import { AppError } from '../db/database'
import type { ModelProgressEvent, ModelStatus } from '../../shared/types'
import type { CurrentIndexConfig } from '../indexing/indexConfig'
import { MODEL_DIMENSIONS, MODEL_DISPLAY_NAME, MODEL_ID, MODEL_MAX_TOKENS } from '../indexing/indexConfig'

const MODEL_REPO = 'intfloat/multilingual-e5-small'
const MODEL_REVISION = 'master'
const MODEL_BASE_URL = `https://modelscope.cn/models/${MODEL_REPO}/resolve/${MODEL_REVISION}/`
const MODEL_DIR_NAME = 'multilingual-e5-small-ca456c06b3a9'

interface ModelFile {
  remote: string
  local: string
  size: number
  sha256: string
}

const MODEL_FILES: ModelFile[] = [
  {
    remote: 'onnx/model.onnx',
    local: 'onnx/model.onnx',
    size: 470268510,
    sha256: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665'
  },
  {
    remote: 'tokenizer.json',
    local: 'tokenizer.json',
    size: 17082730,
    sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'
  },
  { remote: 'config.json', local: 'config.json', size: 655, sha256: '69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959' },
  {
    remote: 'tokenizer_config.json',
    local: 'tokenizer_config.json',
    size: 443,
    sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'
  },
  {
    remote: 'special_tokens_map.json',
    local: 'special_tokens_map.json',
    size: 167,
    sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7'
  },
  { remote: 'onnx/config.json', local: 'onnx/config.json', size: 653, sha256: 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6' }
]

const TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.size, 0)

interface InstalledMarker {
  modelId: string
  installedAt: string
  files: Array<{ local: string; size: number; sha256: string }>
}

export class ModelManager {
  private state: ModelStatus['state'] = 'not_installed'
  private message: string | null = null
  private downloadedBytes = 0
  private downloading = false
  private cancelController: AbortController | null = null
  private downloadPromise: Promise<ModelStatus> | null = null
  private installedAt: string | null = null
  private errorState = false
  private lastEmit = 0

  constructor(
    private readonly db: AppDatabase,
    private readonly modelsRoot: string,
    private readonly getIndexConfig: () => CurrentIndexConfig,
    private readonly emit: (event: ModelProgressEvent) => void
  ) {}

  get modelDir(): string {
    return join(this.modelsRoot, MODEL_DIR_NAME)
  }

  needsReindex(): boolean {
    const config = this.getIndexConfig()
    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM documents
       WHERE active_generation IS NOT NULL
         AND (index_model_id IS NULL OR index_model_id <> ? OR index_config_version IS NULL OR index_config_version <> ?)`,
      config.modelId,
      config.configVersion
    )
    return (row?.count ?? 0) > 0
  }

  async refreshInstalledState(): Promise<void> {
    if (this.downloading) return
    try {
      this.installedAt = null
      this.downloadedBytes = 0
      let allPresent = true
      for (const file of MODEL_FILES) {
        const full = join(this.modelDir, file.local)
        try {
          const info = await stat(full)
          this.downloadedBytes += Math.min(info.size, file.size)
          if (info.size !== file.size) allPresent = false
        } catch {
          allPresent = false
        }
      }
      if (allPresent) {
        try {
          const marker = JSON.parse(await readFile(join(this.modelDir, '.installed.json'), 'utf8')) as InstalledMarker
          if (marker.modelId === MODEL_ID) {
            this.installedAt = marker.installedAt
            if (!this.errorState) {
              this.state = 'ready'
              this.message = null
            }
            return
          }
        } catch {
          // Files exist but the verification marker is missing; treat as not installed.
        }
      }
      if (!this.errorState) {
        this.state = 'not_installed'
        this.message = allPresent ? '模型文件未通过校验，请重新下载。' : '本地 Embedding 模型尚未下载。'
      }
    } catch {
      this.state = 'not_installed'
    }
  }

  status(): ModelStatus {
    return {
      state: this.state,
      modelId: MODEL_ID,
      displayName: MODEL_DISPLAY_NAME,
      license: 'MIT',
      dimensions: MODEL_DIMENSIONS,
      maxTokens: MODEL_MAX_TOKENS,
      downloadedBytes: this.downloadedBytes,
      totalBytes: TOTAL_BYTES,
      progress: TOTAL_BYTES > 0 ? Math.min(1, this.downloadedBytes / TOTAL_BYTES) : 0,
      message: this.message,
      installedAt: this.installedAt,
      needsReindex: this.needsReindex()
    }
  }

  markLoading(): void {
    this.state = 'loading'
    this.message = '正在加载本地 Embedding 模型…'
    this.emitProgress(true)
  }

  markReady(): void {
    this.state = 'ready'
    this.message = null
    this.errorState = false
    this.emitProgress(true)
  }

  markError(message: string): void {
    this.state = 'error'
    this.message = message
    this.errorState = true
    this.emitProgress(true)
  }

  cancelDownload(): void {
    this.cancelController?.abort()
  }

  async download(): Promise<ModelStatus> {
    if (this.downloading && this.downloadPromise) return this.downloadPromise
    if (this.state === 'ready' && this.installedAt) return this.status()
    this.downloading = true
    this.state = 'downloading'
    this.message = '正在从 ModelScope 下载模型文件（约 465 MB）…'
    this.emitProgress(true)
    const controller = new AbortController()
    this.cancelController = controller
    this.downloadPromise = this.performDownload(controller.signal)
      .then(async () => {
        await this.refreshInstalledState()
        return this.status()
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          this.state = 'not_installed'
          this.message = '模型下载已取消。已下载的部分会在重试时继续。'
        } else {
          this.state = 'error'
          this.errorState = true
          this.message = `模型下载失败：${error instanceof Error ? error.message : String(error)}`
        }
        this.emitProgress(true)
        return this.status()
      })
      .finally(() => {
        this.downloading = false
        this.cancelController = null
        this.downloadPromise = null
      })
    return this.downloadPromise
  }

  private async performDownload(signal: AbortSignal): Promise<void> {
    await mkdir(join(this.modelDir, 'onnx'), { recursive: true })
    this.downloadedBytes = 0
    for (const file of MODEL_FILES) {
      if (signal.aborted) throw new AppError('MODEL_DOWNLOAD_CANCELLED', '下载已取消')
      const finalPath = join(this.modelDir, file.local)
      const partPath = `${finalPath}.part`
      const existing = await fileSize(finalPath)
      if (existing === file.size) {
        this.downloadedBytes += file.size
        this.emitProgress()
        continue
      }
      const partSize = await fileSize(partPath)
      const offset = partSize > 0 && partSize < file.size ? partSize : 0
      this.downloadedBytes += partSize
      if (offset === 0) await writeFile(partPath, Buffer.alloc(0))
      const response = await fetch(`${MODEL_BASE_URL}${file.remote}`, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal,
        redirect: 'follow'
      })
      if (!response.ok) {
        throw new AppError('MODEL_DOWNLOAD_HTTP', `下载 ${file.remote} 失败（HTTP ${response.status}）。`)
      }
      const append = offset > 0 && response.status === 206
      if (!append && partSize > 0) this.downloadedBytes -= partSize
      const handle = await open(partPath, append ? 'a' : 'w')
      let written = append ? offset : 0
      try {
        if (!response.body) throw new AppError('MODEL_DOWNLOAD_EMPTY', `下载 ${file.remote} 时没有收到数据。`)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (signal.aborted) throw new AppError('MODEL_DOWNLOAD_CANCELLED', '下载已取消')
          await handle.write(chunk)
          written += chunk.byteLength
          this.downloadedBytes += chunk.byteLength
          this.emitProgress()
        }
      } finally {
        await handle.close()
      }
      if (written !== file.size) {
        this.downloadedBytes -= written
        throw new AppError(
          'MODEL_SIZE_MISMATCH',
          `模型文件 ${file.remote} 大小不完整（期望 ${file.size}，实际 ${written}）。请重试。`
        )
      }
      const hash = await hashFile(partPath)
      if (hash !== file.sha256) {
        this.downloadedBytes -= written
        throw new AppError('MODEL_HASH_MISMATCH', `模型文件 ${file.remote} 校验失败，请删除后重试。`)
      }
      await rename(partPath, finalPath)
      this.emitProgress(true)
    }
    const marker: InstalledMarker = {
      modelId: MODEL_ID,
      installedAt: new Date().toISOString(),
      files: MODEL_FILES.map((file) => ({ local: file.local, size: file.size, sha256: file.sha256 }))
    }
    await writeFile(join(this.modelDir, '.installed.json'), JSON.stringify(marker, null, 2), 'utf8')
    this.installedAt = marker.installedAt
    this.errorState = false
    this.state = 'ready'
    this.message = null
    this.emitProgress(true)
  }

  private emitProgress(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.emit({
      state: this.state,
      progress: TOTAL_BYTES > 0 ? Math.min(1, this.downloadedBytes / TOTAL_BYTES) : 0,
      downloadedBytes: this.downloadedBytes,
      totalBytes: TOTAL_BYTES,
      message: this.message
    })
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EncryptionAdapter {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

interface SecretFile {
  version: 1
  data: string
}

/**
 * API keys never go into SQLite or the renderer bundle. On Windows safeStorage
 * is backed by DPAPI. If encryption is unavailable we keep the key in memory
 * only and report that it is not persisted.
 */
export class CredentialVault {
  private memoryKey: string | null = null
  private persistent = false

  constructor(
    private readonly filePath: string,
    private readonly encryption: EncryptionAdapter
  ) {}

  getApiKey(): string | null {
    if (this.memoryKey) return this.memoryKey
    if (!this.encryption.isEncryptionAvailable()) return null
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as SecretFile
      if (parsed.version !== 1 || typeof parsed.data !== 'string') return null
      this.memoryKey = this.encryption.decryptString(Buffer.from(parsed.data, 'base64'))
      this.persistent = true
      return this.memoryKey
    } catch {
      return null
    }
  }

  hasApiKey(): boolean {
    return Boolean(this.getApiKey())
  }

  keyHint(): string | null {
    const key = this.getApiKey()
    if (!key) return null
    return `••••${key.slice(-4)}`
  }

  isPersistent(): boolean {
    return this.persistent
  }

  setApiKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('API Key 不能为空')
    this.memoryKey = trimmed
    if (!this.encryption.isEncryptionAvailable()) {
      this.persistent = false
      return
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const encrypted = this.encryption.encryptString(trimmed)
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, data: encrypted.toString('base64') } satisfies SecretFile), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temp, this.filePath)
    this.persistent = true
  }

  clear(): void {
    this.memoryKey = null
    this.persistent = false
    try {
      writeFileSync(this.filePath, JSON.stringify({ version: 1, data: '' }), 'utf8')
    } catch {
      // Nothing else can be done; the next start will treat this as no key.
    }
  }
}

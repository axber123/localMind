import type { AppDatabase } from '../db/database'
import { nowIso } from '../db/database'
import type { AppSettings, LlmSettings, RagSettings, SettingsPatch } from '../../shared/types'
import { CLOUD_CONSENT_VERSION } from '../../shared/ipc'
import type { CredentialVault } from '../security/credentialVault'

const DEFAULT_LLM: LlmSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  timeoutMs: 60_000,
  stream: true,
  temperature: 0.3
}

const DEFAULT_RAG: RagSettings = {
  topK: 6,
  scoreThreshold: 0.25,
  maxContextChars: 7_000,
  chunkSize: 256,
  chunkOverlap: 48
}

interface SettingsRow {
  key: string
  value: string
}

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly vault: CredentialVault
  ) {}

  private readJson<T>(key: string, fallback: T): T {
    const row = this.db.get<SettingsRow>('SELECT value FROM settings WHERE key = ?', key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  private writeJson(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      nowIso()
    )
  }

  getLlm(): LlmSettings {
    return { ...DEFAULT_LLM, ...this.readJson<Partial<LlmSettings>>('llm', {}) }
  }

  getRag(): RagSettings {
    return { ...DEFAULT_RAG, ...this.readJson<Partial<RagSettings>>('rag', {}) }
  }

  getApiKey(): string | null {
    return this.vault.getApiKey()
  }

  getCloudConsent(): { origins: string[]; version: number } {
    const value = this.readJson<{ origins?: string[]; version?: number }>('cloudConsent', {})
    return { origins: value.origins ?? [], version: value.version ?? 0 }
  }

  get(): AppSettings {
    return {
      llm: this.getLlm(),
      rag: this.getRag(),
      hasApiKey: this.vault.hasApiKey(),
      apiKeyHint: this.vault.keyHint(),
      cloudConsentOrigins: this.getCloudConsent().origins,
      cloudConsentVersion: this.getCloudConsent().version
    }
  }

  update(patch: SettingsPatch): AppSettings {
    if (patch.llm) {
      const next = { ...this.getLlm(), ...patch.llm }
      next.timeoutMs = Math.min(300_000, Math.max(5_000, Math.floor(next.timeoutMs)))
      next.temperature = Math.min(2, Math.max(0, next.temperature))
      this.writeJson('llm', next)
    }
    if (patch.rag) {
      const next = { ...this.getRag(), ...patch.rag }
      next.topK = Math.min(20, Math.max(1, Math.floor(next.topK)))
      next.scoreThreshold = Math.min(1, Math.max(-1, next.scoreThreshold))
      next.maxContextChars = Math.min(30_000, Math.max(1_000, Math.floor(next.maxContextChars)))
      next.chunkSize = Math.min(480, Math.max(64, Math.floor(next.chunkSize)))
      next.chunkOverlap = Math.min(next.chunkSize - 16, Math.max(0, Math.floor(next.chunkOverlap)))
      this.writeJson('rag', next)
    }
    return this.get()
  }

  setApiKey(key: string): AppSettings {
    this.vault.setApiKey(key)
    return this.get()
  }

  clearApiKey(): AppSettings {
    this.vault.clear()
    return this.get()
  }

  acceptCloudConsent(origin: string, version: number): AppSettings {
    const current = this.getCloudConsent()
    const origins = [...new Set([...current.origins, origin])]
    this.writeJson('cloudConsent', { origins, version: Math.max(current.version, version, CLOUD_CONSENT_VERSION) })
    return this.get()
  }

  hasCloudConsent(origin: string): boolean {
    const consent = this.getCloudConsent()
    return consent.version >= CLOUD_CONSENT_VERSION && consent.origins.includes(origin)
  }
}

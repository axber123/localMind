import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EncryptionAdapter } from '../main/security/credentialVault'

/**
 * Web-mode replacement for Electron safeStorage.
 *
 * The desktop app used Windows DPAPI through safeStorage. A plain Node server
 * has no access to DPAPI, so we keep a random 256-bit key in the data directory
 * (user-profile scoped, 0600) and encrypt API keys with AES-256-GCM. The key is
 * only ever used by the server process and is never sent to the browser.
 */
export function createFileEncryptionAdapter(dataDir: string): EncryptionAdapter {
  const keyPath = join(dataDir, 'secret.key')
  let key: Buffer
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf8').trim()
    key = Buffer.from(stored, 'hex')
    if (key.length !== 32) throw new Error('secret.key 已损坏，请删除后重新配置 API Key。')
  } else {
    key = randomBytes(32)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  }

  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string): Buffer => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, encrypted])
    },
    decryptString: (value: Buffer): string => {
      if (value.length < 29) throw new Error('加密数据不完整。')
      const iv = value.subarray(0, 12)
      const tag = value.subarray(12, 28)
      const data = value.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    }
  }
}
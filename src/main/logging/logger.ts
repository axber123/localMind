import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024

export class AppLogger {
  private readonly file: string

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'localmind.log')
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  warn(message: string): void {
    this.write('WARN', message)
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : error ? String(error) : ''
    this.write('ERROR', `${message}${detail ? `\n${detail}` : ''}`)
  }

  private write(level: string, message: string): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_LOG_BYTES) {
        renameSync(this.file, `${this.file}.1`)
      }
      const sanitized = message
        .replace(/(sk-|Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***')
        .replace(/("apiKey"\s*:\s*")[^"]+/gi, '$1***')
      appendFileSync(this.file, `[${new Date().toISOString()}] ${level} ${sanitized}\n`, 'utf8')
    } catch {
      // Logging must never take down the app.
    }
  }
}

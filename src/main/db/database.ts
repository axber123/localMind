import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { migrations } from './migrations'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class AppDatabase {
  readonly db: DatabaseSync
  readonly path: string

  constructor(path: string) {
    this.path = path
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.runMigrations()
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    const applied = this.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    const appliedVersions = new Set(applied.map((row) => row.version))
    const latest = migrations[migrations.length - 1]?.version ?? 0
    const current = applied.at(-1)?.version ?? 0
    if (current > latest) {
      throw new AppError(
        'DB_SCHEMA_NEWER',
        '数据库版本高于当前应用版本，已停止写入以保护数据。请使用更新版本的 LocalMind。'
      )
    }
    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version))
    if (pending.length === 0) return
    if (this.path !== ':memory:' && existsSync(this.path) && statSync(this.path).size > 0 && applied.length > 0) {
      this.db.exec('PRAGMA wal_checkpoint(FULL)')
      const backupDir = join(dirname(this.path), 'backups')
      mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(this.path, join(backupDir, `localmind-before-migration-${current}-${stamp}.db`))
    }
    for (const migration of pending) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(migration.sql)
        this.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          new Date().toISOString()
        )
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw new AppError(
          'DB_MIGRATION_FAILED',
          `数据库迁移 ${migration.version}_${migration.name} 失败。原数据库未被删除，请查看日志。`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[]
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...(params as never[]))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A failed rollback is reported by the original error; keep it visible.
      }
      throw error
    }
  }

  ftsAvailable(): boolean {
    try {
      const row = this.get<{ ok: number }>(
        "SELECT 1 AS ok FROM sqlite_master WHERE name = 'search_fts' AND type = 'table'"
      )
      return row?.ok === 1
    } catch {
      return false
    }
  }

  close(): void {
    this.db.close()
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

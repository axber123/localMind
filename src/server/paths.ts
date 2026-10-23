import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface ServerPaths {
  userData: string
  database: string
  notes: string
  models: string
  logs: string
  library: string
  trash: string
  pythonWorker: string
}

function isWritableDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true })
    const probe = join(directory, `.localmind-write-${process.pid}`)
    writeFileSync(probe, 'ok', 'utf8')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function appDataDirectory(): string {
  const appData = process.env.APPDATA
  if (appData) return join(appData, 'LocalMindWeb')
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, 'LocalMindWeb')
  return join(homedir(), '.localmind')
}

/**
 * The web server keeps the same data layout as the desktop app so an existing
 * `.userdata` directory (database, notes, downloaded local model) can be reused.
 */
export function resolveServerPaths(): ServerPaths {
  const preferred = [
    process.env.LOCALMIND_USER_DATA,
    join(process.cwd(), '.userdata'),
    appDataDirectory(),
    join(homedir(), 'LocalMindData'),
    join(process.env.TEMP ?? homedir(), 'LocalMindData')
  ].filter((value): value is string => Boolean(value))

  let userData: string | null = null
  for (const candidate of preferred) {
    if (isWritableDirectory(candidate)) {
      userData = resolve(candidate)
      break
    }
  }
  if (!userData) throw new Error('找不到可写入的数据目录。请设置 LOCALMIND_USER_DATA 环境变量。')

  const notes = join(userData, 'notes')
  const models = join(userData, 'models')
  const logs = join(userData, 'logs')
  const library = join(userData, 'library')
  const trash = join(userData, 'trash')
  for (const directory of [notes, models, logs, library, trash]) mkdirSync(directory, { recursive: true })

  const python = process.env.LOCALMIND_PYTHON || 'python'
  const workerScript = join(process.cwd(), 'python', 'embedding_worker.py')

  return {
    userData,
    database: join(userData, 'localmind.db'),
    notes,
    models,
    logs,
    library,
    trash,
    pythonWorker: `${python} ${workerScript}`
  }
}

export function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}
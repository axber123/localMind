import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { AppError } from '../db/database'

export interface OpenDirectoryDeps {
  platform?: NodeJS.Platform
  statPath?: (path: string) => Promise<{ isDirectory(): boolean }>
  openExplorer?: (path: string) => Promise<void>
  openShell?: (path: string) => Promise<string>
}

export function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Opens a local directory with the operating system file manager.
 *
 * On Windows this deliberately uses `explorer.exe`. Electron's `shell.openPath`
 * delegates to `ShellExecuteEx`, which pops up the native "Windows cannot access
 * the specified device, path, or file" dialog when the shell cannot complete the
 * request. Explorer only opens a window and lets the app report failures as a
 * normal toast instead of leaking an OS error dialog.
 */
export function openExplorerDirectory(path: string): Promise<void> {
  return spawnDetached('explorer.exe', [path])
}

export async function openDirectory(path: string, deps: OpenDirectoryDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const statPath = deps.statPath ?? ((target: string) => stat(target))

  let isDirectory = false
  try {
    const info = await statPath(path)
    isDirectory = info.isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new AppError('FOLDER_MISSING', '文件夹已被移动或删除，请点击“重新定位”后重试。')
  }

  if (platform === 'win32') {
    const openExplorer = deps.openExplorer ?? openExplorerDirectory
    try {
      await openExplorer(path)
      return
    } catch (error) {
      throw new AppError(
        'OPEN_FOLDER_FAILED',
        '无法打开文件夹，请确认当前 Windows 账户对该目录有访问权限。',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  const openShell =
    deps.openShell ??
    (async (target: string) => {
      await spawnDetached(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
      return ''
    })
  const error = await openShell(path)
  if (error) {
    throw new AppError('OPEN_FOLDER_FAILED', '无法打开文件夹，请确认目录仍然存在并且当前账户有访问权限。', error)
  }
}
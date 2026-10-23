import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/db/database'
import { openDirectory } from '../../src/main/platform/openDirectory'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('openDirectory', () => {
  it('refuses to open a missing path and never calls the shell', async () => {
    let called = false
    await expect(
      openDirectory('F:\\definitely-missing-localmind-folder', {
        platform: 'linux',
        openShell: async () => {
          called = true
          return ''
        }
      })
    ).rejects.toMatchObject({ code: 'FOLDER_MISSING' })
    expect(called).toBe(false)
  })

  it('opens an existing directory through the platform opener', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-open-'))
    dirs.push(dir)
    const opened: string[] = []
    await openDirectory(dir, {
      platform: 'linux',
      openShell: async (path) => {
        opened.push(path)
        return ''
      }
    })
    expect(opened).toEqual([dir])
  })

  it('uses explorer on Windows and reports opener failures as OPEN_FOLDER_FAILED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-open-'))
    dirs.push(dir)
    const opened: string[] = []
    await openDirectory(dir, {
      platform: 'win32',
      openExplorer: async (path) => {
        opened.push(path)
      }
    })
    expect(opened).toEqual([dir])

    await expect(
      openDirectory(dir, {
        platform: 'win32',
        openExplorer: async () => {
          throw new Error('EPERM')
        }
      })
    ).rejects.toMatchObject({ code: 'OPEN_FOLDER_FAILED' })
  })

  it('surfaces shell.openPath error strings on non-Windows platforms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'localmind-open-'))
    dirs.push(dir)
    await expect(
      openDirectory(dir, {
        platform: 'darwin',
        openShell: async () => 'The file could not be opened'
      })
    ).rejects.toBeInstanceOf(AppError)
  })
})
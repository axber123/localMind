import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, parse } from 'node:path'
import { AppError } from '../db/database'

export function canonicalExistingPath(input: string): string {
  try {
    return realpathSync.native(input)
  } catch {
    throw new AppError('PATH_NOT_FOUND', '路径不存在或无法访问。')
  }
}

export function assertAbsoluteDirectoryPath(input: string): string {
  if (!input || !isAbsolute(input)) throw new AppError('INVALID_PATH', '必须选择绝对路径。')
  const root = parse(input).root
  if (resolve(input).toLowerCase() === resolve(root).toLowerCase()) {
    throw new AppError('UNSAFE_PATH', '不能把整个磁盘根目录作为学习资料目录。')
  }
  return canonicalExistingPath(input)
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function assertPathInside(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) {
    throw new AppError('PATH_OUTSIDE_ROOT', '文件路径不在已授权的资料目录内，操作已拒绝。')
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12)
}

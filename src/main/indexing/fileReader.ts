import { open, stat } from 'node:fs/promises'
import { AppError } from '../db/database'

export interface TextReadResult {
  content: string
  truncated: boolean
  totalBytes: number
  modifiedAt: string
}

export async function readTextFile(filePath: string, maxBytes: number): Promise<TextReadResult> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new AppError('NOT_A_FILE', '目标不是普通文件。')
  const length = Math.min(info.size, maxBytes)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return {
      content: decodeBuffer(buffer),
      truncated: info.size > maxBytes,
      totalBytes: info.size,
      modifiedAt: info.mtime.toISOString()
    }
  } finally {
    await handle.close()
  }
}

export async function readWholeTextFile(filePath: string): Promise<{ content: string; buffer: Buffer; modifiedAt: string; size: number }> {
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(filePath)
  return { content: decodeBuffer(buffer), buffer, modifiedAt: (await stat(filePath)).mtime.toISOString(), size: buffer.length }
}

export function decodeBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) {
    throw new AppError('BINARY_FILE', '文件看起来是二进制文件，已跳过内容解析。')
  }
  let content: string
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    content = buffer.subarray(3).toString('utf8')
  } else {
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      try {
        content = new TextDecoder('gb18030').decode(buffer)
      } catch {
        throw new AppError('TEXT_DECODE_FAILED', '文件编码无法识别，仅支持 UTF-8 或 GB18030。')
      }
    }
  }
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function countLines(content: string): number {
  if (!content) return 0
  let lines = 1
  for (const char of content) if (char === '\n') lines += 1
  return lines
}

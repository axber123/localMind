import type { ApiResult } from '../../../shared/types'

export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

export async function unwrap<T>(request: Promise<ApiResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new ClientError(result.error.code, result.error.message, result.error.details)
  return result.data
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

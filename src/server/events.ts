export interface EventBus {
  subscribe: (listener: (channel: string, payload: unknown) => void) => () => void
  emit: (channel: string, payload: unknown) => void
}

export function createEventBus(): EventBus {
  const listeners = new Set<(channel: string, payload: unknown) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(channel, payload) {
      for (const listener of listeners) {
        try {
          listener(channel, payload)
        } catch {
          // A broken SSE client must not break indexing or chat streams.
        }
      }
    }
  }
}
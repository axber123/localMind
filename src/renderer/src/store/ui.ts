import { create } from 'zustand'
import type { RetrievalScope } from '../../../shared/types'

interface UiState {
  aiOpen: boolean
  aiScope: RetrievalScope
  aiScopeLabel: string
  setAiOpen: (open: boolean) => void
  toggleAi: () => void
  setAiScope: (scope: RetrievalScope, label?: string) => void
}

export const useUiStore = create<UiState>((set) => ({
  aiOpen: false,
  aiScope: {},
  aiScopeLabel: '全部资料',
  setAiOpen: (open) => set({ aiOpen: open }),
  toggleAi: () => set((state) => ({ aiOpen: !state.aiOpen })),
  setAiScope: (scope, label) =>
    set({ aiScope: scope, aiScopeLabel: label ?? (Object.keys(scope).length === 0 ? '全部资料' : '当前范围'), aiOpen: true })
}))

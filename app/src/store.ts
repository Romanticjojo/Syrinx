import { create } from 'zustand'
import type { Take } from './types'

/** 四个视图：曲库 → 预览 → 演奏 → 回放 */
export type View = 'home' | 'preview' | 'perform' | 'result'

interface AppState {
  view: View
  currentSongId: string | null
  favorites: string[]
  /** 最近一次演奏会话的结果 */
  lastTake: Take | null
  go: (view: View, songId?: string) => void
  toggleFavorite: (id: string) => void
  setTake: (take: Take) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'home',
  currentSongId: null,
  favorites: [],
  lastTake: null,
  go: (view, songId) =>
    set((s) => ({
      view,
      currentSongId: songId ?? (view === 'home' ? null : s.currentSongId),
    })),
  toggleFavorite: (id) =>
    set((s) => ({
      favorites: s.favorites.includes(id)
        ? s.favorites.filter((f) => f !== id)
        : [...s.favorites, id],
    })),
  setTake: (take) => set({ lastTake: take }),
}))

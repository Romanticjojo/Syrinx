import type { PracticeConfig } from './practice/model'
import { create } from 'zustand'
import type { PerformanceSession, PerformanceStatus, PitchPoint, Take, TuneStats } from './types'

/** 四个视图：曲库 → 预览 → 演奏 → 回放 */
export type View = 'home' | 'preview' | 'perform' | 'result' | 'history'

interface AppState {
  practiceConfig: PracticeConfig | null
  storageError: string | null
  setPracticeConfig: (config: PracticeConfig | null) => void
  openPractice: (take: Take) => void
  view: View
  currentSongId: string | null
  favorites: string[]
  /** 最近一次演奏会话的结果 */
  lastTake: Take | null
  /** 当前演奏专属状态；新会话创建时立即与旧结果隔离 */
  performanceSession: PerformanceSession | null
  go: (view: View, songId?: string) => void
  toggleFavorite: (id: string) => void
  beginPerformance: (songId: string) => string
  setPerformanceStatus: (
    sessionId: string,
    status: PerformanceStatus,
    message?: string,
  ) => boolean
  completePerformance: (sessionId: string, take: Take) => boolean
  cacheTakeAnalysis: (
    sessionId: string,
    pitchTrack: PitchPoint[],
    stats: TuneStats,
  ) => boolean
}

let sessionSeq = 0
const nextSessionId = (): string => `performance-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${++sessionSeq}`}`

export const useAppStore = create<AppState>((set, get) => ({
  practiceConfig: null,
  storageError: null,
  setPracticeConfig: (practiceConfig) => set({ practiceConfig }),
  openPractice: (take) => {
    const previous = get().lastTake
    if (previous?.audioUrl && previous.audioUrl !== take.audioUrl) URL.revokeObjectURL(previous.audioUrl)
    set({ view: 'result', currentSongId: take.songId, lastTake: take, storageError: null, performanceSession: { id: take.sessionId, songId: take.songId, status: 'completed', take } })
  },
  view: 'home',
  currentSongId: null,
  favorites: [],
  lastTake: null,
  performanceSession: null,
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
  beginPerformance: (songId) => {
    const previous = get().lastTake
    if (previous?.audioUrl) URL.revokeObjectURL(previous.audioUrl)
    const id = nextSessionId()
    set({
      lastTake: null,
      storageError: null,
      performanceSession: { id, songId, status: 'preparing', take: null },
    })
    return id
  },
  setPerformanceStatus: (sessionId, status, message) => {
    let accepted = false
    set((s) => {
      if (s.performanceSession?.id !== sessionId) return s
      accepted = true
      return {
        lastTake: status === 'completed' ? s.lastTake : null,
        performanceSession: {
          ...s.performanceSession,
          status,
          take: status === 'completed' ? s.performanceSession.take : null,
          ...(message ? { message } : { message: undefined }),
        },
      }
    })
    return accepted
  },
  completePerformance: (sessionId, take) => {
    let accepted = false
    set((s) => {
      if (s.performanceSession?.id !== sessionId || take.sessionId !== sessionId) return s
      accepted = true
      return {
        lastTake: take,
        performanceSession: {
          ...s.performanceSession,
          status: 'completed',
          take,
          message: undefined,
        },
      }
    })
    return accepted
  },
  cacheTakeAnalysis: (sessionId, pitchTrack, stats) => {
    let accepted = false
    set((s) => {
      const session = s.performanceSession
      if (session?.id !== sessionId || session.status !== 'completed' || !session.take) return s
      accepted = true
      const take = { ...session.take, pitchTrack, stats }
      return {
        lastTake: take,
        performanceSession: { ...session, take },
      }
    })
    return accepted
  },
}))

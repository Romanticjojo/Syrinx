import { create } from 'zustand'
import type { PerformanceSegment, PerformanceSession, PerformanceStatus, PitchPoint, Take, TuneStats } from './types'

/** 四个视图：曲库 → 预览 → 演奏 → 回放 */
export type View = 'home' | 'preview' | 'perform' | 'result'

interface AppState {
  view: View
  libraryTab: 'featured' | 'personal'
  setLibraryTab: (tab: 'featured' | 'personal') => void
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
  appendPerformanceSegment: (sessionId: string, segment: PerformanceSegment) => boolean
  finishPerformance: (sessionId: string, message?: string) => boolean
  cacheSegmentAnalysis: (
    sessionId: string,
    segmentId: string,
    pitchTrack: PitchPoint[],
    stats: TuneStats,
  ) => boolean
  cacheTakeAnalysis: (
    sessionId: string,
    pitchTrack: PitchPoint[],
    stats: TuneStats,
  ) => boolean
}

let sessionSeq = 0
const nextSessionId = (): string => `performance-${Date.now()}-${++sessionSeq}`

export const useAppStore = create<AppState>((set) => ({
  view: 'home',
  libraryTab: 'featured',
  setLibraryTab: (libraryTab) => set({ libraryTab }),
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
    const id = nextSessionId()
    set({
      lastTake: null,
      performanceSession: { id, songId, status: 'preparing', take: null, segments: [] },
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
      const segment: PerformanceSegment = {
        ...take,
        id: `legacy-${sessionId}`,
      }
      return {
        lastTake: take,
        performanceSession: {
          ...s.performanceSession,
          status: 'completed',
          take,
          segments: [segment],
          message: undefined,
        },
      }
    })
    return accepted
  },
  appendPerformanceSegment: (sessionId, segment) => {
    let accepted = false
    set((s) => {
      const session = s.performanceSession
      if (
        session?.id !== sessionId
        || segment.sessionId !== sessionId
        || segment.songId !== session.songId
        || session.segments.some((item) => item.id === segment.id)
      ) return s
      accepted = true
      return {
        performanceSession: {
          ...session,
          segments: [...session.segments, segment],
        },
      }
    })
    return accepted
  },
  finishPerformance: (sessionId, message) => {
    let accepted = false
    set((s) => {
      const session = s.performanceSession
      if (session?.id !== sessionId) return s
      accepted = true
      const take = session.segments.at(-1) ?? null
      if (!take) {
        return {
          lastTake: null,
          performanceSession: {
            ...session,
            status: 'no-recording',
            take: null,
            message: message ?? '本次演奏没有可回放的录音段。',
          },
        }
      }
      return {
        lastTake: take,
        performanceSession: {
          ...session,
          status: 'completed',
          take,
          ...(message ? { message } : { message: undefined }),
        },
      }
    })
    return accepted
  },
  cacheSegmentAnalysis: (sessionId, segmentId, pitchTrack, stats) => {
    let accepted = false
    set((s) => {
      const session = s.performanceSession
      if (session?.id !== sessionId || session.status !== 'completed') return s
      const index = session.segments.findIndex((segment) => segment.id === segmentId)
      if (index < 0) return s
      accepted = true
      const segments = session.segments.map((segment, position) =>
        position === index ? { ...segment, pitchTrack, stats } : segment,
      )
      const take = session.take && 'id' in session.take && session.take.id === segmentId
        ? segments[index]
        : session.take
      return {
        lastTake: take ?? s.lastTake,
        performanceSession: { ...session, segments, take },
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
      const existingSegments = session.segments ?? []
      const segments = existingSegments.map((segment, index) =>
        index === existingSegments.length - 1 ? { ...segment, pitchTrack, stats } : segment,
      )
      return {
        lastTake: take,
        performanceSession: { ...session, take, segments },
      }
    })
    return accepted
  },
}))

import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './store'
import type { Take } from './types'

const takeFor = (sessionId: string, songId: string): Take => ({
  sessionId,
  songId,
  startedAt: 1,
  durationSec: 2,
  startSec: 4,
  stopSec: 6,
  audioUrl: `blob:${sessionId}`,
  mimeType: 'audio/wav',
  pitchTrack: null,
  stats: null,
})

beforeEach(() => {
  useAppStore.setState({
    view: 'home',
    currentSongId: null,
    lastTake: null,
    performanceSession: null,
  })
})

describe('演奏会话隔离', () => {
  it('开始新会话立即清除上一段录音，并进入准备状态', () => {
    const oldId = useAppStore.getState().beginPerformance('old-song')
    useAppStore.getState().completePerformance(oldId, takeFor(oldId, 'old-song'))

    const nextId = useAppStore.getState().beginPerformance('next-song')
    const state = useAppStore.getState()

    expect(state.lastTake).toBeNull()
    expect(state.performanceSession).toMatchObject({
      id: nextId,
      songId: 'next-song',
      status: 'preparing',
      take: null,
    })
  })

  it('上一会话晚到的保存结果不能覆盖当前会话', () => {
    const oldId = useAppStore.getState().beginPerformance('old-song')
    const currentId = useAppStore.getState().beginPerformance('current-song')

    const accepted = useAppStore
      .getState()
      .completePerformance(oldId, takeFor(oldId, 'old-song'))

    expect(accepted).toBe(false)
    expect(useAppStore.getState().performanceSession?.id).toBe(currentId)
    expect(useAppStore.getState().lastTake).toBeNull()
  })

  it('无录音状态不会沿用旧 take', () => {
    const id = useAppStore.getState().beginPerformance('song')
    useAppStore.getState().setPerformanceStatus(id, 'no-recording', '麦克风不可用')

    expect(useAppStore.getState().performanceSession).toMatchObject({
      id,
      status: 'no-recording',
      take: null,
      message: '麦克风不可用',
    })
    expect(useAppStore.getState().lastTake).toBeNull()
  })
})

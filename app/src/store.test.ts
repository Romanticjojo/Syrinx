import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './store'
import type { PerformanceSegment, Take } from './types'

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

const segmentFor = (sessionId: string, id: string, startSec: number): PerformanceSegment => ({
  ...takeFor(sessionId, 'song'),
  id,
  audioUrl: `blob:${id}`,
  startSec,
  stopSec: startSec + 2,
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

describe('分段录音所有权', () => {
  it('按唯一编号追加多段并以最后一段完成会话，同时兼容 lastTake', () => {
    const id = useAppStore.getState().beginPerformance('song')
    const first = segmentFor(id, 'segment-1', 0)
    const second = segmentFor(id, 'segment-2', 8)

    expect(useAppStore.getState().appendPerformanceSegment(id, first)).toBe(true)
    expect(useAppStore.getState().appendPerformanceSegment(id, second)).toBe(true)
    expect(useAppStore.getState().finishPerformance(id)).toBe(true)

    expect(useAppStore.getState().performanceSession).toMatchObject({
      status: 'completed',
      take: second,
      segments: [first, second],
    })
    expect(useAppStore.getState().lastTake).toEqual(second)
  })

  it('拒绝旧会话和重复段编号，不改写当前会话', () => {
    const oldId = useAppStore.getState().beginPerformance('song')
    const currentId = useAppStore.getState().beginPerformance('song')
    const segment = segmentFor(currentId, 'segment-1', 0)

    expect(useAppStore.getState().appendPerformanceSegment(oldId, segmentFor(oldId, 'old', 0))).toBe(false)
    expect(useAppStore.getState().appendPerformanceSegment(currentId, segment)).toBe(true)
    expect(useAppStore.getState().appendPerformanceSegment(currentId, segment)).toBe(false)
    expect(useAppStore.getState().performanceSession?.segments).toEqual([segment])
  })

  it('只缓存指定会话的指定录音段分析，不污染另一段或下一会话', () => {
    const id = useAppStore.getState().beginPerformance('song')
    const first = segmentFor(id, 'segment-1', 0)
    const second = segmentFor(id, 'segment-2', 8)
    useAppStore.getState().appendPerformanceSegment(id, first)
    useAppStore.getState().appendPerformanceSegment(id, second)
    useAppStore.getState().finishPerformance(id)
    const track = [{ time: 1, hz: 440, cents: 0 }]
    const stats = {
      inTuneRatio: 1,
      avgAbsCents: 0,
      noteCount: 1,
      totalNoteCount: 1,
      missedNoteCount: 0,
      coverageRatio: 1,
    }

    expect(useAppStore.getState().cacheSegmentAnalysis(id, first.id, track, stats)).toBe(true)
    const segments = useAppStore.getState().performanceSession?.segments ?? []
    expect(segments[0]).toMatchObject({ pitchTrack: track, stats })
    expect(segments[1].pitchTrack).toBeNull()

    const nextId = useAppStore.getState().beginPerformance('song')
    expect(useAppStore.getState().cacheSegmentAnalysis(id, second.id, track, stats)).toBe(false)
    expect(useAppStore.getState().performanceSession?.id).toBe(nextId)
  })
})

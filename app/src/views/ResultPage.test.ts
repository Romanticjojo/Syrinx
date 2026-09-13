import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { PerformanceSegment, PerformanceSession, Take } from '../types'

const fakeSong = vi.hoisted(() => ({
  id: 'test-song',
  title: '测试曲',
  composer: '测试',
  accent: '#3ddfae',
}))

const mocked = vi.hoisted(() => ({
  engine: {
    time: 0,
    duration: 20,
    playing: false,
    onEnd: undefined as (() => void) | undefined,
    audioCtx: {},
    resume: vi.fn(async () => {}),
    play: vi.fn(async () => true),
    pause: vi.fn(),
    seek: vi.fn(),
    decode: vi.fn(),
  },
}))

vi.mock('../songs', () => ({
  getSong: () => fakeSong,
  SONGS: [fakeSong],
  loadSong: async () => ({
    xml: '<score-partwise/>',
    timeline: {
      durationSec: 20,
      secPerQuarter: 0.5,
      tempo: 120,
      notes: [
        { time: 0, duration: 1, midi: 69, measure: 1 },
        { time: 4, duration: 1, midi: 69, measure: 2 },
        { time: 5, duration: 1, midi: 69, measure: 2 },
      ],
      measureTimes: [
        { measure: 1, time: 0, quarters: 0 },
        { measure: 2, time: 4, quarters: 8 },
        { measure: 3, time: 8, quarters: 16, end: true as const },
      ],
    },
  }),
}))
vi.mock('../audio/AudioEngine', () => ({ audioEngine: mocked.engine }))
vi.mock('../components/PlaybackDeck', () => ({
  default: ({ src, audioRef }: { src: string; audioRef: React.RefObject<HTMLAudioElement | null> }) =>
    createElement('audio', { ref: audioRef, src }),
}))
vi.mock('../components/PitchChart', () => ({ default: ({ notes, track, durationSec }: { notes: unknown[]; track: unknown[]; durationSec: number }) => createElement('div', { 'data-chart-notes': JSON.stringify(notes), 'data-chart-track': JSON.stringify(track), 'data-chart-duration': durationSec }) }))

const takeFor = (sessionId = 'session-1'): Take => ({
  sessionId,
  songId: 'test-song',
  startedAt: 1,
  durationSec: 2,
  startSec: 4,
  stopSec: 6,
  audioUrl: 'blob:take',
  mimeType: 'audio/wav',
  pitchTrack: [{ time: 4.5, hz: 440, cents: 0 }],
  stats: {
    inTuneRatio: 1,
    avgAbsCents: 0,
    noteCount: 1,
    totalNoteCount: 2,
    missedNoteCount: 1,
    coverageRatio: 0.5,
  },
})

const segmentFor = (id: string, startSec: number, stopSec: number): PerformanceSegment => ({
  ...takeFor(),
  id,
  audioUrl: `blob:${id}`,
  startSec,
  stopSec,
  durationSec: stopSec - startSec,
  pitchTrack: [{ time: startSec + 0.5, hz: 440, cents: 0 }],
})

let root: Root | null = null
let container: HTMLElement | null = null

async function renderWith(session: (Omit<PerformanceSession, 'segments'> & { segments?: PerformanceSegment[] }) | null, lastTake: Take | null = null) {
  useAppStore.setState({
    view: 'result',
    currentSongId: session?.songId ?? 'test-song',
    performanceSession: session ? { ...session, segments: session.segments ?? [] } : null,
    lastTake,
  })
  const { default: ResultPage } = await import('./ResultPage')
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(ResultPage))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

describe('结果页会话状态', () => {
  it('本次无录音时显示原因，不展示上一会话的录音', async () => {
    const oldTake = takeFor('old-session')
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'no-recording',
      take: null,
      message: '麦克风不可用，本次演奏没有录音。',
    }, oldTake)

    expect(page.textContent).toContain('本次没有录音')
    expect(page.textContent).toContain('麦克风不可用')
    expect(page.querySelector('audio')).toBeNull()
  })

  it('保存失败时显示明确错误，不伪装成普通空记录', async () => {
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'failed',
      take: null,
      message: '录音保存失败：写入失败',
    })

    expect(page.textContent).toContain('录音保存失败')
    expect(page.textContent).toContain('写入失败')
  })

  it('清楚区分已测音符音准率、覆盖率和漏音，并显示实际录音段', async () => {
    const take = takeFor()
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'completed',
      take,
    }, take)

    expect(page.textContent).toContain('录音时长 0:02')
    expect(page.textContent).toContain('采集位置 0:04–0:06')
    expect(page.textContent).toContain('已测音符音准率')
    expect(page.textContent).toContain('音符覆盖率')
    expect(page.textContent).toContain('漏 1')
  })
})

describe('录音与伴奏同步', () => {
  it('shows a partial-save warning while keeping the completed segment playable', async () => {
    const segment = segmentFor('segment-1', 4, 6)
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: segment, segments: [segment], message: '最后一段保存失败，已保留此前录音。' })
    expect(page.textContent).toContain('最后一段保存失败，已保留此前录音。')
    expect(page.querySelector('audio')?.getAttribute('src')).toBe(segment.audioUrl)
  })
  it('fits the chart to the selected segment and excludes skipped score time', async () => {
    const segment = segmentFor('segment-2', 4, 6)
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: segment, segments: [segment] })
    const chart = page.querySelector('[data-chart-duration]')!
    expect(chart.getAttribute('data-chart-duration')).toBe('2')
    expect(JSON.parse(chart.getAttribute('data-chart-notes')!).map((item: { note: { time: number } }) => item.note.time)).toEqual([0, 1])
    expect(JSON.parse(chart.getAttribute('data-chart-track')!)[0].time).toBe(0.5)
  })
  it('a pause cancels a media play event still waiting for audio resume', async () => {
    const take = takeFor()
    const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
    const syncButton = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('对照伴奏播放'),
    )!
    await act(async () => syncButton.click())
    const audio = page.querySelector('audio')!
    let paused = false
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => paused })
    let resume!: () => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>((resolve) => { resume = resolve }))
    mocked.engine.play.mockClear()
    await act(async () => audio.dispatchEvent(new Event('play')))
    paused = true
    await act(async () => audio.dispatchEvent(new Event('pause')))
    await act(async () => resume())
    expect(mocked.engine.play).not.toHaveBeenCalled()
  })

  it('a late recording play rejection cannot pause another page after unmount', async () => {
    const take = takeFor()
    const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
    const audio = page.querySelector('audio')!
    let rejectPlay!: (error: Error) => void
    vi.spyOn(audio, 'play').mockReturnValueOnce(new Promise<void>((_, reject) => { rejectPlay = reject }))
    const syncButton = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('对照伴奏播放'),
    )!
    await act(async () => syncButton.click())
    await act(async () => root!.unmount())
    root = null
    mocked.engine.pause.mockClear()
    await act(async () => rejectPlay(new Error('play interrupted')))
    expect(mocked.engine.pause).not.toHaveBeenCalled()
  })

  it('finishing analysis does not interrupt the active comparison playback', async () => {
    const take = takeFor()
    const page = await renderWith({
      id: take.sessionId, songId: take.songId, status: 'completed', take,
    }, take)
    const syncButton = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('对照伴奏播放'),
    )!
    await act(async () => syncButton.click())
    mocked.engine.pause.mockClear()
    await act(async () => {
      useAppStore.getState().cacheTakeAnalysis(take.sessionId, take.pitchTrack!, take.stats!)
    })
    expect(mocked.engine.pause).not.toHaveBeenCalled()
    const audio = page.querySelector('audio')!
    audio.currentTime = 1
    audio.dispatchEvent(new Event('seeking'))
    expect(mocked.engine.seek).toHaveBeenCalledWith(5)
  })

  it('等待音频恢复时离开结果页，恢复完成后不再启动伴奏', async () => {
    let resolveResume!: () => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveResume = resolve
    }))
    const take = takeFor()
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'completed',
      take,
    }, take)
    const syncButton = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('对照伴奏播放'),
    )!
    await act(async () => syncButton.click())
    await act(async () => root!.unmount())
    root = null

    await act(async () => resolveResume())
    expect(mocked.engine.play).not.toHaveBeenCalled()
  })

  it('录音从 0 秒播放，伴奏从采集起点播放；录音 seek/pause 同步到伴奏', async () => {
    const take = takeFor()
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'completed',
      take,
    }, take)
    const audio = page.querySelector('audio')!
    const syncButton = [...page.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('对照伴奏播放'),
    )!

    audio.currentTime = 1.5
    await act(async () => syncButton.click())
    expect(audio.currentTime).toBe(0)
    expect(mocked.engine.play).toHaveBeenCalledWith(4)

    mocked.engine.seek.mockClear()
    audio.currentTime = 1.25
    audio.dispatchEvent(new Event('seeking'))
    expect(mocked.engine.seek).toHaveBeenCalledWith(5.25)

    mocked.engine.pause.mockClear()
    audio.dispatchEvent(new Event('pause'))
    expect(mocked.engine.pause).toHaveBeenCalledOnce()
  })

  it('显式选择录音段并只从该段起点播放伴奏，显示对应小节范围', async () => {
    const first = segmentFor('segment-1', 0, 2)
    const second = segmentFor('segment-2', 4, 6)
    const page = await renderWith({
      id: 'session-1',
      songId: 'test-song',
      status: 'completed',
      take: second,
      segments: [first, second],
    }, second)

    expect(page.querySelector('audio')?.getAttribute('src')).toBe('blob:segment-2')
    expect(page.textContent).toContain('第 2 小节')
    const selector = page.querySelector<HTMLSelectElement>('[aria-label="选择录音段"]')!
    await act(async () => { selector.value = first.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(page.querySelector('audio')?.getAttribute('src')).toBe('blob:segment-1')
    expect(page.textContent).toContain('第 1 小节')

    mocked.engine.play.mockClear()
    const syncButton = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('对照伴奏播放'),
    )!
    await act(async () => syncButton.click())
    expect(mocked.engine.play).toHaveBeenCalledWith(0)
  })
  it('changing segments cancels a comparison still waiting to resume', async () => {
    const first = segmentFor('segment-1', 0, 2), second = segmentFor('segment-2', 4, 6)
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: second, segments: [first, second] })
    let resume!: () => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>(resolve => { resume = resolve }))
    const sync = [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!
    await act(async () => sync.click())
    const selector = page.querySelector<HTMLSelectElement>('[aria-label="选择录音段"]')!
    await act(async () => { selector.value = first.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => resume())
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(page.querySelector('audio')?.getAttribute('src')).toBe(first.audioUrl)
  })
  it('does not write late decoding results into a different selected segment', async () => {
    const first = { ...segmentFor('segment-1', 0, 2), stats: null, pitchTrack: null }, second = segmentFor('segment-2', 4, 6)
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
    let decode!: (value: AudioBuffer) => void
    mocked.engine.decode.mockReturnValueOnce(new Promise<AudioBuffer>(resolve => { decode = resolve }))
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: second, segments: [first, second] })
    const selector = page.querySelector<HTMLSelectElement>('[aria-label="选择录音段"]')!
    await act(async () => { selector.value = first.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    expect(mocked.engine.decode).toHaveBeenCalledOnce()
    await act(async () => { selector.value = second.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => decode({} as AudioBuffer))
    expect(useAppStore.getState().performanceSession?.segments[0].stats).toBeNull()
    expect(page.textContent).toContain('第 2 小节')
    expect(page.querySelector('audio')?.getAttribute('src')).toBe(second.audioUrl)
  })
})

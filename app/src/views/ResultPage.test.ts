import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { PerformanceSession, Take } from '../types'
import { songVersion } from '../practice/model'
import { loadSong } from '../songs'

const fakeSong = vi.hoisted(() => ({
  id: 'test-song',
  title: '测试曲',
  composer: '测试',
  accent: '#3ddfae',
}))

const mocked = vi.hoisted(() => ({
  missingSong: false,
  loadAccompaniment: vi.fn(),
  listPractices: vi.fn(async () => []),
  updatePracticeAnalysis: vi.fn(async () => {}),
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
    load: vi.fn(async () => {}),
  },
}))

vi.mock('../songs', () => ({
  getSong: () => mocked.missingSong ? undefined : fakeSong,
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
      measureTimes: [{ measure: 1, time: 0, quarters: 0 }, { measure: 2, time: 4, quarters: 8 }, { measure: 3, time: 6, quarters: 12 }],
    },
  }),
}))
vi.mock('../audio/accompaniment', () => ({ loadAccompaniment: mocked.loadAccompaniment }))
vi.mock('../practice/history', () => ({ listPractices: mocked.listPractices, updatePracticeAnalysis: mocked.updatePracticeAnalysis }))
vi.mock('../audio/AudioEngine', () => ({ audioEngine: mocked.engine }))
vi.mock('../components/PlaybackDeck', () => ({
  default: ({ src, audioRef }: { src: string; audioRef: React.RefObject<HTMLAudioElement | null> }) =>
    createElement('audio', { ref: audioRef, src }),
}))
vi.mock('../components/PitchChart', () => ({ default: () => null }))

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

let root: Root | null = null
let container: HTMLElement | null = null

async function renderWith(session: PerformanceSession | null, lastTake: Take | null = null) {
  useAppStore.setState({
    view: 'result',
    currentSongId: session?.songId ?? 'test-song',
    performanceSession: session,
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
  mocked.missingSong = false
  mocked.updatePracticeAnalysis.mockReset().mockResolvedValue(undefined)
  mocked.loadAccompaniment.mockReset().mockResolvedValue({ buffer: { duration: 20 }, synthesized: false })
  useAppStore.setState({ storageError: null })
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
})


describe('历史版本安全', () => {
  it.each([true, false])('changed song version blocks cached=%s analysis and comparison but retains audio', async (cached) => {
    const take = takeFor()
    take.practice = { songVersion: 'outdated', scoringVersion: 'pitch-v2-captured-notes', range: null, groupId: 'group', round: 1, rounds: 1 }
    if (!cached) { take.stats = null; take.pitchTrack = null }
    const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
    await act(async () => new Promise(r => setTimeout(r, 80)))
    expect(page.textContent).toContain('版本')
    expect(page.textContent).not.toContain('已测音符音准率')
    expect(page.querySelector('audio')?.getAttribute('src')).toBe('blob:take')
    expect(mocked.engine.decode).not.toHaveBeenCalled()
    expect([...page.querySelectorAll('button')].find(b => b.textContent?.includes('对照伴奏'))?.disabled).toBe(true)
  })
  it('removed catalog songs retain raw playback and export without scoring against another song', async () => {
    mocked.missingSong = true
    const take = takeFor()
    const page = await renderWith({ id: take.sessionId, songId: 'removed', status: 'completed', take }, take)
    expect(page.querySelector('audio')).not.toBeNull()
    expect(page.textContent).toContain('不在当前曲库')
    expect(page.textContent).not.toContain('已测音符音准率')
    expect(mocked.engine.decode).not.toHaveBeenCalled()
  })
})


async function storedTake() {
  const take = takeFor()
  const { xml, timeline } = await loadSong(fakeSong as never)
  take.audioBlob = new Blob(['stored audio'], { type: 'audio/wav' })
  take.practice = { songVersion: songVersion(xml, timeline), scoringVersion: 'pitch-v2-captured-notes', range: null, groupId: 'g', round: 1, rounds: 1 }
  return take
}
it('restored history loads its own accompaniment before playback instead of using the retained buffer', async () => {
  let resolve!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
  mocked.loadAccompaniment.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  expect(mocked.loadAccompaniment).not.toHaveBeenCalled()
  await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('对照伴奏'))!.click())
  expect(mocked.engine.play).not.toHaveBeenCalled()
  expect(mocked.loadAccompaniment.mock.calls[0][0].id).toBe('test-song')
  await act(async () => resolve({ buffer: { duration: 19 }, synthesized: false }))
  expect(mocked.engine.load).toHaveBeenCalledWith({ duration: 19 })
  expect(mocked.engine.play).toHaveBeenCalledWith(4)
})
it('switching records cancels a late accompaniment load before it can replace the next buffer', async () => {
  let resolve!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
  mocked.loadAccompaniment.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('对照伴奏'))!.click())
  await act(async () => useAppStore.getState().openPractice({ ...take, sessionId: 'new-result', audioUrl: 'blob:new' }))
  await act(async () => resolve({ buffer: { duration: 19 }, synthesized: false }))
  expect(mocked.engine.load).not.toHaveBeenCalled()
  expect(mocked.engine.play).not.toHaveBeenCalled()
})
it('pausing raw audio while accompaniment is loading permits a fresh comparison attempt', async () => {
  let resolve!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
  mocked.loadAccompaniment.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('对照伴奏'))!.click())
  await act(async () => page.querySelector('audio')!.dispatchEvent(new Event('pause')))
  await act(async () => resolve({ buffer: { duration: 19 }, synthesized: false }))
  const button = [...page.querySelectorAll('button')].find(b => b.textContent?.includes('对照伴奏'))!
  expect(button?.disabled).toBe(false)
  expect(mocked.engine.load).not.toHaveBeenCalled()
})
it('worst-bar retry uses playback ordinal and three rounds while whole-song retry clears config', async () => {
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('重练此小节'))!.click())
  expect(useAppStore.getState().practiceConfig).toMatchObject({ songId: 'test-song', rounds: 3, range: { startMeasure: 2, endMeasure: 2, startSec: 4, stopSec: 6 } })
  await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('重新演奏'))!.click())
  expect(useAppStore.getState().practiceConfig).toBeNull()
})


it('fresh analysis updates the matching persisted record and keeps playback on update failure', async () => {
  const take = await storedTake()
  take.pitchTrack = null; take.stats = null
  mocked.engine.decode.mockResolvedValueOnce({ sampleRate: 8000, length: 16000, duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) })
  mocked.updatePracticeAnalysis.mockRejectedValueOnce(new Error('analysis quota'))
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  await act(async () => new Promise(r => setTimeout(r, 180)))
  expect(useAppStore.getState().lastTake?.stats?.missedNoteCount).toBe(2)
  expect(mocked.updatePracticeAnalysis).toHaveBeenCalledWith('session-1', [], expect.objectContaining({ missedNoteCount: 2, totalNoteCount: 2 }))
  expect(page.textContent).toContain('analysis quota')
  expect(page.querySelector('audio')).not.toBeNull()
})
it('raw download owns its URL until the browser can consume it, even after switching results', async () => {
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-only')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    await act(async () => [...page.querySelectorAll('button')].find(b => b.textContent?.includes('下载录音'))!.click())
    expect(create).toHaveBeenCalledWith(take.audioBlob)
    expect(click).toHaveBeenCalledOnce()
    await act(async () => useAppStore.getState().openPractice({ ...take, sessionId: 'different', audioUrl: 'blob:different' }))
    expect(revoke).toHaveBeenCalledWith('blob:take')
    expect(revoke).not.toHaveBeenCalledWith('blob:download-only')
    await act(async () => vi.advanceTimersByTime(30000))
    expect(revoke).toHaveBeenCalledWith('blob:download-only')
  } finally { vi.useRealTimers(); create.mockRestore(); revoke.mockRestore(); click.mockRestore() }
})


it.each(['seeking', 'ended'])('%s during deferred accompaniment loading cancels stale audio and allows retry from the selected playhead', async (event) => {
  let resolveStale!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
  mocked.loadAccompaniment.mockReturnValueOnce(new Promise(r => { resolveStale = r }))
  const take = await storedTake()
  const page = await renderWith({ id: take.sessionId, songId: take.songId, status: 'completed', take }, take)
  const compare = page.querySelector<HTMLButtonElement>('button.sync')!
  const audio = page.querySelector('audio')!
  await act(async () => compare.click())
  expect(compare.disabled).toBe(true)
  audio.currentTime = event === 'ended' ? 2 : 1.25
  await act(async () => audio.dispatchEvent(new Event(event)))
  expect(compare.disabled).toBe(false)
  await act(async () => compare.click())
  expect(mocked.engine.load).toHaveBeenCalledOnce()
  expect(mocked.engine.load).toHaveBeenCalledWith({ duration: 20 })
  expect(mocked.engine.play).toHaveBeenCalledWith(event === 'ended' ? 4 : 5.25)
  expect(audio.currentTime).toBe(event === 'ended' ? 0 : 1.25)
  await act(async () => resolveStale({ buffer: { duration: 99 }, synthesized: false }))
  expect(mocked.engine.load).toHaveBeenCalledOnce()
  expect(mocked.engine.play).toHaveBeenCalledOnce()
  expect(compare.textContent).toContain('停止对照')
})

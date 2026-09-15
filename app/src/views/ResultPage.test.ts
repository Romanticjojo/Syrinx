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
    rate: 1,
    onEnd: undefined as (() => void) | undefined,
    audioCtx: {},
    resume: vi.fn(async () => {}),
    play: vi.fn(async () => true),
    pause: vi.fn(),
    seek: vi.fn(),
    decode: vi.fn(),
    setRate: vi.fn(async (rate: number) => { mocked.engine.rate = rate; return true }),
  },
  loadAccompaniment: vi.fn(),
  renderMix: vi.fn(),
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
vi.mock('../audio/accompaniment', () => ({
  loadAccompaniment: (...args: unknown[]) => mocked.loadAccompaniment(...args),
}))
vi.mock('../audio/mix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio/mix')>()
  return {
    ...actual,
    renderMix: (...args: unknown[]) => mocked.renderMix(...(args as Parameters<typeof actual.renderMix>)),
  }
})
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

/** 混音测试替身：伴奏 20s 单声道 / 渲染产物 2s 单声道（encodeWav 只读这些字段） */
const accDuck = { duration: 20, sampleRate: 44100, numberOfChannels: 1, length: 882000, getChannelData: () => new Float32Array(882000) }
const renderedDuck = { duration: 2, sampleRate: 44100, numberOfChannels: 1, length: 88200, getChannelData: () => new Float32Array(88200) }

const completedSession = (take: Take) => ({ id: take.sessionId, songId: take.songId, status: 'completed' as const, take })

const mixButtonOf = (page: HTMLElement): HTMLButtonElement =>
  [...page.querySelectorAll('button')].find((button) => button.textContent?.includes('下载混音'))!

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
  mocked.engine.rate = 1
  mocked.engine.setRate.mockReset().mockImplementation(async (rate: number) => { mocked.engine.rate = rate; return true })
  mocked.loadAccompaniment.mockReset().mockResolvedValue({ buffer: accDuck, synthesized: false })
  mocked.renderMix.mockReset().mockResolvedValue(renderedDuck)
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
  it('realigns resumed comparison after the native accompaniment startup delay', async () => {
    const take = { ...takeFor(), playbackRate: 0.5 }
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take })
    const audio = page.querySelector('audio')!
    vi.spyOn(audio, 'play').mockResolvedValue()
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    Object.defineProperty(audio, 'paused', { configurable: true, value: false })
    let ready!: (value: boolean) => void
    mocked.engine.play.mockReturnValueOnce(new Promise<boolean>(resolve => { ready = resolve }))
    audio.currentTime = 0.2
    await act(async () => audio.dispatchEvent(new Event('play')))
    mocked.engine.seek.mockClear()
    audio.currentTime = 0.5
    await act(async () => ready(true))
    expect(mocked.engine.seek).toHaveBeenCalledWith(4.25)
  })

  it('realigns accompaniment to the recording clock after delayed recording startup', async () => {
    const take = { ...takeFor(), playbackRate: 0.5 }
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take })
    const audio = page.querySelector('audio')!
    let ready!: () => void
    vi.spyOn(audio, 'play').mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve }))
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    mocked.engine.seek.mockClear()
    audio.currentTime = 0.24
    await act(async () => ready())
    expect(mocked.engine.seek).toHaveBeenCalledWith(4.12)
  })

  it('does not realign a late recording startup after the user has paused it', async () => {
    const take = takeFor()
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take })
    const audio = page.querySelector('audio')!
    let ready!: () => void
    vi.spyOn(audio, 'play').mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve }))
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    await act(async () => audio.dispatchEvent(new Event('pause')))
    mocked.engine.seek.mockClear()
    await act(async () => ready())
    expect(mocked.engine.seek).not.toHaveBeenCalled()
  })

  it('an internal rewind seeking event cannot cancel a comparison awaiting native media playback', async () => {
    const take = takeFor()
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take })
    const audio = page.querySelector('audio')!
    const playRecording = vi.spyOn(audio, 'play').mockResolvedValue()
    audio.currentTime = 1
    let started!: (value: boolean) => void
    mocked.engine.play.mockReturnValueOnce(new Promise<boolean>(resolve => { started = resolve }))
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    await act(async () => audio.dispatchEvent(new Event('seeking')))
    await act(async () => started(true))
    expect(playRecording).toHaveBeenCalledOnce()
    expect(page.textContent).toContain('停止对照')
  })

  it('pausing the recording cancels a comparison whose native accompaniment play is pending', async () => {
    const take = takeFor()
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take })
    const audio = page.querySelector('audio')!
    let started!: (value: boolean) => void
    mocked.engine.play.mockReturnValueOnce(new Promise<boolean>(resolve => { started = resolve }))
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    mocked.engine.pause.mockClear()
    await act(async () => audio.dispatchEvent(new Event('pause')))
    expect(mocked.engine.pause).toHaveBeenCalledOnce()
    await act(async () => started(false))
    expect(page.textContent).not.toContain('停止对照')
  })
  it('uses a slow segment rate for accompaniment and local chart seconds', async () => {
    const segment = { ...segmentFor('slow', 4, 6), playbackRate: 0.5, durationSec: 4 }
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: segment, segments: [segment] })
    const chart = page.querySelector('[data-chart-duration]')!
    expect(chart.getAttribute('data-chart-duration')).toBe('4')
    expect(JSON.parse(chart.getAttribute('data-chart-notes')!).map((item: { note: { time: number; duration: number } }) => [item.note.time, item.note.duration])).toEqual([[0, 2], [2, 2]])
    expect(JSON.parse(chart.getAttribute('data-chart-track')!)[0].time).toBe(1)
    const sync = [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!
    await act(async () => sync.click())
    expect(mocked.engine.setRate).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.play).toHaveBeenCalledWith(4)
    const audio = page.querySelector('audio')!
    audio.currentTime = 1.5
    await act(async () => audio.dispatchEvent(new Event('seeking')))
    expect(mocked.engine.seek).toHaveBeenCalledWith(4.75)
    expect(audio.playbackRate).toBe(1)
  })

  it('maps newly analysed recording times to song time once at the segment rate', async () => {
    const segment = { ...segmentFor('slow-raw', 4, 5), playbackRate: 0.5, durationSec: 2, pitchTrack: null, stats: null }
    const samples = Float32Array.from({ length: 16000 }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / 8000) * 0.5)
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
    mocked.engine.decode.mockResolvedValueOnce({ sampleRate: 8000, getChannelData: () => samples })
    await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: segment, segments: [segment] })
    await act(async () => {
      await vi.waitFor(() => expect(useAppStore.getState().performanceSession?.segments[0].stats).not.toBeNull(), { timeout: 4000 })
    })
    const saved = useAppStore.getState().performanceSession!.segments[0]
    expect(saved.pitchTrack!.at(-1)!.time).toBeGreaterThan(4.9)
    expect(saved.pitchTrack!.at(-1)!.time).toBeLessThan(5)
    expect(saved.stats!.noteCount).toBe(1)
  })

  it('does not start comparison after a pending rate preparation is superseded by a different segment', async () => {
    const first = segmentFor('first', 0, 2)
    const second = { ...segmentFor('slow', 4, 6), playbackRate: 0.5 }
    const page = await renderWith({ id: 'session-1', songId: 'test-song', status: 'completed', take: second, segments: [first, second] })
    let ready!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { ready = resolve }))
    await act(async () => [...page.querySelectorAll('button')].find(button => button.textContent?.includes('对照伴奏播放'))!.click())
    const selector = page.querySelector<HTMLSelectElement>('[aria-label="选择录音段"]')!
    await act(async () => { selector.value = first.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => ready(true))
    expect(mocked.engine.play).not.toHaveBeenCalled()
  })
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

describe('下载录音+伴奏混音', () => {
  it('伴奏预载完成前按钮禁用；加载失败保持禁用并提示不可用', async () => {
    let rejectAcc!: (error: Error) => void
    mocked.loadAccompaniment.mockReset().mockReturnValueOnce(new Promise((_resolve, reject) => { rejectAcc = reject }))
    const take = takeFor()
    const page = await renderWith(completedSession(take))
    expect(mocked.loadAccompaniment).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-song' }), expect.objectContaining({ durationSec: 20 }))
    const mix = mixButtonOf(page)
    expect(mix.hasAttribute('disabled')).toBe(true)
    expect(mix.getAttribute('title')).toContain('录音+伴奏混合')
    await act(async () => { rejectAcc(new Error('伴奏不可用')) })
    expect(mix.hasAttribute('disabled')).toBe(true)
    expect(mix.getAttribute('title')).toContain('伴奏不可用')
  })

  it('点击下载混音：按 take 窗口渲染并以 -mix 命名下载', async () => {
    const take = takeFor()
    const page = await renderWith(completedSession(take))
    await act(async () => {
      await vi.waitFor(() => { expect(mixButtonOf(page).hasAttribute('disabled')).toBe(false) })
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
    const recDuck = { duration: 2, sampleRate: 32000, numberOfChannels: 1, length: 64000, getChannelData: () => new Float32Array(64000) }
    mocked.engine.decode.mockResolvedValueOnce(recDuck)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mix')
    await act(async () => { mixButtonOf(page).click() })
    await act(async () => { await vi.waitFor(() => expect(click).toHaveBeenCalledOnce()) })
    expect(mocked.renderMix).toHaveBeenCalledOnce()
    const [plan, rec, acc] = mocked.renderMix.mock.calls[0] as [{ recDuration: number; accStart: number; accRate: number; accDur: number }, unknown, { duration: number }]
    expect(plan).toEqual({ recDuration: 2, accStart: 4, accRate: 1, accDur: 2 })
    expect(rec).toBe(recDuck)
    expect(acc.duration).toBe(20)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toMatch(/^syrinx-test-song-\d{4}-\d{2}-\d{2}\d{6}-part1-mix\.wav$/)
    expect(anchor.getAttribute('href')).toBe('blob:mix')
  })

  it('变速录音（takeRate 1.25）：伴奏窗口按录音时长 × rate 规划', async () => {
    const take = { ...takeFor(), playbackRate: 1.25, durationSec: 1.6 }
    const page = await renderWith(completedSession(take))
    await act(async () => {
      await vi.waitFor(() => { expect(mixButtonOf(page).hasAttribute('disabled')).toBe(false) })
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
    const recDuck = { duration: 1.6, sampleRate: 32000, numberOfChannels: 1, length: 51200, getChannelData: () => new Float32Array(51200) }
    mocked.engine.decode.mockResolvedValueOnce(recDuck)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mix')
    await act(async () => { mixButtonOf(page).click() })
    await act(async () => { await vi.waitFor(() => expect(click).toHaveBeenCalledOnce()) })
    const [plan] = mocked.renderMix.mock.calls[0] as [{ recDuration: number; accStart: number; accRate: number; accDur: number }]
    expect(plan).toEqual({ recDuration: 1.6, accStart: 4, accRate: 1.25, accDur: 2 })
  })

  it('仅录音下载不触发混音且命名不带 -mix（回归）', async () => {
    const take = takeFor()
    const page = await renderWith(completedSession(take))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const download = [...page.querySelectorAll('button')].find((button) => button.textContent?.includes('下载录音'))!
    await act(async () => { download.click() })
    await act(async () => { await vi.waitFor(() => expect(click).toHaveBeenCalledOnce()) })
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toMatch(/^syrinx-test-song-\d{4}-\d{2}-\d{2}\d{6}-part1\.wav$/)
    expect(mocked.renderMix).not.toHaveBeenCalled()
  })
})

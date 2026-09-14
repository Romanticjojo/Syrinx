import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'

/** 演奏页伴奏音量初值来源（t_5957a725）：audioEngine 是全局单例，回放页
 *  「对照伴奏」滑杆写的增益跨页留存——演奏页 UI 必须读引擎实际值起步，
 *  否则 ControlBar 显示假满格而实际 gain=0，背景伴奏无声（用户二次实测 bug）。
 *  免麦克风起见 mock 曲库/合成/three 背景/谱面组件，保留真实 ControlBar 与
 *  真实 audioEngine（stub AudioContext 注入可控 gain）。 */

const fakeSong = vi.hoisted(() => ({
  id: 'test-song',
  title: '测试曲',
  composer: '测试',
  accent: '#3ddfae',
  tags: ['测试'],
  bpm: 84,
  durationLabel: '0:01',
}))

const mocked = vi.hoisted(() => ({
  openMic: vi.fn(),
  loadAccompaniment: vi.fn(async () => ({ buffer: { duration: 1 }, synthesized: false })),
  cancelPendingAccompaniment: vi.fn(),
  engine: {
    time: 0,
    ctxTime: 0,
    duration: 1,
    playing: false,
    rate: 1,
    onEnd: undefined as (() => void) | undefined,
    analyser: {},
    audioCtx: {},
    resume: vi.fn(async () => {}),
    load: vi.fn(async (buffer: { duration?: number }) => {
      mocked.engine.duration = buffer.duration ?? 1
      mocked.engine.time = 0
      mocked.engine.playing = false
    }),
    play: vi.fn(async (offset?: number) => {
      if (offset !== undefined) mocked.engine.time = offset
      mocked.engine.playing = true
      return true
    }),
    pause: vi.fn(() => {
      mocked.engine.playing = false
    }),
    seek: vi.fn((time: number) => {
      mocked.engine.time = time
    }),
    scheduleTick: vi.fn(),
    getVolume: vi.fn(() => 1),
    setVolume: vi.fn(),
    setRate: vi.fn(async (rate: number) => { mocked.engine.rate = rate; return true }),
  },
}))

vi.mock('../songs', () => ({
  getSong: () => fakeSong,
  SONGS: [fakeSong],
  loadSong: async () => ({
    xml: '<score-partwise/>',
    timeline: {
      durationSec: 1,
      secPerQuarter: 0.5,
      tempo: 120,
      notes: [],
      measureTimes: [
        { measure: 1, time: 0, quarters: 0 },
        { measure: 2, time: 0.5, quarters: 1 },
        { measure: 3, time: 1, quarters: 2, end: true as const },
      ],
    },
    cursorMode: 'anchors' as const,
  }),
}))
vi.mock('../audio/accompaniment', () => ({
  loadAccompaniment: mocked.loadAccompaniment,
  cancelPendingAccompaniment: mocked.cancelPendingAccompaniment,
}))
vi.mock('../audio/AudioEngine', () => ({ audioEngine: mocked.engine }))
vi.mock('../audio/recorder', () => ({ openMic: mocked.openMic }))
vi.mock('../background/LumiereScene', () => ({
  LumiereScene: class {
    setAnalyser() {}
    resize() {}
    dispose() {}
  },
}))
vi.mock('../components/ScoreSheet', () => ({
  default: ({ onMeasureSelect }: { onMeasureSelect?: (measure: number, time: number) => void }) =>
    createElement('div', null,
      createElement('button', {
        type: 'button',
        'aria-label': '选择第1小节',
        onClick: () => onMeasureSelect?.(1, 0.1),
      }),
      createElement('button', {
        type: 'button',
        'aria-label': '选择第2小节',
        onClick: () => onMeasureSelect?.(2, 0.5),
      }),
    ),
}))
vi.mock('../components/PitchMeter', () => ({ default: () => null }))

let roots: Root[] = []
let containers: HTMLElement[] = []
let rafCallbacks = new Map<number, FrameRequestCallback>()
let rafSeq = 0

function makeMic(stopResult?: Promise<{ url: string; mime: string; silent: boolean }>) {
  return {
    analyser: {},
    sampleRate: () => 44100,
    readFrame: () => new Float32Array(2048),
    restartCapture: vi.fn(async () => {}),
    pauseCapture: vi.fn(async () => {}),
    resumeCapture: vi.fn(async () => {}),
    discardCapture: vi.fn(async () => {}),
    finishCapture: vi.fn(async (): Promise<{ url: string; mime: string; silent: boolean } | null> =>
      ({ url: 'blob:segment', mime: 'audio/wav', silent: false })),
    stop: vi.fn(() =>
      stopResult ?? Promise.resolve({ url: 'blob:take', mime: 'audio/wav', silent: false }),
    ),
    release: vi.fn(),
  }
}

async function flushRaf(): Promise<void> {
  const callbacks = [...rafCallbacks.values()]
  rafCallbacks.clear()
  await act(async () => {
    callbacks.forEach((cb) => cb(performance.now()))
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.removeItem('syrinx.practice-hint.v1')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  rafCallbacks = new Map()
  rafSeq = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
    const id = ++rafSeq
    rafCallbacks.set(id, cb)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => rafCallbacks.delete(id)))
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocked.engine.time = 0
  mocked.engine.ctxTime = 0
  mocked.engine.duration = 1
  mocked.engine.playing = false
  mocked.engine.rate = 1
  mocked.engine.setRate.mockReset().mockImplementation(async (rate: number) => { mocked.engine.rate = rate; return true })
  mocked.engine.onEnd = undefined
  mocked.engine.getVolume.mockReturnValue(1)
  mocked.openMic.mockReset()
  mocked.openMic.mockResolvedValue(makeMic())
  mocked.loadAccompaniment.mockReset().mockResolvedValue({ buffer: { duration: 1 }, synthesized: false })
  useAppStore.setState({
    view: 'perform',
    currentSongId: 'test-song',
    lastTake: null,
    performanceSession: null,
  })
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  for (const c of containers) c.remove()
  containers = []
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** 以引擎初始增益 gainValue 挂载演奏页，返回 ControlBar 伴奏音量滑杆 */
async function mountPerformPage(gainValue: number, strict = false): Promise<HTMLInputElement | null> {
  mocked.engine.getVolume.mockReturnValue(gainValue)
  const { default: PerformPage } = await import('./PerformPage')
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  await act(async () => {
    const root = createRoot(container)
    roots.push(root)
    root.render(strict ? createElement(StrictMode, null, createElement(PerformPage)) : createElement(PerformPage))
  })
  // 冲刷装载 effect 的异步链（loadSong → audioEngine.load → setPhase），让更新都落在 act 内
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
  return container.querySelector<HTMLInputElement>('.ctl-volume input[type="range"]')
}

async function beginPerformance(container: HTMLElement): Promise<void> {
  const start = container.querySelector<HTMLButtonElement>('.ov-start')
  expect(start).not.toBeNull()
  await act(async () => start!.click())
  mocked.engine.ctxTime = 10
  await flushRaf()
}

/** Capture and fire the inactivity timer without waiting 3.2 seconds. */
async function hidePerformHud(container: HTMLElement): Promise<void> {
  let expire!: () => void
  const timer = vi.spyOn(window, 'setTimeout').mockImplementationOnce(callback => {
    expire = callback as () => void
    return 0 as unknown as ReturnType<typeof window.setTimeout>
  })
  await act(async () => window.dispatchEvent(new Event('mousemove')))
  timer.mockRestore()
  await act(async () => expire())
  expect(container.querySelector('.perform')?.classList.contains('idle')).toBe(true)
}

describe('first-use practice hint', () => {
  it('explains measure selection and BPM once, remembers dismissal across mounts', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    const hint = page.querySelector('.practice-hint')
    expect(hint?.textContent).toContain('点小节选起点')
    expect(hint?.textContent).toContain('点 BPM 调速度')
    const dismiss = [...page.querySelectorAll('button')].find(b => b.textContent === '知道了')!
    await act(async () => dismiss.click())
    expect(page.querySelector('.practice-hint')).toBeNull()
    await mountPerformPage(1)
    expect(containers.at(-1)!.querySelector('.practice-hint')).toBeNull()
  })

  it('remembers the hint when the user starts directly without dismissing it', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    expect(page.querySelector('.practice-hint')).not.toBeNull()
    await beginPerformance(page)
    expect(page.querySelector('.practice-hint')).toBeNull()
    expect(localStorage.getItem('syrinx.practice-hint.v1')).toBe('seen')
  })
})

describe('录音指示反映实际采集', () => {
  it('keeps REC dark through microphone permission and capture-gate preparation', async () => {
    let grant!: (mic: ReturnType<typeof makeMic>) => void
    let captureReady!: () => void
    mocked.openMic.mockReturnValue(new Promise(resolve => { grant = resolve }))
    const mic = makeMic()
    mic.restartCapture.mockReturnValueOnce(new Promise<void>(resolve => { captureReady = resolve }))
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    const rec = page.querySelector<HTMLButtonElement>('.ctl.rec')!
    expect(rec.getAttribute('aria-pressed')).toBe('true')
    expect(rec.classList.contains('on')).toBe(false)
    expect(rec.querySelector('.rec-badge')).toBeNull()
    expect(rec.getAttribute('aria-label')).toContain('等待麦克风')
    expect(useAppStore.getState().performanceSession?.status).not.toBe('recording')

    await act(async () => grant(mic))
    expect(rec.classList.contains('on')).toBe(false)
    expect(rec.getAttribute('aria-label')).toContain('准备录音')
    await act(async () => captureReady())
    expect(rec.classList.contains('on')).toBe(true)
    expect(rec.querySelector('.rec-badge')?.textContent).toBe('REC')
    expect(useAppStore.getState().performanceSession?.status).toBe('recording')
  })

  it('shows rejected permission without claiming an active recording', async () => {
    let refuse!: (error: Error) => void
    mocked.openMic.mockReturnValue(new Promise((_resolve, reject) => { refuse = reject }))
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    await act(async () => refuse(new Error('麦克风权限被拒绝')))
    const rec = page.querySelector<HTMLButtonElement>('.ctl.rec')!
    expect(rec.classList.contains('on')).toBe(false)
    expect(rec.querySelector('.rec-badge')).toBeNull()
    expect(rec.getAttribute('aria-label')).toContain('录音不可用')
    expect(page.querySelector('[role="status"]')?.textContent).toContain('权限被拒绝')
    expect(useAppStore.getState().performanceSession?.status).not.toBe('recording')
  })

  it('reports a capture-gate failure after late microphone permission', async () => {
    let grant!: (mic: ReturnType<typeof makeMic>) => void
    mocked.openMic.mockReturnValue(new Promise(resolve => { grant = resolve }))
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    const mic = makeMic()
    mic.restartCapture.mockRejectedValueOnce(new Error('录音写入确认超时'))
    await act(async () => grant(mic))
    const rec = page.querySelector<HTMLButtonElement>('.ctl.rec')!
    expect(rec.classList.contains('on')).toBe(false)
    expect(rec.getAttribute('aria-label')).toContain('录音不可用')
    expect(page.querySelector('[role="status"]')?.textContent).toContain('写入确认超时')
    expect(useAppStore.getState().performanceSession?.status).not.toBe('recording')
  })

  it('keeps the recording intent while paused without showing active REC', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    const rec = page.querySelector<HTMLButtonElement>('.ctl.rec')!
    expect(rec.getAttribute('aria-pressed')).toBe('true')
    expect(rec.classList.contains('on')).toBe(false)
    expect(rec.querySelector('.rec-badge')).toBeNull()
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    // [countdown-semantic] 按播放一律先倒数：倒数期间仍无 REC 指示
    expect(page.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(rec.classList.contains('on')).toBe(false)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(rec.classList.contains('on')).toBe(true)
  })
})

describe('演奏页伴奏音量初值（t_5957a725）', () => {
  it('offers the score tempo and applies a new BPM while staying ready', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    const tempo = page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')
    expect(tempo).not.toBeNull()
    expect(tempo!.textContent).toContain('120')
    await act(async () => tempo!.click())
    const slower = document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!
    await act(async () => slower.click())
    expect(mocked.engine.setRate).not.toHaveBeenCalled()
    const apply = document.querySelector<HTMLButtonElement>('.tempo-apply')!
    await act(async () => apply.click())
    expect(mocked.engine.setRate).toHaveBeenCalledWith(119 / 120)
    expect(mocked.engine.playing).toBe(false)
    expect(page.querySelector('.ov-start')).not.toBeNull()
    expect(tempo!.textContent).toContain('119')
  })

  it('seals the old speed before changing BPM and counts in at the new tempo', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    mocked.engine.time = 0.25
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    mocked.engine.scheduleTick.mockClear()
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    expect(mic.finishCapture).toHaveBeenCalledOnce()
    expect(useAppStore.getState().performanceSession?.segments[0]?.playbackRate).toBe(1)
    expect(mocked.engine.rate).toBeCloseTo(119 / 120)
    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    expect(mocked.engine.playing).toBe(false)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(true)
    expect(mocked.engine.time).toBe(0.25)
    mocked.engine.time = 0.75
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    const newSegment = useAppStore.getState().performanceSession!.segments[1]
    expect(newSegment.playbackRate).toBeCloseTo(119 / 120)
    expect(newSegment.durationSec).toBeCloseTo(0.5 / (119 / 120))
  })

  it('a measure click during tempo preparation keeps only the newest target and one resumed capture', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    mocked.engine.time = 0.25
    let prepared!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { prepared = resolve }))
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    await act(async () => prepared(true))
    expect(mocked.engine.time).toBe(0.5)
    expect(mocked.engine.rate).toBeCloseTo(119 / 120)
    expect(mocked.engine.playing).toBe(false)
    expect(useAppStore.getState().performanceSession?.segments).toHaveLength(1)
    // [countdown-semantic] 谱面点击只定位+暂停：变速完成后同样不自动续播
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.time).toBe(0.5)
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(page.querySelector('.perform-overlay.countdown')).not.toBeNull()
    mocked.engine.ctxTime = 30
    await flushRaf()
    expect(mocked.engine.playing).toBe(true)
    expect(mocked.engine.time).toBe(0.5)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })

  it('stopping while tempo is preparing never restarts music when preparation resolves', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    let prepared!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { prepared = resolve }))
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    mocked.engine.play.mockClear()
    await act(async () => prepared(true))
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(useAppStore.getState().view).toBe('result')
  })

  it('Escape closes the tempo panel without exiting the performance', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(useAppStore.getState().view).toBe('perform')
  })

  it('Escape still exits when a transport button has focus', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    const play = page.querySelector<HTMLButtonElement>('[aria-label="播放"]')!
    play.focus()
    await act(async () => play.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })))
    expect(useAppStore.getState().view).toBe('home')
  })

  it('an invalidated countdown never starts old audio while the new rate is preparing', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await act(async () => page.querySelector<HTMLButtonElement>('.ov-start')!.click())
    let prepared!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { prepared = resolve }))
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    mocked.engine.ctxTime = 10
    mocked.engine.play.mockClear()
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    await act(async () => prepared(true))
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledOnce()
  })

  it('a stale initial audio resume cannot replace an in-flight tempo change', async () => {
    await mountPerformPage(1)
    const page = containers.at(-1)!
    let resumed!: () => void
    let prepared!: (value: boolean) => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>(resolve => { resumed = resolve }))
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { prepared = resolve }))
    await act(async () => page.querySelector<HTMLButtonElement>('.ov-start')!.click())
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    mocked.engine.scheduleTick.mockClear()
    await act(async () => resumed())
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    await act(async () => prepared(true))
    expect(page.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.getAttribute('aria-disabled')).toBe('false')
    expect(page.querySelector('.ov-start')).not.toBeNull()
  })
  it('waits for the shared preload before becoming ready', async () => {
    let complete!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
    mocked.loadAccompaniment.mockReturnValueOnce(new Promise((resolve) => { complete = resolve }))
    await mountPerformPage(1)
    expect(containers.at(-1)?.querySelector('.ov-start')).toBeNull()
    expect(mocked.engine.load).not.toHaveBeenCalled()
    await act(async () => complete({ buffer: { duration: 4 }, synthesized: false }))
    expect(mocked.engine.load).toHaveBeenCalledWith({ duration: 4 })
    expect(containers.at(-1)?.querySelector('.ov-start')).not.toBeNull()
  })

  it('discards a late preload after leaving the perform page', async () => {
    let complete!: (value: { buffer: { duration: number }; synthesized: boolean }) => void
    mocked.loadAccompaniment.mockReturnValueOnce(new Promise((resolve) => { complete = resolve }))
    await mountPerformPage(1)
    await act(async () => roots.pop()!.unmount())
    await act(async () => complete({ buffer: { duration: 4 }, synthesized: false }))
    expect(mocked.engine.load).not.toHaveBeenCalled()
    expect(mocked.cancelPendingAccompaniment).toHaveBeenCalledWith(fakeSong.id)
  })

  it('clearly identifies a synthesized fallback before starting', async () => {
    mocked.loadAccompaniment.mockResolvedValueOnce({ buffer: { duration: 1 }, synthesized: true })
    await mountPerformPage(1)
    expect(containers.at(-1)?.textContent).toContain('已准备合成伴奏')
  })

  it('引擎 gain=0（回放页伴奏拖 0 残留）→ 滑杆初值 0，不再显示假满格', async () => {
    const slider = await mountPerformPage(0)
    expect(slider).not.toBeNull()
    expect(parseFloat(slider!.value)).toBe(0)
  })

  it('引擎 gain=1（无人动过音量的正常路径）→ 滑杆初值满格不变', async () => {
    const slider = await mountPerformPage(1)
    expect(slider).not.toBeNull()
    expect(parseFloat(slider!.value)).toBe(1)
  })

  it('引擎 gain=0.4（上次演奏自己调过）→ 滑杆初值精确衔接', async () => {
    const slider = await mountPerformPage(0.4)
    expect(parseFloat(slider!.value)).toBeCloseTo(0.4, 3)
  })

  it('伴奏准备完成后，未起奏的 HUD 已显示曲目总时长', async () => {
    await mountPerformPage(1)
    expect(containers.at(-1)?.querySelector('.hud-stat:nth-child(2) .num')?.textContent).toBe(
      '0:00 / 0:01',
    )
  })

  it('进度滑杆在定位和播放帧中同步暴露真实时间值', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    const rail = container.querySelector<HTMLElement>('.progress-rail')!
    expect(rail.getAttribute('aria-valuemin')).toBe('0')
    expect(rail.getAttribute('aria-valuemax')).toBe('1')
    expect(rail.getAttribute('aria-valuenow')).toBe('0')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(rail.getAttribute('aria-valuenow')).toBe('0.5')
    expect(container.querySelector<HTMLElement>('.played')!.style.width).toBe('50%')

    await beginPerformance(container)
    mocked.engine.time = 0.75
    await flushRaf()
    expect(rail.getAttribute('aria-valuenow')).toBe('0.75')
    expect(container.querySelector<HTMLElement>('.played')!.style.width).toBe('75%')
  })
})

describe('演奏录音会话', () => {
  it.each(['focus', 'keyboard', 'accessible-click', 'pointer'] as const)('wakes idle controls for %s without interrupting playback, then allows keyboard pause', async interaction => {
    await mountPerformPage(1, true)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await hidePerformHud(container)
    const shell = container.querySelector<HTMLElement>('.perform')!
    const pause = container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!
    await act(async () => {
      if (interaction === 'focus') pause.focus()
      else if (interaction === 'keyboard') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' }))
      else if (interaction === 'accessible-click') shell.click()
      else shell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(shell.classList.contains('idle')).toBe(false)
    expect(mocked.engine.playing).toBe(true)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' })))
    expect(mocked.engine.playing).toBe(false)
    expect(shell.classList.contains('idle')).toBe(false)
    expect(container.querySelector('[aria-label="播放"]')).not.toBeNull()
  })

  it.each(['button', 'Escape-code', 'Escape-key'] as const)('StrictMode: paused recording toggle and %s exit remain responsive', async exitMethod => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1, true)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = .25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    expect(container.querySelector('[aria-label="播放"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    expect(container.querySelector('[aria-label="开启录音"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(mic.finishCapture).toHaveBeenCalledOnce()
    expect(mic.discardCapture).not.toHaveBeenCalled()
    await act(async () => {
      if (exitMethod === 'button') container.querySelector<HTMLButtonElement>('[aria-label="退出演奏"]')!.click()
      else window.dispatchEvent(new KeyboardEvent('keydown', exitMethod === 'Escape-code' ? { code: 'Escape' } : { key: 'Escape' }))
    })
    expect(useAppStore.getState().view).toBe('result')
    expect(useAppStore.getState().performanceSession?.status).toBe('completed')
    expect(mic.stop).toHaveBeenCalledOnce()
  })

  it('开始按钮连续点击只发起一次恢复和一组倒数节拍', async () => {
    let resolveResume!: () => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveResume = resolve
    }))
    await mountPerformPage(1)
    const start = containers.at(-1)!.querySelector<HTMLButtonElement>('.ov-start')!

    await act(async () => {
      start.click()
      start.click()
      await Promise.resolve()
    })
    expect(mocked.engine.resume).toHaveBeenCalledOnce()

    await act(async () => resolveResume())
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
  })

  it.each(['底栏播放按钮', '空格键'] as const)('就绪时使用%s会进入同一起奏倒数', async (entry) => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    mocked.engine.resume.mockClear()
    mocked.engine.scheduleTick.mockClear()

    await act(async () => {
      if (entry === '底栏播放按钮') {
        container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click()
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ', code: 'Space', bubbles: true,
        }))
      }
    })

    expect(mocked.engine.resume).toHaveBeenCalledOnce()
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
  })

  it('等待音频恢复时离开页面，恢复完成后不再申请麦克风或排倒数', async () => {
    let resolveResume!: () => void
    mocked.engine.resume.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveResume = resolve
    }))
    await mountPerformPage(1)
    const start = containers.at(-1)!.querySelector<HTMLButtonElement>('.ov-start')!
    await act(async () => start.click())
    await act(async () => roots.at(-1)!.unmount())
    roots.pop()

    await act(async () => resolveResume())
    expect(mocked.openMic).not.toHaveBeenCalled()
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
  })

  it('伴奏启动失败时不进入演奏或开始录音', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    mocked.engine.play.mockResolvedValueOnce(false)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    mocked.engine.ctxTime = 10
    await flushRaf()

    expect(useAppStore.getState().performanceSession?.status).toBe('preparing')
    expect(mic.restartCapture).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')?.disabled).toBe(true)
    expect(container.textContent).toContain('伴奏无法开始')
  })

  it('录音保存完成前停留在保存页，完成后才进入结果页', async () => {
    let resolveStop!: (value: { url: string; mime: string; silent: boolean }) => void
    const pendingStop = new Promise<{ url: string; mime: string; silent: boolean }>((resolve) => {
      resolveStop = resolve
    })
    const mic = makeMic(pendingStop)
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())

    expect(useAppStore.getState().performanceSession?.status).toBe('saving')
    expect(useAppStore.getState().view).toBe('perform')

    await act(async () => resolveStop({ url: 'blob:saved', mime: 'audio/wav', silent: false }))
    expect(useAppStore.getState().view).toBe('result')
    expect(useAppStore.getState().performanceSession?.status).toBe('completed')
  })

  it('麦克风晚到时以真正开始采集的伴奏位置记起点，并记录实际录音时长', async () => {
    let resolveMic!: (mic: ReturnType<typeof makeMic>) => void
    mocked.openMic.mockReturnValue(new Promise((resolve) => {
      resolveMic = resolve
    }))
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)

    mocked.engine.time = 4.25
    const mic = makeMic()
    await act(async () => resolveMic(mic))
    expect(mic.restartCapture).toHaveBeenCalledOnce()

    mocked.engine.time = 7.5
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    const take = useAppStore.getState().performanceSession?.take
    expect(take).toMatchObject({ startSec: 4.25, stopSec: 7.5, durationSec: 3.25 })
  })

  it('麦克风权限在暂停期间到达：先建立暂停采集段，继续后可保存本次录音', async () => {
    let resolveMic!: (mic: ReturnType<typeof makeMic>) => void
    mocked.openMic.mockReturnValue(new Promise((resolve) => {
      resolveMic = resolve
    }))
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)

    mocked.engine.time = 1.5
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    const mic = makeMic()
    await act(async () => resolveMic(mic))
    expect(mic.restartCapture).toHaveBeenCalledOnce()
    expect(mic.pauseCapture).toHaveBeenCalledOnce()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    // [countdown-semantic] 按播放先倒数：归零起播时才 resumeCapture
    expect(mic.resumeCapture).not.toHaveBeenCalled()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mic.resumeCapture).toHaveBeenCalledOnce()
    mocked.engine.time = 3
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())

    expect(useAppStore.getState().performanceSession).toMatchObject({
      status: 'completed',
      take: { startSec: 1.5, stopSec: 3, durationSec: 1.5 },
    })
  })

  it('暂停后伴奏恢复失败：保持暂停且不恢复采集', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    mic.resumeCapture.mockClear()
    mocked.engine.play.mockResolvedValueOnce(false)

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    mocked.engine.ctxTime = 20
    await flushRaf()

    expect(mic.resumeCapture).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
    expect(container.textContent).toContain('伴奏无法开始')
  })

  it('暂停后按播放的倒数中停止：立即封段结束，迟到的起播不会复活', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    mic.resumeCapture.mockClear()
    mocked.engine.ctxTime = 10

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(mic.resumeCapture).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    mocked.engine.pause.mockClear()
    mocked.engine.play.mockClear()
    mocked.engine.ctxTime = 20
    await flushRaf()

    expect(mic.resumeCapture).not.toHaveBeenCalled()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.playing).toBe(false)
    expect(useAppStore.getState().performanceSession?.status).toBe('completed')
  })

  it('页面卸载后才获准的麦克风会话会立即释放音轨', async () => {
    let resolveMic!: (mic: ReturnType<typeof makeMic>) => void
    mocked.openMic.mockReturnValue(new Promise((resolve) => {
      resolveMic = resolve
    }))
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    await act(async () => roots.at(-1)!.unmount())
    roots.pop()

    const mic = makeMic()
    await act(async () => resolveMic(mic))
    expect(mic.release).toHaveBeenCalledOnce()
  })

  it('就绪时点选小节只定位，下一次起奏从所选小节开始', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    expect(container.querySelector('.perform-overlay')).toBeNull()
    mocked.engine.seek.mockClear()
    mocked.engine.play.mockClear()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.play).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    mocked.engine.ctxTime = 10
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
  })

  it('倒数时可以点击停止按钮，封存已有分段且不再续播', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!
    expect(stop.disabled).toBe(false)
    mocked.engine.play.mockClear()
    await act(async () => stop.click())
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(useAppStore.getState().performanceSession?.segments).toHaveLength(1)
    expect(useAppStore.getState().performanceSession?.status).toBe('completed')
  })

  it('播放中点选小节：定位并落暂停态，按播放先倒数再从目标续录（不自动续播）', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(mocked.engine.pause).toHaveBeenCalled()
    expect(mic.finishCapture).toHaveBeenCalledOnce()
    expect(useAppStore.getState().performanceSession?.segments).toHaveLength(1)
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.5)
    // [countdown-semantic] 不自动重排倒数：落暂停态等播放
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
    expect(container.textContent).toContain('已定位，播放时从这里继续')

    // 时间推进也不自动起播
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()

    // 按播放：4 拍倒数后从定位点续录并开新段
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    mocked.engine.ctxTime = 30
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.playing).toBe(true)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })

  it('进度拖动只在 pointer-up 提交一次跳转', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    const rail = container.querySelector<HTMLElement>('.progress-rail')!
    Object.defineProperty(rail, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }),
    })
    Object.defineProperty(rail, 'setPointerCapture', { value: vi.fn() })
    mocked.engine.seek.mockClear()

    await act(async () => rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 20 })))
    await act(async () => rail.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 80 })))
    expect(mocked.engine.seek).not.toHaveBeenCalled()
    await act(async () => rail.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: 80 })))
    expect(mocked.engine.seek).toHaveBeenCalledTimes(1)
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.8)
  })

  it('暂停时点选会封存当前段并保持停止，恢复才从新位置继续', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(mic.finishCapture).toHaveBeenCalledOnce()
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(mocked.engine.play).not.toHaveBeenCalled()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    // [countdown-semantic] 按播放先倒数再从新位置续录
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })

  it('续录倒数中点选小节：取消倒数落在暂停态，按播放重新倒数后从定位点续录', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    // [countdown-semantic] 播放中点选：封段 + 定位落暂停态（无自动倒数）
    expect(useAppStore.getState().performanceSession?.segments).toHaveLength(1)
    mocked.engine.ctxTime = 10
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    mocked.engine.ctxTime = 11 // 新倒数 t0≈10.12，remain>0 → 倒数进行中
    await flushRaf()
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第1小节"]')!.click())
    // 新行为：倒数被打断——浮层消失、暂停态（播放键）、不自动重启、toast 提示定位
    expect(container.querySelector('.perform-overlay.countdown')).toBeNull()
    expect(container.querySelector('.ctl.main')!.getAttribute('aria-label')).toBe('播放')
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.1)
    expect(container.querySelector('.perform-toast')?.textContent).toContain('已定位')

    // 按播放：重新 4 拍倒数（而非直接续播），归零后从定位点续录
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    expect(mocked.engine.play).not.toHaveBeenCalled()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledTimes(1)
    expect(mocked.engine.play).toHaveBeenCalledWith(0.1)
    expect(mocked.engine.playing).toBe(true)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })

  it('初次倒数中点选小节：立即取消倒数并回到就绪浮层，不再自动重启', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    mocked.engine.ctxTime = 1 // t0=0.12、4 拍×0.5s → remain>0，倒数进行中
    await flushRaf()
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(container.querySelector('.count-num')!.textContent).toBe('3')

    mocked.engine.scheduleTick.mockClear()
    mocked.engine.play.mockClear()
    mocked.engine.seek.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    // 新行为：倒数取消、定位、回 ready（.ov-start 重现 = 等用户再点播放）
    expect(container.querySelector('.perform-overlay.countdown')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.ov-start')).not.toBeNull()
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.5)

    // 再点开始：天然重新倒数并从定位点起奏
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
  })

  it('就绪态改 BPM 后起奏：倒数节拍按 60/(tempo×rate) 缩放', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    expect(mocked.engine.rate).toBeCloseTo(119 / 120)
    mocked.engine.scheduleTick.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks).toHaveLength(4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalled()
  })

  it('初次倒数中改 BPM：取消当前倒数并按新速度自动重启（BPM 是显式速度操作，与谱面点击的「等播放」语义不同）', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    mocked.engine.ctxTime = 1
    await flushRaf()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    mocked.engine.play.mockClear()
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    // 旧倒数取消、新倒数按 119 BPM 排 4 拍
    const ticks = mocked.engine.scheduleTick.mock.calls.slice(-4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0)
    expect(mocked.engine.playing).toBe(true)
  })

  it('续录倒数中改 BPM：同样按新速度自动重启倒数并从定位点续录', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    // [countdown-semantic] 点选落暂停态，按播放进倒数后再改 BPM
    mocked.engine.ctxTime = 10
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    mocked.engine.ctxTime = 11
    await flushRaf()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    mocked.engine.play.mockClear()
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    const ticks = mocked.engine.scheduleTick.mock.calls.slice(-4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })

  it('tempoPending 期间播放/暂停无响应，setRate 完成后自动倒数续录恢复', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    let prepared!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>(resolve => { prepared = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    // 变速准备中：seekTo 已暂停引擎，按钮呈播放但点击无响应（锁定现状）
    expect(container.querySelector('.ctl.main')!.getAttribute('aria-label')).toBe('播放')
    mocked.engine.play.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(mocked.engine.play).not.toHaveBeenCalled()
    // setRate 完成 → 自动倒数续录
    mocked.engine.scheduleTick.mockClear()
    await act(async () => prepared(true))
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.25)
    expect(mocked.engine.playing).toBe(true)
  })

  it('保调变速失败：回暂停态提示「未能继续」，此后按播放直接续播原速度', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    mocked.engine.setRate.mockResolvedValueOnce(false)
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    expect(mocked.engine.rate).toBe(1)
    expect(container.querySelector('.ctl.main')!.getAttribute('aria-label')).toBe('播放')
    expect(container.textContent).toContain('未能继续')
    expect(container.querySelector('[aria-label="开启录音"]')).not.toBeNull()
    mocked.engine.scheduleTick.mockClear()
    mocked.engine.play.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    // [countdown-semantic] 按播放一律先倒数（不再直接续播）
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    expect(mocked.engine.play).not.toHaveBeenCalled()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalled()
    expect(mocked.engine.playing).toBe(true)
  })

  it('就绪态变速失败：保持就绪浮层并提示「未能继续」', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    mocked.engine.setRate.mockResolvedValueOnce(false)
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    expect(container.querySelector('.ov-start')).not.toBeNull()
    expect(container.textContent).toContain('未能继续')
  })

  it('连续改 BPM 三次：旧事务全部作废，仅最新速度生效且只保留最后一轮倒数', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    mocked.engine.play.mockClear()
    // 三次应用：119（播放中变速→自动倒数），118、117（各自打断上一轮倒数→按新速度重启）
    for (let i = 0; i < 3; i++) {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
      mocked.engine.ctxTime = 11 + i
      await flushRaf()
    }
    expect(mocked.engine.setRate).toHaveBeenCalledTimes(3)
    expect(mocked.engine.rate).toBeCloseTo(117 / 120)
    // 倒数共 4 轮（起奏 1 轮 + 变速 3 轮），最后一轮按 117 BPM
    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks).toHaveLength(16)
    expect(ticks[13]![0] - ticks[12]![0]).toBeCloseTo(60 / 117)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledTimes(1)
    expect(mocked.engine.play).toHaveBeenCalledWith(0.25)
    expect(mocked.engine.playing).toBe(true)
  })

  it('倒数中点击进度轨无效（进度轨只在演奏态允许定位）', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    mocked.engine.ctxTime = 1
    await flushRaf()
    const rail = container.querySelector<HTMLElement>('.progress-rail')!
    Object.defineProperty(rail, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }),
    })
    Object.defineProperty(rail, 'setPointerCapture', { value: vi.fn() })
    mocked.engine.seek.mockClear()
    await act(async () => rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 80 })))
    await act(async () => rail.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientX: 80 })))
    expect(mocked.engine.seek).not.toHaveBeenCalled()
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
  })

  it('第一次封段仍在等待时重复点选，最终仍按播放中语义从最后目标续播', async () => {
    let resolveSeal!: (result: { url: string; mime: string; silent: boolean }) => void
    const mic = makeMic()
    mic.finishCapture.mockReturnValueOnce(new Promise((resolve) => { resolveSeal = resolve }))
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    mocked.engine.play.mockClear()

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第1小节"]')!.click())
    await act(async () => resolveSeal({ url: 'blob:first', mime: 'audio/wav', silent: false }))
    mocked.engine.ctxTime = 20
    await flushRaf()

    // [countdown-semantic] 落暂停态不自动起播；按播放倒数后从最后目标 0.1 续录
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.seek).toHaveBeenLastCalledWith(0.1)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    mocked.engine.ctxTime = 30
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.1)
  })

  it('最新空段不会覆盖或丢失此前已封存段', async () => {
    const mic = makeMic()
    mic.finishCapture
      .mockResolvedValueOnce({ url: 'blob:first', mime: 'audio/wav', silent: false })
      .mockResolvedValueOnce(null)
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开启录音"]')!.click())
    mocked.engine.time = 0.75
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())

    expect(useAppStore.getState().performanceSession).toMatchObject({
      status: 'completed',
      take: { audioUrl: 'blob:first' },
      segments: [{ audioUrl: 'blob:first' }],
    })
  })

  it('最后封段失败时明确提示并保留此前录音', async () => {
    const mic = makeMic()
    mic.finishCapture
      .mockResolvedValueOnce({ url: 'blob:first', mime: 'audio/wav', silent: false })
      .mockRejectedValueOnce(new Error('gate timeout'))
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开启录音"]')!.click())
    mocked.engine.time = 0.75
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())

    expect(useAppStore.getState().performanceSession).toMatchObject({
      status: 'completed',
      message: expect.stringContaining('最后一段保存失败'),
      segments: [{ audioUrl: 'blob:first' }],
    })
  })

  it('停止后才到达的麦克风会话立即释放，不会重新开始采集', async () => {
    let resolveMic!: (mic: ReturnType<typeof makeMic>) => void
    mocked.openMic.mockReturnValue(new Promise((resolve) => { resolveMic = resolve }))
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    const lateMic = makeMic()
    await act(async () => resolveMic(lateMic))

    expect(lateMic.release).toHaveBeenCalledOnce()
    expect(lateMic.restartCapture).not.toHaveBeenCalled()
  })

  it('倒数起奏等待 capture gate 时停止，迟到确认不会复活已完成会话', async () => {
    let release!: () => void
    const mic = makeMic()
    mic.restartCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true,
    })))
    expect(useAppStore.getState().performanceSession?.status).toBe('no-recording')
    await act(async () => release())

    expect(useAppStore.getState().performanceSession?.status).not.toBe('recording')
    expect(mocked.engine.playing).toBe(false)
  })

  it('快速关开录音等待旧段封存时，新段起点取 gate 真正开启后的伴奏时间', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    let release!: (result: { url: string; mime: string; silent: boolean }) => void
    mic.finishCapture.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    mocked.engine.time = 0.2
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开启录音"]')!.click())
    expect(mic.restartCapture).toHaveBeenCalledTimes(1)

    mocked.engine.time = 0.6
    await act(async () => release({ url: 'blob:first', mime: 'audio/wav', silent: false }))
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
    mocked.engine.time = 0.8
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())

    expect(useAppStore.getState().performanceSession?.segments.at(-1)?.startSec).toBe(0.6)
  })

  it('恢复采集等待 gate 时停止，迟到确认不会恢复播放或 recording 状态', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    let release!: () => void
    mic.resumeCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    await act(async () => release())

    expect(useAppStore.getState().performanceSession?.status).not.toBe('recording')
    expect(mocked.engine.playing).toBe(false)
  })

  it('恢复采集等待 gate 时再次暂停，迟到确认仍保持暂停', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    let release!: () => void
    mic.resumeCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.ctl.main')!.click())
    expect(mocked.engine.playing).toBe(false)
    await act(async () => release())

    expect(container.querySelector('.ctl.main')?.getAttribute('aria-label')).toBe('播放')
  })

  it('续播倒数归零后 gate 迟到确认不会越过更新的倒数直接续播', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    mocked.engine.ctxTime = 10
    let release!: () => void
    mic.resumeCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    mocked.engine.ctxTime = 11.9 // 倒数进行中
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(mocked.engine.playing).toBe(false)
    mocked.engine.play.mockClear()
    await act(async () => release())

    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.play).not.toHaveBeenCalled()
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.seek).toHaveBeenLastCalledWith(0.5)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
  })

  it('倒数归零的采集 gate 挂起时点选小节：迟到确认丢弃采集并保持暂停定位', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    // [countdown-semantic] 点选落暂停态；按播放倒数，归零起播后新段 gate 挂起
    let release!: () => void
    mic.restartCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
    mocked.engine.ctxTime = 10
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(true)

    // gate 挂起期间点选另一小节：seekTo 作废挂起的采集请求，release 后 discard
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第1小节"]')!.click())
    await act(async () => release())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(mic.discardCapture).toHaveBeenCalled()
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.seek).toHaveBeenLastCalledWith(0.1)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
  })

  it('旧录音开启请求迟到时，不会关闭更新一轮的录音开启意图', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    let release!: () => void
    mic.restartCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开启录音"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label$="关闭录音"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开启录音"]')!.click())
    await act(async () => release())

    expect(container.querySelector('.ctl.rec')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('旧倒数封段的录音 gate 迟到时，不干扰新的定位与后续倒数', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.2
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    let release!: () => void
    mic.restartCapture.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve }))
    // [countdown-semantic] 点选落暂停态，无自动倒数
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(false)

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第1小节"]')!.click())
    // 排空 seekTo 异步链（seal→定位需要多个微任务 tick，单次 act 排不干）
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    mocked.engine.ctxTime = 30
    await flushRaf()
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.seek).toHaveBeenLastCalledWith(0.1)
    await act(async () => release())

    expect(mocked.engine.playing).toBe(false)
  })

  it('新演奏只释放上一会话的每个 retained URL 一次', async () => {
    const oldId = useAppStore.getState().beginPerformance('test-song')
    const base = {
      sessionId: oldId,
      songId: 'test-song',
      startedAt: 1,
      durationSec: 1,
      mimeType: 'audio/wav',
      startSec: 0,
      stopSec: 1,
      pitchTrack: null,
      stats: null,
    }
    useAppStore.getState().appendPerformanceSegment(oldId, { ...base, id: 'old-1', audioUrl: 'blob:old-1' })
    useAppStore.getState().appendPerformanceSegment(oldId, { ...base, id: 'old-2', audioUrl: 'blob:old-2' })
    useAppStore.getState().finishPerformance(oldId)
    vi.mocked(URL.revokeObjectURL).mockClear()

    await mountPerformPage(1)

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-2')
  })
})

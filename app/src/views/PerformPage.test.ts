import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { Take } from '../types'

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
  resetCursor: vi.fn(),
  openMic: vi.fn(),
  savePractice: vi.fn(async (_take: Take, _blob: Blob) => {}),
  loadAccompaniment: vi.fn(async () => ({ buffer: { duration: 1 }, synthesized: false })),
  cancelPendingAccompaniment: vi.fn(),
  engine: {
    time: 0,
    ctxTime: 0,
    duration: 1,
    playing: false,
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
  },
}))

vi.mock('../songs', () => ({
  getSong: () => fakeSong,
  SONGS: [fakeSong],
  loadSong: async () => ({
    xml: '<score-partwise/>',
    timeline: { durationSec: 1, secPerQuarter: 0.5, tempo: 120, notes: [], measureTimes: [{ measure: 1, time: 0, quarters: 0 }, { measure: 2, time: 0.5, quarters: 1 }] },
    cursorMode: 'anchors' as const,
  }),
}))
vi.mock('../audio/accompaniment', () => ({
  loadAccompaniment: mocked.loadAccompaniment,
  cancelPendingAccompaniment: mocked.cancelPendingAccompaniment,
}))
vi.mock('../audio/AudioEngine', () => ({ audioEngine: mocked.engine }))
vi.mock('../practice/history', () => ({ savePractice: mocked.savePractice }))
vi.mock('../audio/recorder', () => ({ openMic: mocked.openMic }))
vi.mock('../background/LumiereScene', () => ({
  LumiereScene: class {
    setAnalyser() {}
    resize() {}
    dispose() {}
  },
}))
vi.mock('../components/ScoreSheet', () => ({ default: ({ scoreRef }: { scoreRef?: { current: unknown } }) => { if (scoreRef) scoreRef.current = { resetCursor: mocked.resetCursor, showCursor() {}, syncToTime() {}, scrollToMeasure() {} }; return null } }))
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
    restartCapture: vi.fn(),
    pauseCapture: vi.fn(),
    resumeCapture: vi.fn(),
    discardCapture: vi.fn(),
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
  mocked.engine.onEnd = undefined
  mocked.engine.getVolume.mockReturnValue(1)
  mocked.savePractice.mockReset().mockResolvedValue(undefined)
  mocked.openMic.mockReset()
  mocked.openMic.mockResolvedValue(makeMic())
  mocked.loadAccompaniment.mockReset().mockResolvedValue({ buffer: { duration: 1 }, synthesized: false })
  useAppStore.setState({
    practiceConfig: null,
    storageError: null,
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
async function mountPerformPage(gainValue: number): Promise<HTMLInputElement | null> {
  mocked.engine.getVolume.mockReturnValue(gainValue)
  const { default: PerformPage } = await import('./PerformPage')
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  await act(async () => {
    const root = createRoot(container)
    roots.push(root)
    root.render(createElement(PerformPage))
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

describe('演奏页伴奏音量初值（t_5957a725）', () => {
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
})

describe('演奏录音会话', () => {
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

    expect(mic.resumeCapture).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
    expect(container.textContent).toContain('伴奏无法继续')
  })

  it('暂停恢复仍在等待时停止：迟到成功不会恢复采集或播放 UI', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    mic.resumeCapture.mockClear()
    let resolvePlay!: (started: boolean) => void
    mocked.engine.play.mockReturnValueOnce(new Promise<boolean>((resolve) => {
      resolvePlay = resolve
    }))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(mic.resumeCapture).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
    await act(async () => resolvePlay(true))

    expect(mic.resumeCapture).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
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
})


describe('分段练习轮次', () => {
  function configureLoop() {
    useAppStore.setState({ practiceConfig: { songId: 'test-song', range: { startMeasure: 2, endMeasure: 2, startSec: 0.5, stopSec: 1 }, rounds: 3 } })
  }
  it('persists three independent captures before each next countdown and ignores duplicate endings', async () => {
    configureLoop()
    const blobs = [1, 2, 3].map(n => new Blob([String(n)], { type: 'audio/wav' }))
    blobs.forEach((blob, i) => mocked.openMic.mockResolvedValueOnce(makeMic(Promise.resolve({ blob, url: `blob:round-${i}`, mime: 'audio/wav', silent: false }))))
    await mountPerformPage(1)
    await beginPerformance(containers.at(-1)!)
    for (let i = 0; i < 3; i++) {
      expect(mocked.engine.time).toBe(0.5)
      mocked.engine.time = 1.01
      const end = mocked.engine.onEnd!
      await act(async () => { end(); end() })
      expect(mocked.savePractice).toHaveBeenCalledTimes(i + 1)
      if (i < 2) {
        expect(mocked.resetCursor).toHaveBeenCalledTimes(i + 2)
        expect(useAppStore.getState().view).toBe('perform')
        mocked.engine.ctxTime += 10
        await flushRaf()
        await act(async () => end()) // callback from preceding round
        expect(mocked.savePractice).toHaveBeenCalledTimes(i + 1)
      }
    }
    const takes = mocked.savePractice.mock.calls.map(([take]) => take)
    expect(new Set(takes.map(t => t.sessionId)).size).toBe(3)
    expect(takes.map(t => t.audioBlob)).toEqual(blobs)
    expect(takes.map(t => [t.startSec, t.stopSec, t.practice?.round])).toEqual([[0.5, 1.01, 1], [0.5, 1.01, 2], [0.5, 1.01, 3]])
    expect(takes.every(t => t.practice?.scoredNotesKey)).toBe(true)
    expect(useAppStore.getState().view).toBe('result')
  })
  it('a storage failure stops loops and preserves the unsaved playable recording', async () => {
    configureLoop()
    mocked.savePractice.mockRejectedValueOnce(new Error('QuotaExceededError'))
    mocked.openMic.mockResolvedValueOnce(makeMic(Promise.resolve({ blob: new Blob(['audio']), url: 'blob:unsaved', mime: 'audio/wav', silent: false })))
    await mountPerformPage(1)
    await beginPerformance(containers.at(-1)!)
    mocked.engine.time = 1
    await flushRaf()
    expect(useAppStore.getState().view).toBe('result')
    expect(useAppStore.getState().lastTake?.audioUrl).toBe('blob:unsaved')
    expect(useAppStore.getState().storageError).toContain('QuotaExceededError')
    expect(mocked.openMic).toHaveBeenCalledTimes(1)
  })
  it('recording disabled by the user remains disabled in later listening rounds', async () => {
    configureLoop()
    await mountPerformPage(1)
    const page = containers.at(-1)!
    await beginPerformance(page)
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="关闭录音"]')!.click())
    mocked.engine.time = 1
    await flushRaf()
    mocked.engine.ctxTime += 10
    await flushRaf()
    expect(page.querySelector('[aria-label="开启录音"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(mocked.savePractice).not.toHaveBeenCalled()
  })
})


it('leaving during persistence prevents a late save from navigating or starting another round', async () => {
  let resolve!: () => void
  mocked.savePractice.mockReturnValueOnce(new Promise<void>(r => { resolve = r }))
  useAppStore.setState({ practiceConfig: { songId: 'test-song', range: { startMeasure: 1, endMeasure: 2, startSec: 0, stopSec: 1 }, rounds: 3 } })
  mocked.openMic.mockResolvedValueOnce(makeMic(Promise.resolve({ blob: new Blob(['a']), url: 'blob:late', mime: 'audio/wav', silent: false })))
  await mountPerformPage(1)
  await beginPerformance(containers.at(-1)!)
  mocked.engine.time = 1
  await flushRaf()
  expect(useAppStore.getState().performanceSession?.status).toBe('saving')
  expect(mocked.engine.playing).toBe(false)
  await act(async () => roots.pop()!.unmount())
  useAppStore.getState().go('home')
  await act(async () => resolve())
  expect(useAppStore.getState().view).toBe('home')
  expect(mocked.openMic).toHaveBeenCalledTimes(1)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late')
})
it('loop seek never lands on the buffer end that the engine wraps to zero', async () => {
  useAppStore.setState({ practiceConfig: { songId: 'test-song', range: { startMeasure: 2, endMeasure: 2, startSec: 0.5, stopSec: 1 }, rounds: 3 } })
  await mountPerformPage(1)
  const page = containers.at(-1)!
  await beginPerformance(page)
  const rail = page.querySelector<HTMLElement>('.progress-rail')!
  rail.setPointerCapture = () => {}
  rail.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
  await act(async () => rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, pointerId: 1 })))
  expect(mocked.engine.time).toBeLessThan(1)
  expect(mocked.engine.time).toBeGreaterThanOrEqual(0.5)
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="回开头"]')!.click())
  expect(mocked.engine.time).toBe(0.5)
})


it('denied microphone keeps all three rounds visibly listening-only after transient messages expire', async () => {
  useAppStore.setState({ practiceConfig: { songId: 'test-song', range: { startMeasure: 1, endMeasure: 2, startSec: 0, stopSec: 1 }, rounds: 3 } })
  mocked.openMic.mockRejectedValue(new Error('Permission denied'))
  await mountPerformPage(1)
  const page = containers.at(-1)!
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    await beginPerformance(page)
    for (let round = 1; round <= 3; round++) {
      await act(async () => vi.advanceTimersByTimeAsync(3500))
      expect(page.querySelector('.perform-toast')).toBeNull()
      expect(page.querySelector('.rec-badge')).toBeNull()
      expect(page.querySelector('.ctl.rec')?.getAttribute('aria-pressed')).toBe('false')
      expect(page.textContent).toContain('听练（无录音）')
      expect(page.textContent).toContain('麦克风不可用')
      mocked.engine.time = 1
      await flushRaf()
      if (round < 3) { mocked.engine.ctxTime += 10; await flushRaf() }
    }
    expect(mocked.savePractice).not.toHaveBeenCalled()
    expect(useAppStore.getState().performanceSession?.status).toBe('no-recording')
  } finally { vi.useRealTimers() }
})
it('pending microphone shows no REC until late permission starts capture at the actual time', async () => {
  let resolve!: (mic: ReturnType<typeof makeMic>) => void
  mocked.openMic.mockReturnValue(new Promise(r => { resolve = r }))
  await mountPerformPage(1)
  const page = containers.at(-1)!
  await beginPerformance(page)
  expect(page.querySelector('.rec-badge')).toBeNull()
  expect(page.textContent).toContain('正在等待麦克风')
  mocked.engine.time = 0.25
  const mic = makeMic()
  await act(async () => resolve(mic))
  expect(page.querySelector('.rec-badge')).not.toBeNull()
  expect(page.textContent).not.toContain('正在等待麦克风')
  mocked.engine.time = 0.75
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
  expect(useAppStore.getState().lastTake).toMatchObject({ startSec: 0.25, stopSec: 0.75 })
})
it('retrying an unavailable microphone starts only the current capture without changing recording preference', async () => {
  mocked.openMic.mockRejectedValue(new Error('Permission denied'))
  await mountPerformPage(1)
  const page = containers.at(-1)!
  await beginPerformance(page)
  mocked.openMic.mockResolvedValue(makeMic())
  mocked.engine.time = 0.4
  const retry = [...page.querySelectorAll('button')].find(b => b.textContent?.includes('重试麦克风'))
  expect(retry).toBeDefined()
  await act(async () => retry!.click())
  expect(page.querySelector('.rec-badge')).not.toBeNull()
  mocked.engine.time = 0.8
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="停止演奏"]')!.click())
  expect(useAppStore.getState().lastTake).toMatchObject({ startSec: 0.4, stopSec: 0.8 })
})

it('canceling a pending recording request prevents late permission from recording', async () => {
  let resolve!: (mic: ReturnType<typeof makeMic>) => void
  mocked.openMic.mockReturnValue(new Promise(r => { resolve = r }))
  await mountPerformPage(1)
  const page = containers.at(-1)!
  await beginPerformance(page)
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="取消录音请求"]')!.click())
  const mic = makeMic()
  await act(async () => resolve(mic))
  expect(mic.restartCapture).not.toHaveBeenCalled()
  expect(page.querySelector('.rec-badge')).toBeNull()
  expect(page.textContent).toContain('录音已关闭')
  expect(page.querySelector('[aria-label="开启录音"]')).not.toBeNull()
})

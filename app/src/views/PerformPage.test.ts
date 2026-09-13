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
    timeline: { durationSec: 1, secPerQuarter: 0.5, tempo: 120, notes: [] },
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
vi.mock('../components/ScoreSheet', () => ({ default: () => null }))
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
    expect(mic.discardCapture).toHaveBeenCalledOnce()
    await act(async () => {
      if (exitMethod === 'button') container.querySelector<HTMLButtonElement>('[aria-label="退出演奏"]')!.click()
      else window.dispatchEvent(new KeyboardEvent('keydown', exitMethod === 'Escape-code' ? { code: 'Escape' } : { key: 'Escape' }))
    })
    expect(useAppStore.getState().view).toBe('result')
    expect(useAppStore.getState().performanceSession?.status).toBe('no-recording')
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

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../audio/synth', () => ({ synthAccompaniment: async () => ({ duration: 1 }) }))
vi.mock('../background/LumiereScene', () => ({
  LumiereScene: class {
    setAnalyser() {}
    resize() {}
    dispose() {}
  },
}))
vi.mock('../components/ScoreSheet', () => ({ default: () => null }))
vi.mock('../components/PitchMeter', () => ({ default: () => null }))

/** 最小 AudioContext mock：gain 初值由用例注入（new Ctor() 返回 ctx 覆盖 this） */
function makeCtx(gainValue: number) {
  return {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    resume: vi.fn(async () => {}),
    createGain: () => ({ gain: { value: gainValue }, connect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 0, connect: vi.fn() }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
      onended: null,
    }),
    createOscillator: () => ({
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createMediaElementSource: () => ({ connect: vi.fn() }),
    decodeAudioData: vi.fn(),
    destination: {},
  }
}

let roots: Root[] = []
let containers: HTMLElement[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // watchEnd 用 rAF 轮询：stub 成可控假实现，避免 happy-dom 定时器跨用例泄漏
  let seq = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => ++seq))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  for (const c of containers) c.remove()
  containers = []
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** 以引擎初始增益 gainValue 挂载演奏页，返回 ControlBar 伴奏音量滑杆 */
async function mountPerformPage(gainValue: number): Promise<HTMLInputElement | null> {
  vi.resetModules()
  const ctx = makeCtx(gainValue)
  const Ctor = function () {
    return ctx
  } as unknown as new () => AudioContext
  vi.stubGlobal('AudioContext', Ctor)
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

describe('演奏页伴奏音量初值（t_5957a725）', () => {
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
})

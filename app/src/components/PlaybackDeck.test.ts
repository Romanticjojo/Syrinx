import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 回放卡伴奏滑杆条件显示（t_5957a725）：伴奏音量即 audioEngine 全局增益，
 *  与演奏页背景伴奏共用。未开「对照伴奏播放」（showAccVol 缺省/false）时
 *  伴奏滑杆不该出现、挂载也不该写引擎——只回听录音不该动演奏页音量；
 *  开启对照后滑杆出现、初值接引擎、拖动实时写引擎。 */

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
    // 录音增益接线走真实 recGraph（WeakMap 幂等），mock 足够它接通、不打 warn
    createMediaElementSource: () => ({ connect: vi.fn() }),
    decodeAudioData: vi.fn(),
    destination: {},
  }
}

let roots: Root[] = []
let containers: HTMLElement[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

/** 引擎增益定为 gainValue，取回挂载所需的真实组件与 setVolume 侦探 */
async function setupDeck(gainValue: number) {
  vi.resetModules()
  const ctx = makeCtx(gainValue)
  const Ctor = function () {
    return ctx
  } as unknown as new () => AudioContext
  vi.stubGlobal('AudioContext', Ctor)
  const { audioEngine } = await import('../audio/AudioEngine')
  const setVolumeSpy = vi.spyOn(audioEngine, 'setVolume')
  const { default: PlaybackDeck } = await import('./PlaybackDeck')
  return { audioEngine, PlaybackDeck, setVolumeSpy }
}

interface DeckProps {
  showAccVol?: boolean
}

/** 渲染回放卡（录音元素 ref 由测试持有，与真实用法一致），返回容器 */
async function renderDeck(
  PlaybackDeck: (props: never) => unknown,
  audioRef: { current: HTMLAudioElement | null },
  props: DeckProps,
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  await act(async () => {
    const root = createRoot(container)
    roots.push(root)
    root.render(
      createElement(PlaybackDeck as never, {
        src: 'about:blank',
        accent: '#3ddfae',
        audioRef,
        ...props,
      } as never),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
  return container
}

describe('未开对照（showAccVol 缺省/false）：只渲染录音滑杆', () => {
  it('伴奏滑杆不出现，录音滑杆保留', async () => {
    const { PlaybackDeck } = await setupDeck(1)
    const container = await renderDeck(PlaybackDeck, { current: null }, {})
    expect(container.querySelector("input[aria-label='伴奏音量']")).toBeNull()
    expect(container.querySelector("input[aria-label='录音音量']")).not.toBeNull()
  })

  it('挂载不写 audioEngine 音量（只回听录音不动演奏页增益）', async () => {
    const { audioEngine, PlaybackDeck, setVolumeSpy } = await setupDeck(0.4)
    const container = await renderDeck(PlaybackDeck, { current: null }, { showAccVol: false })
    void container
    expect(setVolumeSpy).not.toHaveBeenCalled()
    expect(audioEngine.getVolume()).toBe(0.4)
  })
})

describe('开对照（showAccVol=true）：伴奏滑杆出现且接管引擎', () => {
  it('滑杆出现，初值接住引擎实际增益', async () => {
    const { PlaybackDeck } = await setupDeck(0.4)
    const container = await renderDeck(PlaybackDeck, { current: null }, { showAccVol: true })
    const acc = container.querySelector<HTMLInputElement>("input[aria-label='伴奏音量']")
    expect(acc).not.toBeNull()
    expect(parseFloat(acc!.value)).toBeCloseTo(0.4, 3)
  })

  it('拖伴奏滑杆 → audioEngine.setVolume 生效', async () => {
    const { audioEngine, PlaybackDeck } = await setupDeck(0.4)
    const container = await renderDeck(PlaybackDeck, { current: null }, { showAccVol: true })
    const acc = container.querySelector<HTMLInputElement>("input[aria-label='伴奏音量']")!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        'value',
      )!.set!
      set.call(acc, '0.85')
      acc.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(audioEngine.getVolume()).toBeCloseTo(0.85, 3)
  })
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HomePage from './HomePage'
import { SONGS } from '../songs'

/** 触屏封面动画（t_e031ae5d 方案 A）：(hover:none)+(pointer:coarse) 语境下
 *  卡片进视口自动预览一次（IntersectionObserver 驱动；播过即标记，滚动往返
 *  不反复拉流；离开视口暂停回封面——video 预热保活，语义是 visibility 回隐藏）。
 *  桌面（hover:hover）语境 observer 不创建，hover 预览回归不受影响。 */

type IOCallback = (entries: { isIntersecting: boolean }[]) => void

let ioCallbacks: IOCallback[] = []
let ioCreated = 0

class IOStub {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
  constructor(cb: IOCallback) {
    ioCallbacks.push(cb)
    ioCreated += 1
  }
}

/** 触发全部已注册 observer（每张卡一个实例，单句柄只覆盖最后一张） */
const fireAll = (isIntersecting: boolean) => {
  for (const cb of ioCallbacks) cb([{ isIntersecting }])
}

const mediaStub = (matches: boolean) => (q: string) => ({
  matches: q.includes('(hover: none)') ? matches : false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})

let roots: Root[] = []
let containers: HTMLElement[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('IntersectionObserver', IOStub)
  // happy-dom 媒体元素行为不完整：play/pause 直接 mock（组件里 play().catch()
  // 在 undefined 返回值下会 TypeError），本组测试只断言挂载/可见性语义
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.useFakeTimers()
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  for (const c of containers) c.remove()
  containers = []
  ioCallbacks = []
  ioCreated = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountHome(coarse: boolean) {
  vi.stubGlobal('matchMedia', mediaStub(coarse))
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HomePage, null))
  })
  return container
}

describe('SongCard 触屏自动预览（t_e031ae5d）', () => {
  it('触屏语境：卡片进视口后（延迟消散）挂载预览视频并可见', async () => {
    const container = await mountHome(true)
    expect(ioCreated).toBeGreaterThan(0) // observer 已为卡片创建
    const cards = container.querySelectorAll<HTMLButtonElement>('.song-card')
    expect(cards.length).toBeGreaterThan(0)
    act(() => {
      fireAll(true)
    })
    await act(async () => {
      vi.advanceTimersByTime(250) // 越过 PREVIEW_DELAY_MS=200
    })
    const v = container.querySelector<HTMLVideoElement>('.art-preview')
    expect(v).not.toBeNull()
    expect(v!.style.visibility).toBe('visible')
  })

  it('触屏语境：离开视口暂停回封面；再进视口恢复播放（9/8 二轮循环语义）', async () => {
    const container = await mountHome(true)
    act(() => {
      fireAll(true)
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    const v = container.querySelector<HTMLVideoElement>('.art-preview')!
    expect(v.style.visibility).toBe('visible')

    act(() => {
      fireAll(false) // 离开视口 → 暂停回封面（video 预热保活，可见性回隐藏）
    })
    expect(v).not.toBeNull() // warmed 保活不卸载
    expect(v.style.visibility).toBe('hidden')

    await act(async () => {
      fireAll(true) // 再次进视口：循环语义下恢复播放（旧「只播一次」闸已删）
      vi.advanceTimersByTime(300)
    })
    expect(v.style.visibility).toBe('visible')
    expect(v.loop).toBe(true) // 非 once 曲触屏一律循环（用户钦定 9/8）
  })

  it('桌面语境：observer 不创建，hover 预览行为保持原样', async () => {
    const container = await mountHome(false)
    expect(ioCreated).toBe(0) // 桌面不创建 observer
    const card = container.querySelector<HTMLButtonElement>('.song-card')!
    await act(async () => {
      // React 的 onMouseEnter 由 mouseover 委托推导，派发 mouseover 触发
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    const v = container.querySelector<HTMLVideoElement>('.art-preview')
    expect(v).not.toBeNull()
    expect(v!.style.visibility).toBe('visible')
  })

  it('触屏语境：hoverPlayOnce/playOnce 曲 ended 定格末帧可见，非 once 曲 loop 循环（9/8 二轮）', async () => {
    const container = await mountHome(true)
    act(() => {
      fireAll(true)
    })
    await act(async () => {
      vi.advanceTimersByTime(250) // 全部卡片越过 PREVIEW_DELAY_MS，视频挂载
    })
    // 卡片与 SONGS 顺序一一对应；只挑有预览视频的曲做 ended/loop 对照
    const playable = SONGS.filter((s) => s.hoverVideoUrl || s.backgroundVideoUrl)
    const once = playable.find((s) => s.playOnce || s.hoverPlayOnce)
    const loop = playable.find((s) => !s.playOnce && !s.hoverPlayOnce)
    expect(once).toBeDefined()
    expect(loop).toBeDefined()
    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>('.song-card'))
    const vOnce = cards[SONGS.indexOf(once!)].querySelector<HTMLVideoElement>('.art-preview')!
    const vLoop = cards[SONGS.indexOf(loop!)].querySelector<HTMLVideoElement>('.art-preview')!
    // 循环语义（用户钦定 9/8）：非 once 曲 loop=true 原生循环，ended 不会发生；
    // once 曲 loop=false 播完 ended 定格末帧
    expect(vOnce.loop).toBe(false)
    expect(vLoop.loop).toBe(true)
    act(() => {
      // 媒体事件不冒泡、React 直接在元素上挂监听——派发 ended 触发 onEnded（once 曲仍无监听，
      // 派发只为验证「无 onEnded 停播」——定格曲 visibility 由 previewing 态保持）
      vOnce.dispatchEvent(new Event('ended'))
      vLoop.dispatchEvent(new Event('ended'))
    })
    expect(vOnce.style.visibility).toBe('visible') // 定格曲：末帧保持可见
    expect(vLoop.style.visibility).toBe('visible') // 循环曲：ended 后仍在播放态（循环无停播）
  })
})

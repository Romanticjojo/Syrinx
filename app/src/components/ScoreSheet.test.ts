import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Timeline } from '../types'

/** [t_1d124051] 谱面小屏混合适配组件测试：
 *  - fit（视口 ≥640px）：三层结构 .sheet-container > .sheet-scale > .sheet-virtual，
 *    OSMD 按 1280px 虚拟宽渲染（autoResize 必须关——OSMD 的 window resize 监听
 *    无条件全量重渲，开着违背「旋转只改 scale 不重排」）；外层 transform: scale(k)
 *    + 高度补偿；窗口 resize 只更新 scale，不重建实例不重载谱面
 *  - reflow（<640px 手机竖屏）：维持现状——容器即 .sheet-container，autoResize 开
 *  - 跨 640px 阈值：整棵重建（dispose 旧实例、新实例重新 load）
 *  - autoShowCursor：演奏中跨阈值重挂载后 load 完成即恢复光标（不再触发 HUD
 *    初始化回调——演奏中 HUD 由 rAF 主循环驱动） */

const registry = vi.hoisted(() => ({
  instances: [] as Array<{
    container: HTMLElement
    args: unknown[]
    load: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    setViewScale: ReturnType<typeof vi.fn>
    showCursor: ReturnType<typeof vi.fn>
    onMeasureChange: ((m: number, total: number) => void) | undefined
  }>,
}))

vi.mock('../score/OSMDScore', () => ({
  OSMDScore: class {
    container: HTMLElement
    args: unknown[]
    load = vi.fn(async () => {})
    dispose = vi.fn()
    setViewScale = vi.fn()
    showCursor = vi.fn()
    onMeasureChange: ((m: number, total: number) => void) | undefined
    constructor(container: HTMLElement, ...args: unknown[]) {
      this.container = container
      this.args = args
      registry.instances.push(this as (typeof registry.instances)[number])
    }
  },
}))

/** 可控 matchMedia：只关心 (min-width: 640px)，setViewport 越过阈值时通知监听方 */
function stubMediaAtLeast640(initial: boolean) {
  let minW640 = initial
  const listeners = new Set<() => void>()
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => {
    const isFitQuery = q.includes('min-width') && q.includes('640')
    return {
      get matches() {
        return isFitQuery ? minW640 : false
      },
      media: q,
      addEventListener: (_: string, cb: () => void) => {
        if (isFitQuery) listeners.add(cb)
      },
      removeEventListener: (_: string, cb: () => void) => {
        listeners.delete(cb)
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
  })
  return {
    setViewport(w: number) {
      const next = w >= 640
      if (next === minW640) return
      minW640 = next
      for (const cb of [...listeners]) cb()
    },
  }
}

const MINI_TIMELINE: Timeline = {
  durationSec: 4,
  secPerQuarter: 0.5,
  tempo: 120,
  notes: [{ time: 0, duration: 2, midi: 72, measure: 1 }],
  measureTimes: [
    { measure: 1, time: 0, quarters: 0 },
    { measure: 2, time: 2, quarters: 4, end: true },
  ],
}

let roots: Root[] = []
let rafCbs: FrameRequestCallback[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  registry.instances.length = 0
  rafCbs = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCbs.push(cb)
    return rafCbs.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

const flushRaf = () => {
  const cbs = rafCbs
  rafCbs = []
  for (const cb of cbs) cb(performance.now())
}

type SheetProps = {
  xml?: string | null
  timeline?: Timeline | null
  autoShowCursor?: boolean
  onMeasureChange?: (m: number, total: number) => void
  autoScroll?: boolean
}

async function mountSheet(props: SheetProps = {}) {
  const { default: ScoreSheet } = await import('./ScoreSheet')
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    const root = createRoot(host)
    roots.push(root)
    root.render(
      createElement(ScoreSheet, {
        xml: '<score-partwise/>',
        timeline: MINI_TIMELINE,
        ...props,
      }),
    )
  })
  // 冲刷 load 异步链，让 .then（HUD 初始化 / showCursor / fit 缩放）落在 act 内
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
    flushRaf()
  })
  return host
}

describe('ScoreSheet 小屏混合适配（t_1d124051）', () => {
  it('fit（视口 ≥640px）：三层结构，OSMD 容器为虚拟宽节点，autoResize 关闭', async () => {
    stubMediaAtLeast640(true)
    const host = await mountSheet({ autoScroll: false })
    const scroller = host.querySelector('.sheet-container')
    const wrap = host.querySelector('.sheet-scale')
    const virt = host.querySelector('.sheet-virtual')
    expect(scroller).not.toBeNull()
    expect(wrap).not.toBeNull()
    expect(virt).not.toBeNull()
    expect(wrap!.parentElement).toBe(scroller)
    expect(virt!.parentElement).toBe(wrap)
    // 构造实参序：(accent, osmdInstance, zoom, selectionColor, cursorSpan, autoScroll, autoResize)
    const inst = registry.instances.at(-1)!
    expect(inst.container).toBe(virt)
    expect(inst.args[5]).toBe(false) // autoScroll 原样透传（演奏页 false）
    expect(inst.args[6]).toBe(false) // fit 模式必须关 OSMD window-resize 自动重渲
  })

  it('fit：k = 容器宽/1280 → transform scale + 高度补偿 ceil(H·k) + setViewScale；resize 只改 scale 不重建', async () => {
    stubMediaAtLeast640(true)
    const host = await mountSheet()
    const scroller = host.querySelector<HTMLElement>('.sheet-container')!
    const wrap = host.querySelector<HTMLElement>('.sheet-scale')!
    const virt = host.querySelector<HTMLElement>('.sheet-virtual')!
    // happy-dom 无布局：宽高以 getter 桩注入（744px 容器、虚拟谱面高 2000px）
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, get: () => 744 })
    Object.defineProperty(virt, 'offsetHeight', { configurable: true, get: () => 2000 })
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    flushRaf()
    const k = 744 / 1280
    expect(wrap.style.transform).toBe(`scale(${k})`)
    expect(wrap.style.height).toBe(`${Math.ceil(2000 * k)}px`)
    const inst = registry.instances.at(-1)!
    expect(inst.setViewScale).toHaveBeenCalledWith(k)
    // 核心收益：缩窗不重排——实例不重建、谱面不重载
    expect(registry.instances).toHaveLength(1)
    expect(inst.load).toHaveBeenCalledTimes(1)
  })

  it('resize 连发：rAF 合并 flag 用后复位，第二次缩窗仍更新 scale（旋转场景）', async () => {
    stubMediaAtLeast640(true)
    const host = await mountSheet()
    const scroller = host.querySelector<HTMLElement>('.sheet-container')!
    const wrap = host.querySelector<HTMLElement>('.sheet-scale')!
    const virt = host.querySelector<HTMLElement>('.sheet-virtual')!
    let w = 744
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, get: () => w })
    Object.defineProperty(virt, 'offsetHeight', { configurable: true, get: () => 2000 })
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    flushRaf()
    expect(wrap.style.transform).toBe(`scale(${744 / 1280})`)
    // 旋转/再缩窗：第一次 resize 的 rAF 已执行完，flag 必须复位让新 resize 可再排队
    w = 640
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    flushRaf()
    expect(wrap.style.transform).toBe(`scale(${640 / 1280})`)
    expect(wrap.style.height).toBe(`${Math.ceil(2000 * (640 / 1280))}px`)
  })

  it('reflow（视口 <640px 手机竖屏）：维持现状——容器即 .sheet-container，无 wrapper，autoResize 开', async () => {
    stubMediaAtLeast640(false)
    const host = await mountSheet()
    expect(host.querySelector('.sheet-scale')).toBeNull()
    expect(host.querySelector('.sheet-virtual')).toBeNull()
    const scroller = host.querySelector<HTMLElement>('.sheet-container')!
    const inst = registry.instances.at(-1)!
    expect(inst.container).toBe(scroller)
    expect(inst.args[6]).toBe(true) // 现状：OSMD window resize 自动重排保留
    expect(inst.setViewScale).not.toHaveBeenCalled()
  })

  it('跨 640px 阈值：dispose 旧实例、按新模式重建并重新 load', async () => {
    const media = stubMediaAtLeast640(true)
    const host = await mountSheet()
    const fitInst = registry.instances.at(-1)!
    media.setViewport(600) // 越过阈值 → reflow
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(fitInst.dispose).toHaveBeenCalled()
    const reflowInst = registry.instances.at(-1)!
    expect(reflowInst).not.toBe(fitInst)
    expect(reflowInst.load).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.sheet-virtual')).toBeNull()
    expect(reflowInst.container).toBe(host.querySelector('.sheet-container'))
  })

  it('跨阈值往返：上穿回 fit 后新树真正在文档中（dispose 不得清掉 React 刚插入的子树）', async () => {
    const media = stubMediaAtLeast640(true)
    const host = await mountSheet()
    media.setViewport(600) // 下穿 reflow
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    media.setViewport(800) // 上穿回 fit
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const virt = host.querySelector('.sheet-virtual')
    expect(virt).not.toBeNull()
    // 孤儿复现点：mode 切换的 effect cleanup 先于本断言，dispose 的
    // containerEl.innerHTML='' 若清的是被 React 复用的容器，会把刚提交的
    // fit 三层树连锅端（virt.isConnected=false、新实例渲染进脱文档节点）
    expect(virt!.isConnected).toBe(true)
    const inst = registry.instances.at(-1)!
    expect(inst.container).toBe(virt)
  })

  it('autoShowCursor=true：load 完成恢复光标且不触发 HUD 初始化回调', async () => {
    stubMediaAtLeast640(true)
    const onMeasureChange = vi.fn()
    await mountSheet({ autoShowCursor: true, onMeasureChange })
    const inst = registry.instances.at(-1)!
    expect(inst.showCursor).toHaveBeenCalledTimes(1)
    expect(onMeasureChange).not.toHaveBeenCalled()
  })

  it('autoShowCursor=false（缺省）：保持现状——load 完成上报 HUD 第 1 小节，不显示光标', async () => {
    stubMediaAtLeast640(true)
    const onMeasureChange = vi.fn()
    await mountSheet({ onMeasureChange })
    const inst = registry.instances.at(-1)!
    expect(inst.showCursor).not.toHaveBeenCalled()
    expect(onMeasureChange).toHaveBeenCalledWith(1, 1)
  })
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SongManifest } from '../types'
import SongSwitcher from './SongSwitcher'

/** 歌曲切换器冒烟（R3）：触发钮显示当前曲名；下拉列出全部曲目、当前曲
 *  高亮、无 beatsUrl 灰显禁用（「无 beats」标注、点选不回调）；键盘
 *  ↓↑ 移动焦点（跳过禁用行）、Esc 收起并还焦点触发钮。Enter/空格选中
 *  是原生 button 行为，等价于 click()，不重复断言。 */

const mk = (o: Partial<SongManifest>) => o as SongManifest
const FIXTURE: SongManifest[] = [
  mk({ id: 'luv-letter', title: 'Luv Letter', accent: '#5fb8a8', difficulty: 3, beatsUrl: '/b.json' }),
  mk({ id: 'flower-dance', title: 'Flower Dance', accent: '#e8b04b', difficulty: 2, beatsUrl: '/f.json' }),
  mk({ id: 'lumiere', title: 'Nocturne pour Lumière', accent: '#3ddfae', difficulty: 2 }), // 无 beatsUrl
]

let roots: Root[] = []
let containers: HTMLElement[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  for (const c of containers) c.remove()
  containers = []
  vi.resetModules()
})

async function mount(currentId = 'luv-letter') {
  const onSelect = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  await act(async () => {
    const root = createRoot(container)
    roots.push(root)
    root.render(createElement(SongSwitcher, { songs: FIXTURE, currentId, onSelect }))
  })
  return { container, onSelect }
}

/** 在元素上派发键盘事件（React 合成事件靠冒泡到根节点接收） */
function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function itemsOf(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('.st-sw-item')]
}

describe('SongSwitcher', () => {
  it('触发钮显示当前曲名；点击展开面板列出全部曲目', async () => {
    const { container } = await mount()
    const btn = container.querySelector<HTMLButtonElement>('.st-sw-btn')!
    expect(btn.textContent).toContain('Luv Letter')
    expect(container.querySelector('.st-sw-panel')).toBeNull()
    await act(async () => {
      btn.click()
    })
    const items = itemsOf(container)
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('Luv Letter')
    expect(items[1].textContent).toContain('Flower Dance')
    expect(items[2].textContent).toContain('Nocturne pour Lumière')
    expect(items[1].textContent).toContain('★'.repeat(2))
  })

  it('当前曲高亮（aria-selected + cur），无 beats 曲禁用并标注「无 beats」', async () => {
    const { container } = await mount('flower-dance')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.st-sw-btn')!.click()
    })
    const items = itemsOf(container)
    expect(items[1].getAttribute('aria-selected')).toBe('true')
    expect(items[1].className).toContain('cur')
    expect(items[0].getAttribute('aria-selected')).toBe('false')
    expect(items[2].getAttribute('aria-disabled')).toBe('true')
    expect(items[2].className).toContain('off')
    expect(items[2].textContent).toContain('无 beats')
  })

  it('点选可用曲：回调带 id 且面板收起；点禁用曲：不回调、面板不收', async () => {
    const { container, onSelect } = await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.st-sw-btn')!.click()
    })
    const items = itemsOf(container)
    await act(async () => {
      items[1].click()
    })
    expect(onSelect).toHaveBeenCalledWith('flower-dance')
    expect(container.querySelector('.st-sw-panel')).toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.st-sw-btn')!.click()
    })
    await act(async () => {
      itemsOf(container)[2].click()
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.st-sw-panel')).not.toBeNull()
  })

  it('键盘：打开聚焦当前曲行，↓↑ 移动并跳过禁用行，Esc 收起还焦点', async () => {
    const { container } = await mount('flower-dance') // 当前曲是第 2 行
    const btn = container.querySelector<HTMLButtonElement>('.st-sw-btn')!
    await act(async () => {
      btn.click()
    })
    const items = itemsOf(container)
    expect(document.activeElement).toBe(items[1])
    press(items[1], 'ArrowDown') // 下一行 lumiere 禁用 → 焦点留在原地
    expect(document.activeElement).toBe(items[1])
    press(items[1], 'ArrowUp') // 回第 1 行
    expect(document.activeElement).toBe(items[0])
    press(items[0], 'Escape')
    expect(container.querySelector('.st-sw-panel')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })
})

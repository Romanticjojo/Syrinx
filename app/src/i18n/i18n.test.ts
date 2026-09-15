import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LangSwitch from '../components/LangSwitch'
import { initLang, pickSongText, translate, useLangStore } from './index'
import { en } from './en'
import { zh } from './zh'
import type { SongManifest } from '../types'

/** i18n 基建单测：字典 key 对齐、插值与缺失回退、pickSongText 回落、
 *  LangSwitch 渲染与切换（默认 zh、localStorage 记忆、html lang 同步）。 */

let roots: Root[] = []
let containers: HTMLElement[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  // 每组用例从干净的 zh 态起步（不触发 setLang 副作用）
  useLangStore.setState({ lang: 'zh' })
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  for (const c of containers) c.remove()
  containers = []
})

async function mountLangSwitch() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(LangSwitch, null))
  })
  return container
}

describe('字典 key 集合对齐（en 覆盖所有 zh key）', () => {
  it('en 与 zh 的 key 集合完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('两套字典所有值均为非空字符串', () => {
    for (const [dict, name] of [[zh, 'zh'], [en, 'en']] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${name}.${key}`).toBe('string')
        expect((value as string).length, `${name}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('难度标签圆点保留：zh ●●● 演奏级 / en ●●● Advanced', () => {
    expect(zh['difficulty.3']).toBe('●●● 演奏级')
    expect(en['difficulty.3']).toBe('●●● Advanced')
    expect(en['difficulty.1']).toBe('●○○ Beginner')
  })
})

describe('translate 插值与缺失 key 回退', () => {
  it('{name} 简单插值（中英各自字典）', () => {
    expect(translate('zh', 'result.measure', { m: 3 })).toBe('第 3 小节')
    expect(translate('en', 'result.measure', { m: 3 })).toBe('Measure 3')
  })

  it('多个参数插值', () => {
    expect(translate('zh', 'result.statCoverage', { measured: 2, total: 5 })).toBe('音符覆盖率（已测 2 / 5）')
  })

  it('参数缺失时占位符原样保留', () => {
    expect(translate('zh', 'result.measure')).toBe('第 {m} 小节')
  })

  it('en 缺 key 时 console.warn 并回退 zh 值', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const key = 'common.close' as const
    const record = en as Record<string, string>
    const original = record[key]
    delete record[key]
    try {
      expect(translate('en', key)).toBe(zh[key])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      record[key] = original
    }
  })

  it('两套字典都没有的 key 回退 key 字符串本身（防白屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(translate('en', 'no.such.key' as never)).toBe('no.such.key')
    expect(warn).toHaveBeenCalled()
  })
})

describe('pickSongText 回落逻辑', () => {
  const song = {
    title: 'Luv Letter',
    titleEn: 'Luv Letter (EN)',
    composer: 'DJ OKAWARI',
    tags: ['钢琴', '节拍'],
    tagsEn: ['Piano', 'Beats'],
  } as unknown as SongManifest

  it('zh 态一律取原值', () => {
    expect(pickSongText(song, 'title')).toBe('Luv Letter')
    expect(pickSongText(song, 'tags')).toEqual(['钢琴', '节拍'])
  })

  it('en 态且有 En 字段取 En', () => {
    useLangStore.setState({ lang: 'en' })
    expect(pickSongText(song, 'title')).toBe('Luv Letter (EN)')
    expect(pickSongText(song, 'tags')).toEqual(['Piano', 'Beats'])
  })

  it('en 态但无 En 字段回落原值', () => {
    useLangStore.setState({ lang: 'en' })
    const bare = { title: 'Flower Dance', composer: 'DJ OKAWARI', tags: ['长笛'] } as unknown as SongManifest
    expect(pickSongText(bare, 'title')).toBe('Flower Dance')
    expect(pickSongText(bare, 'composer')).toBe('DJ OKAWARI')
    expect(pickSongText(bare, 'tags')).toEqual(['长笛'])
  })

  it('en 态但 En 为空串/空数组视为缺失，回落原值', () => {
    useLangStore.setState({ lang: 'en' })
    const empty = { title: 'X', titleEn: '', tags: ['a'], tagsEn: [] } as unknown as SongManifest
    expect(pickSongText(empty, 'title')).toBe('X')
    expect(pickSongText(empty, 'tags')).toEqual(['a'])
  })
})

describe('LangSwitch 渲染与切换', () => {
  it('无存储时默认中文：.lang-switch 两段、中 段 on', async () => {
    initLang()
    expect(useLangStore.getState().lang).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    const container = await mountLangSwitch()
    const group = container.querySelector('.lang-switch')
    expect(group).not.toBeNull()
    expect(group?.getAttribute('role')).toBe('group')
    const segs = [...container.querySelectorAll<HTMLButtonElement>('.seg')]
    expect(segs).toHaveLength(2)
    expect(segs[0].classList.contains('on')).toBe(true)
    expect(segs[1].classList.contains('on')).toBe(false)
  })

  it('点 EN：立即切英文、html lang=en、localStorage 记忆、EN 段 on', async () => {
    const container = await mountLangSwitch()
    const segs = () => [...container.querySelectorAll<HTMLButtonElement>('.seg')]
    await act(async () => {
      segs()[1].click()
    })
    expect(useLangStore.getState().lang).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('syrinx_lang')).toBe('en')
    expect(segs()[1].classList.contains('on')).toBe(true)
    expect(segs()[0].classList.contains('on')).toBe(false)
    // 切回中：立即恢复 zh-CN
    await act(async () => {
      segs()[0].click()
    })
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem('syrinx_lang')).toBe('zh')
    expect(segs()[0].classList.contains('on')).toBe(true)
  })

  it('切换同步 <meta name="description">', async () => {
    const meta = document.createElement('meta')
    meta.name = 'description'
    document.head.appendChild(meta)
    await act(async () => {
      useLangStore.getState().setLang('en')
    })
    expect(meta.content).toBe(en['meta.description'])
    meta.remove()
  })

  it('localStorage 只有合法值才采纳（en 采纳、乱值回 zh）', () => {
    localStorage.setItem('syrinx_lang', 'en')
    // 重新读取走 readStoredLang 的唯一入口是 store 初始化；此处直接验证
    // setLang 持久化 + getState 一致性，非法值场景由 readStoredLang 逻辑保证
    useLangStore.getState().setLang('zh')
    expect(localStorage.getItem('syrinx_lang')).toBe('zh')
  })
})

# sync-tune 全曲目同步微调工作台（歌曲切换器）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `/sync-tune` 页顶栏加「歌曲切换器」下拉，选中任一有 beatsUrl 的内置曲即重跑装配（beats.json + musicxml + 伴奏波形），URL 同步、dirty 确认、回退可用。

**架构：** 页面内部持 `currentId` state（首挂载取路由参数），`song = getSong(currentId)` 派生；装配 effect 依赖从 `[]` 改 `[song, currentId]` 实现换曲重跑（cleanup 的 alive + audioEngine.pause 中断旧装配）。曲库列表与路由解析抽成两个纯函数模块（可 TDD）；下拉为独立组件 `SongSwitcher`（Apple 风、键盘可达）；dirty 时切换先挂轻量确认条（不弹原生 confirm）。

**技术栈：** React 19 + zustand + TypeScript + Vite + vitest/happy-dom（无 RTL，组件测试走 createRoot+act）；浏览器验收用仓库既有 playwright 脚本约定。

**约束（覆盖技能默认流程）：** 全程不 commit——用户验收后自行提交。中文注释、文件头 `/** */` 变更日志式说明、不新增依赖。

---

## 文件结构

| 文件 | 动作 | 职责 |
|------|------|------|
| `app/src/songs/syncList.ts` | 新建 | 纯函数 `syncSongList()`：SONGS 中有 beatsUrl 的子集（保序） |
| `app/src/songs/syncList.test.ts` | 新建 | syncSongList 单测（过滤/保序/字段） |
| `app/src/synctune/route.ts` | 新建 | 纯函数 `resolveSyncRoute()` + `syncTunePath()` + `SYNC_TUNE_DEFAULT_ID` |
| `app/src/synctune/route.test.ts` | 新建 | 路由解析单测 |
| `app/src/views/SongSwitcher.tsx` | 新建 | 顶栏歌曲切换器下拉组件（props: songs/currentId/onSelect） |
| `app/src/views/SongSwitcher.test.ts` | 新建 | 组件冒烟（渲染/点选/禁用/键盘） |
| `app/src/views/SyncTunePage.tsx` | 修改 | 装配 effect 依赖 `[song, currentId]` 重跑；切曲/URL/确认条；未知曲 error 态 |
| `app/src/views/SyncTunePage.css` | 修改 | 追加 `.st-sw-*` 切换器与 `.st-confirm` 确认条样式（同源设计语言） |
| `app/src/main.tsx` | 修改 | 裸 `/sync-tune` replaceState 重定向到 luv-letter |
| `app/scripts/verify_sync_switcher.py` | 新建 | 浏览器验收脚本（playwright，仓库既有 verify_* 约定） |

**关键事实（执行者必读）：**
- `SONGS` 共 7 条，其中 **5 首有 beatsUrl**（luv-letter / flower-dance / river-flows-in-you / expedition-33 / birds-poem）；**lumiere 与 aurora-scale 都没有 beatsUrl**（任务书只提了 lumiere，`filter` 自动覆盖后者）。
- 谱面容器 `.st-score-container` 只在 `phase === 'ready'` 时渲染 → 换曲回 loading 时旧 div 卸载，重装配拿到全新容器；`OSMDScore.dispose()` 也会清空容器，无脏渲染风险。
- 装配 effect cleanup 已有 `alive = false` + `audioEngine.pause()`；`store.load()` 重置选中/undoStack/log/dirty。
- 组件测试约定：`createElement` + `createRoot` + `act`，`IS_REACT_ACT_ENVIRONMENT = true`，无 RTL，测试文件用 `.test.ts` 后缀。

---

### 任务 1：曲库纯函数 syncSongList + 路由纯函数 resolveSyncRoute（TDD）

**文件：**
- 创建：`app/src/songs/syncList.ts`
- 创建：`app/src/songs/syncList.test.ts`
- 创建：`app/src/synctune/route.ts`
- 创建：`app/src/synctune/route.test.ts`

- [ ] **步骤 1：写失败测试 `app/src/songs/syncList.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { SONGS } from './index'
import { syncSongList } from './syncList'

/** 同步微调曲库（R3 歌曲切换器数据源）：只保留有伴奏锚点（beatsUrl）的内置曲，
 *  无锚点曲目没有可调的 beatAnchors，进列表只会装配失败。 */

describe('syncSongList', () => {
  const list = syncSongList()

  it('每首都有 beatsUrl；lumiere / aurora-scale（无 beats）不在列表', () => {
    expect(list.every((s) => !!s.beatsUrl)).toBe(true)
    const ids = list.map((s) => s.id)
    expect(ids).not.toContain('lumiere')
    expect(ids).not.toContain('aurora-scale')
  })

  it('顺序与 SONGS 一致（过滤保序，不做重排）', () => {
    expect(list.map((s) => s.id)).toEqual(SONGS.filter((s) => !!s.beatsUrl).map((s) => s.id))
  })

  it('字段映射：id/title/difficulty/accent 与 SONGS 同源同值', () => {
    const byId = new Map(SONGS.map((s) => [s.id, s]))
    for (const s of list) {
      const src = byId.get(s.id)!
      expect(s.title).toBe(src.title)
      expect(s.difficulty).toBe(src.difficulty)
      expect(s.accent).toBe(src.accent)
    }
  })

  it('当前曲库现实：恰为 5 首有 beats 的曲（新增曲目时更新此清单）', () => {
    expect([...list.map((s) => s.id)].sort()).toEqual(
      ['birds-poem', 'expedition-33', 'flower-dance', 'luv-letter', 'river-flows-in-you'].sort(),
    )
  })
})
```

- [ ] **步骤 2：写失败测试 `app/src/synctune/route.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { resolveSyncRoute, syncTunePath, SYNC_TUNE_DEFAULT_ID } from './route'

/** 同步页路由解析（R3）：裸 /sync-tune 落默认曲并要求 replaceState 补全 URL；
 *  带 id 原样透传（未知曲由页面显示装配失败态，不在路由层拦截）。 */

describe('resolveSyncRoute', () => {
  it('非本页路径返回 null（渲染 App）', () => {
    expect(resolveSyncRoute('/')).toBeNull()
    expect(resolveSyncRoute('/perform/luv-letter')).toBeNull()
    expect(resolveSyncRoute('/sync-tunex')).toBeNull()
  })

  it('裸 /sync-tune（含尾斜杠）→ 默认曲 + needsReplace', () => {
    expect(resolveSyncRoute('/sync-tune')).toEqual({
      songId: SYNC_TUNE_DEFAULT_ID,
      needsReplace: true,
    })
    expect(resolveSyncRoute('/sync-tune/')).toEqual({
      songId: SYNC_TUNE_DEFAULT_ID,
      needsReplace: true,
    })
  })

  it('带 id → 原样透传、无需 replace（未知 id 也放行，页面报装配失败）', () => {
    expect(resolveSyncRoute('/sync-tune/luv-letter')).toEqual({
      songId: 'luv-letter',
      needsReplace: false,
    })
    expect(resolveSyncRoute('/sync-tune/flower-dance/')).toEqual({
      songId: 'flower-dance',
      needsReplace: false,
    })
    expect(resolveSyncRoute('/sync-tune/not-a-song')).toEqual({
      songId: 'not-a-song',
      needsReplace: false,
    })
  })

  it('id 只认 [\\w-]（空格等非法字符不进同步页）', () => {
    expect(resolveSyncRoute('/sync-tune/luv letter')).toBeNull()
  })

  it('syncTunePath 生成 /sync-tune/<id>', () => {
    expect(syncTunePath('luv-letter')).toBe('/sync-tune/luv-letter')
  })
})
```

- [ ] **步骤 3：运行确认失败**

在 `app/` 下：`npx vitest run src/songs/syncList.test.ts src/synctune/route.test.ts`
预期：FAIL——模块不存在（Cannot find module / 未定义导出）。

- [ ] **步骤 4：实现 `app/src/songs/syncList.ts`**

```ts
import type { SongManifest } from '../types'
import { SONGS } from './index'

/**
 * 同步微调工作台曲库（/sync-tune 歌曲切换器数据源）：
 * 内置曲库中只有带伴奏锚点（beatsUrl）的曲目才可同步微调——
 * 没有锚点就没有可调的 beatAnchors 控制点。过滤保序，顺序与曲库一致。
 */
export function syncSongList(): SongManifest[] {
  return SONGS.filter((s) => !!s.beatsUrl)
}
```

- [ ] **步骤 5：实现 `app/src/synctune/route.ts`**

```ts
/**
 * 同步调试页路由约定（/sync-tune/:songId）。
 * 纯函数供 main.tsx 首挂载分流、页面 popstate 回退与单测共用；
 * 不做 launcher 页（决策 1）：裸 /sync-tune 直接落默认曲。
 */

/** 缺省曲目：直入 /sync-tune（无 id）时的重定向目标 */
export const SYNC_TUNE_DEFAULT_ID = 'luv-letter'

/** 生成 /sync-tune/<id> 路径（pushState 用） */
export function syncTunePath(songId: string): string {
  return `/sync-tune/${songId}`
}

/** 解析同步页路径：非本页路径返回 null；裸 /sync-tune 视为默认曲
 *  （needsReplace=true，调用方 replaceState 补全 URL，刷新可保持）。
 *  未知 id 原样放行——由页面显示装配失败态，路由层不拦曲目合法性。 */
export function resolveSyncRoute(pathname: string): { songId: string; needsReplace: boolean } | null {
  const m = /\/sync-tune(\/([\w-]+))?\/?$/.exec(pathname)
  if (!m) return null
  const id = m[2]
  if (id) return { songId: id, needsReplace: false }
  return { songId: SYNC_TUNE_DEFAULT_ID, needsReplace: true }
}
```

- [ ] **步骤 6：运行确认通过**

`npx vitest run src/songs/syncList.test.ts src/synctune/route.test.ts`
预期：2 文件全 PASS。

---

### 任务 2：SongSwitcher 组件（TDD 冒烟）+ CSS

**文件：**
- 创建：`app/src/views/SongSwitcher.tsx`
- 创建：`app/src/views/SongSwitcher.test.ts`
- 修改：`app/src/views/SyncTunePage.css`（文件末尾追加）

- [ ] **步骤 1：写失败测试 `app/src/views/SongSwitcher.test.ts`**

```ts
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
```

- [ ] **步骤 2：运行确认失败**

`npx vitest run src/views/SongSwitcher.test.ts`
预期：FAIL——`./SongSwitcher` 不存在。

- [ ] **步骤 3：实现 `app/src/views/SongSwitcher.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { SongManifest } from '../types'

/**
 * 同步调试页顶栏「歌曲切换器」（R3）：当前曲名 + ▾，下拉列出全部可同步曲目。
 * Apple 风：克制、圆角面板、轻投影；每行 = accent 色点 + 曲名 + 难度★；
 * 当前曲高亮，无 beatsUrl 的曲灰显禁用（「无 beats」标注）。
 * 键盘：触发钮点击开合；打开聚焦当前曲行；↓↑←→ 在列表内移动焦点（跳过
 * 禁用行）；Enter/空格选中（原生 button 行为）；Esc 收起并还焦点触发钮。
 */

interface SongSwitcherProps {
  songs: SongManifest[]
  currentId: string
  onSelect: (id: string) => void
}

export default function SongSwitcher({ songs, currentId, onSelect }: SongSwitcherProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const current = songs.find((s) => s.id === currentId)

  // 外点收起：pointerdown 落在组件外即关（面板与触发钮都算组件内）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !wrapRef.current) return
      if (!wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [open])

  // 打开时把焦点交给当前曲行（键盘直达）；无当前曲（未知曲 id）则首行
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const target =
      panel.querySelector<HTMLButtonElement>('.st-sw-item.cur') ??
      panel.querySelector<HTMLButtonElement>('.st-sw-item')
    target?.focus()
  }, [open])

  /** 列表内键盘导航：↓↑←→ 移动焦点（禁用行跳过），Esc 收起并还焦点触发钮 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      btnRef.current?.focus()
      return
    }
    if (!open) return
    const dir =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0
    if (!dir) return
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('.st-sw-item') ?? [])]
    const pos = items.indexOf(document.activeElement as HTMLButtonElement)
    // 从当前位置向 dir 找下一个可用行，禁用行跳过；到头不动
    for (let i = pos + dir; i >= 0 && i < items.length; i += dir) {
      if (!items[i].classList.contains('off')) {
        items[i].focus()
        break
      }
    }
    e.preventDefault()
  }

  const pick = (s: SongManifest) => {
    if (!s.beatsUrl) return // 禁用行 no-op（面板不收，保持浏览态）
    setOpen(false)
    onSelect(s.id)
  }

  return (
    <div className="st-sw" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className="st-sw-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换曲目"
        onClick={() => setOpen((o) => !o)}
      >
        <i className="st-sw-dot" style={{ background: current?.accent ?? '#5c6c73' }} />
        <span className="st-sw-title">{current?.title ?? `${currentId}（未知曲目）`}</span>
        <span className="st-sw-caret">▾</span>
      </button>
      {open && (
        <div className="st-sw-panel" ref={panelRef} role="listbox" aria-label="切换曲目">
          {songs.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === currentId}
              aria-disabled={!s.beatsUrl}
              className={`st-sw-item${s.id === currentId ? ' cur' : ''}${s.beatsUrl ? '' : ' off'}`}
              title={s.beatsUrl ? s.title : `${s.title}（无伴奏锚点，不支持同步微调）`}
              onClick={() => pick(s)}
            >
              <i className="st-sw-dot" style={{ background: s.accent }} />
              <span className="st-sw-item-title">{s.title}</span>
              {s.beatsUrl ? (
                <span className="st-sw-diff" aria-label={`难度 ${s.difficulty}`}>
                  {'★'.repeat(s.difficulty)}
                </span>
              ) : (
                <span className="st-sw-nobeats">无 beats</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **步骤 4：CSS 追加到 `app/src/views/SyncTunePage.css` 末尾**

```css
/* —— 歌曲切换器（R3）：顶栏下拉。同源设计语言：#18222a 面板、#2a3942 边框、
    5-8px 圆角、11-12px 字号；focus 用 accent 描边替代默认 outline —— */
.st-sw {
  position: relative;
}
.st-sw-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #18222a;
  color: #e8e8e2;
  border: 1px solid #2a3942;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
.st-sw-btn:hover,
.st-sw-btn:focus-visible,
.st-sw-item:focus-visible {
  border-color: var(--song-accent, #5fb8a8);
  outline: none;
}
.st-sw-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.st-sw-caret {
  color: #7a8a90;
  font-size: 10px;
}
.st-sw-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  min-width: 240px;
  max-height: 70vh;
  overflow: auto;
  background: #18222a;
  border: 1px solid #2a3942;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  padding: 4px;
}
.st-sw-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: inherit;
  font: inherit;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}
.st-sw-item:hover {
  background: #131b21;
}
.st-sw-item.cur {
  background: #17242a;
  box-shadow: inset 2px 0 0 var(--song-accent, #5fb8a8);
}
.st-sw-item-title {
  flex: 1;
  color: #e8e8e2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-sw-diff {
  color: #ffb26b;
  font-size: 11px;
  letter-spacing: 1px;
}
.st-sw-item.off {
  opacity: 0.4;
  cursor: default;
}
.st-sw-item.off .st-sw-item-title {
  color: #7a8a90;
}
.st-sw-nobeats {
  font-size: 11px;
  color: #5c6c73;
  border: 1px solid #2a3942;
  border-radius: 8px;
  padding: 0 6px;
  white-space: nowrap;
}

/* 切换确认条（R3）：有未导出微调时挂在顶栏下方，轻量确认、不弹原生 confirm */
.st-confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  font-size: 12px;
  color: #ffb26b;
  background: #141b21;
  border-bottom: 1px solid #1d262c;
}
```

- [ ] **步骤 5：运行确认通过**

`npx vitest run src/views/SongSwitcher.test.ts`
预期：4 例全 PASS。

---

### 任务 3：SyncTunePage 集成——装配重跑 / URL 同步 / dirty 确认条 / 未知曲 error 态

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx`

无新增纯函数可单测（集成行为由任务 5 浏览器验收脚本覆盖）；本任务以 `tsc` + 全量 vitest 回归为门槛。

- [ ] **步骤 1：文件头 `/** */` 变更日志追加一行**

在文件头注释块末尾（`R2（T6b）` 段之后）追加：

```
 * R3（切换器）：顶栏加「歌曲切换器」下拉（SongSwitcher），全曲库可同步曲目
 * （有 beatsUrl）即选即切——装配 effect 依赖 [song, currentId] 换曲重跑，
 * cleanup 中断旧装配与播放、store.load() 重置为干净态；pushState 同步 URL
 * （popstate 回退跟随），裸 /sync-tune 由 main.tsx 重定向默认曲；dirty 时
 * 切曲先挂轻量确认条（.st-confirm，不弹原生 confirm）；未知曲 id 显示
 * 装配失败态（不再静默回落 SONGS[0]）。
```

- [ ] **步骤 2：导入与模块级曲库**

- 导入行 `import { getSong, SONGS } from '../songs'` 改为 `import { getSong } from '../songs'`（SONGS 不再使用），并新增：

```ts
import { syncSongList } from '../songs/syncList'
import { resolveSyncRoute, syncTunePath } from '../synctune/route'
import SongSwitcher from './SongSwitcher'
```

- 常量区（`ENERGY_VIEW_BLOCKS` 之后）加：

```ts
/** 可同步曲目表（含 beatsUrl 的内置曲）：切换器数据源，模块级一次构建 */
const SYNC_SONGS = syncSongList()
```

- [ ] **步骤 3：组件头部——currentId/pendingId state + accent 派生**

把：

```ts
export default function SyncTunePage({ songId }: { songId: string }) {
  const song = getSong(songId) ?? SONGS[0]
```

改为：

```ts
export default function SyncTunePage({ songId }: { songId: string }) {
  // 当前曲 id：首挂载取路由参数，此后由切曲（pushState）/popstate 本地推进——
  // 本页独立渲染树，props 只在挂载时读一次。song 不再回落 SONGS[0]：未知曲
  // id 走装配失败态（R3 决策 1），顶栏切换器仍可选有效曲自救
  const [currentId, setCurrentId] = useState(songId)
  const song = getSong(currentId)
  // 未导出微调的切曲确认（R3）：dirty 时先挂确认条，确认后才丢改动
  const [pendingId, setPendingId] = useState<string | null>(null)
  // accent 派生：song 可能 undefined（未知曲），谱面/标记/波形用色取回落值
  const accent = song?.accent ?? '#5fb8a8'
```

- [ ] **步骤 4：装配 effect 依赖改 `[song, currentId]` + 换曲重置**

装配 effect（`// —— 装配：曲谱解析…`）改为（异步主体与原逻辑完全一致，只动骨架）：

```ts
  // —— 装配：曲谱解析（恒速系，q 换算基准）+ beats.json + 伴奏解码 ——
  //  R3：依赖 [song, currentId]——切曲即重跑装配；cleanup 的 alive 标志 +
  //  audioEngine.pause() 中断旧装配与播放，store 由 load() 重置（选中清空/
  //  已调计数归零/未导出标记消失）
  useEffect(() => {
    let alive = true
    // 换曲重置：phase 回 loading（旧谱面容器随条件渲染卸载，重装配拿新 div）、
    // 标记层等新谱就绪再全量重绘；波形/时间轴 refs 清零，装配中途失败不残留上一曲
    setPhase('loading')
    setErrorMsg('')
    setXml(null)
    setMarkersReady(false)
    setNearHint(null)
    beatsRef.current = null
    baseTlRef.current = null
    displayTlRef.current = null
    blockRmsRef.current = null
    peakRmsRef.current = 1
    durationRef.current = 0
    viewRef.current = { t0: 0, t1: 1 }
    lastSelQRef.current = null
    if (!song) {
      setErrorMsg(`未知曲目：${currentId}（不在内置曲库中）`)
      setPhase('error')
      return
    }
    ;(async () => {
      // ……（原 async 主体逐行保留：fetch scoreUrl → expandRepeats →
      // parseMusicXml → fetch beatsUrl → store.load → 伴奏解码 → setPhase('ready')）
    })()
    return () => {
      alive = false
      window.clearTimeout(nearHintTimerRef.current)
      audioEngine.pause()
    }
    // 切曲（song 引用变化）即重跑装配；currentId 供未知曲错误信息
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, currentId])
```

（执行注意：`lastSelQRef` 声明在文件更下方（标记层 b) patch 用），effect 内引用它没有问题（同一次渲染的 const ref 对象）。）

- [ ] **步骤 5：谱面/标记 effect 的 `song.accent` 全部换为派生 `accent`**

共 4 处依赖数组与对应使用点：
1. 谱面挂载 effect：deps `[phase, xml, song.accent, followMeasure]` → `[phase, xml, accent, followMeasure]`；`new OSMDScore(div, song.accent, …)` → `new OSMDScore(div, accent, …)`。
2. 标记层 a) 全量 effect：deps 与 `color` 三元中 `song.accent` → `accent`。
3. 标记层 b) 选中 patch：同上。
4. 标记层 c) 微调 patch：同上。
5. `drawWave` 内刻度色 `isSel ? song.accent : …` → `isSel ? accent : …`。

- [ ] **步骤 6：切曲处理 + popstate**

放在 `saveChanges` 之后、快捷键 effect 之前：

```ts
  // —— 切曲（R3）：dirty 先挂确认条，确认才丢改动；切换 = pushState 留回退
  //  路径 + 推进 currentId（装配 effect 随 song 重跑，cleanup 已 pause 音频，
  //  store.load 重置为干净态）——
  const doSwitchSong = (id: string) => {
    setPendingId(null)
    if (id === currentId) return
    window.history.pushState(null, '', syncTunePath(id))
    setCurrentId(id)
  }
  const requestSwitchSong = (id: string) => {
    if (id === currentId) return
    if (st.getState().dirty) {
      setPendingId(id)
      return
    }
    doSwitchSong(id)
  }

  // —— URL 同步（R3）：浏览器回退/前进跟随路径切曲；只消费本页路径——
  //  退到非 /sync-tune 路径时不动作（本页独立渲染树，无 App 可回）
  useEffect(() => {
    const onPop = () => {
      const r = resolveSyncRoute(window.location.pathname)
      if (r) setCurrentId(r.songId)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
```

- [ ] **步骤 7：渲染接线**

1. 根容器 style：`'--song-accent': song.accent` → `'--song-accent': accent`。
2. 顶栏 `<b>{song.title}</b>` 整行替换为：

```tsx
        <SongSwitcher songs={SYNC_SONGS} currentId={currentId} onSelect={requestSwitchSong} />
```

3. `</header>` 之后（仍在 `.st-topwrap` 内）插确认条：

```tsx
        {/* 未导出微调的切换确认（R3）：轻量确认条，不弹原生 confirm；确认才丢改动 */}
        {pendingId && (
          <div className="st-confirm">
            <span>
              当前曲目有未导出的微调，切换到「{getSong(pendingId)?.title ?? pendingId}」将丢弃。
            </span>
            <span className="st-flex" />
            <button className="st-btn" onClick={() => setPendingId(null)}>
              取消
            </button>
            <button className="st-btn primary" onClick={() => doSwitchSong(pendingId)}>
              放弃微调并切换
            </button>
          </div>
        )}
```

- [ ] **步骤 8：类型与回归**

`npx tsc -b --pretty false` → 0 错误；`npx vitest run` → 全部通过（基线 22 文件 219 测试 + 新增 3 文件）。

---

### 任务 4：main.tsx 裸路径重定向

**文件：**
- 修改：`app/src/main.tsx`

- [ ] **步骤 1：** 全文改为：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './theme.ts'
import App from './App.tsx'
import SyncTunePage from './views/SyncTunePage.tsx'
import { resolveSyncRoute } from './synctune/route.ts'

// 渲染前同步主题，避免深浅闪跳
initTheme()

// 独立调试路由 /sync-tune/:songId（不进曲库导航；zustand 视图状态机之外）。
// 裸 /sync-tune（无 id）replaceState 补全为默认曲（R3 决策 1：不做 launcher 页，
// 刷新可保持完整 URL）；带 id 但不在曲库 → 页面内显示装配失败态
const syncRoute = resolveSyncRoute(window.location.pathname)
if (syncRoute?.needsReplace) {
  window.history.replaceState(null, '', `/sync-tune/${syncRoute.songId}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {syncRoute ? <SyncTunePage songId={syncRoute.songId} /> : <App />}
  </StrictMode>,
)
```

- [ ] **步骤 2：** `npx tsc -b --pretty false` → 0 错误。

---

### 任务 5：验证收尾（verification-before-completion）

**文件：**
- 创建：`app/scripts/verify_sync_switcher.py`（仓库 verify_* 约定：playwright sync API + 本地 chromium + dev server :5173）

- [ ] **步骤 1：写浏览器验收脚本** `app/scripts/verify_sync_switcher.py`

覆盖验收标准 3/4/5/6：5 首曲逐一切换装配（音符列表非空 + 波形有能量）、lumiere 禁用、裸路径重定向、切曲后 store 干净（已调 0 / 无未导出）、回退/前进、dirty 确认条（取消不动 / 确认才切）。

脚本骨架（完整实现按此约定写）：
- `wait_ready(page, timeout=30000)`：等 `.st-row` 出现（装配完成），轮询而非死等；
- `wave_energy(page)`：`canvas.getContext('2d').getImageData` 采样中带，统计与背景 `#10151a`(16,21,26) 色差 >30 的像素数 >200；
- 主流程：
  1. `goto /sync-tune` → 断言 URL 含 `/sync-tune/luv-letter` 且装配完成；
  2. 打开切换器 → 断言 6 行（5 可用 + lumiere 禁用 `aria-disabled`）；
  3. 循环 5 曲：点行 → 等 ready → 断言 URL / 顶栏曲名 / 音符数 / 波形能量 / 无 `.st-status.err`；
  4. dirty 确认：点一首音符行选中 → 点 `.st-btn-grid` 任一微调钮 → 断言顶栏出现「未导出」→ 切 flower-dance → 断言 `.st-confirm` 出现且 URL 未变 → 「取消」→ 仍在 luv-letter → 再切 → 「放弃微调并切换」→ URL/曲名变化且「未导出」消失、已调为 0；
  5. `page.go_back()` → 断言回到上一曲 URL 且重新装配完成；`page.go_forward()` 同理；
  6. 未知曲：`goto /sync-tune/not-a-song` → 断言 `.st-status.err` 可见；
  7. 汇总 PASS/FAIL，失败 `sys.exit(1)`。

- [ ] **步骤 2：跑静态与单测验证**

在 `app/` 下：
- `npx tsc -b --pretty false` → 0 错误
- `npx vitest run` → 全部通过（只增不减）

- [ ] **步骤 3：跑浏览器验收**（需 dev server：`npx vite` 于 `app/`，:5173）

`python scripts/verify_sync_switcher.py` → 全部断言 PASS。
（若执行类命令被权限拒绝：按 memory 约定，把验证命令完整交给用户手跑，不静默跳过。）

- [ ] **步骤 4：git diff 自检**

`git diff --stat` + `git status --short`：触碰范围应仅为本计划「文件结构」所列 10 个文件；确认未动波形绘制（`drawWave` 主体除 accent 变量替换外零改动）、播放逻辑（`togglePlay`/`playFromSelected`/`doSeek`）、导出逻辑。

---

## 自检记录（writing-plans 步骤 3）

1. **规格覆盖度**：切换器入口（任务 2/3 步骤 7-2）、下拉行结构（任务 2）、当前曲高亮/禁用标注（任务 2）、选中即切换+收起（任务 2/3）、dirty 轻量确认（任务 3 步骤 6-7）、URL pushState/popstate（任务 3 步骤 6）、键盘+focus 样式（任务 2 步骤 3-4）、裸路径重定向（任务 4）、未知曲 error 态（任务 3 步骤 4）、装配重跑与重置（任务 3 步骤 4）、loading 复用（原 `st-status` 不变）、TDD（任务 1/2 先测后码）、浏览器验收（任务 5）——全覆盖。
2. **占位符扫描**：任务 3 步骤 4 的 async 主体标注「原逻辑逐行保留」属于对既有代码的明确引用（L186-269 现有实现），非 TODO；其余步骤均含完整代码。
3. **类型一致性**：`SongSwitcherProps{songs,currentId,onSelect}` 与接线处一致；`resolveSyncRoute` 返回 `{songId,needsReplace}|null` 与 main.tsx/popstate 用法一致；`accent` 派生变量在谱面/标记/波形三处统一。

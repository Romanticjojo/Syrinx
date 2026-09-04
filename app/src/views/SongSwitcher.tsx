import { useEffect, useRef, useState } from 'react'
import type { SongManifest } from '../types'
import { syncSongList } from '../songs/syncList'

/**
 * 同步调试页顶栏「歌曲切换器」（R3）：当前曲名 + ▾，下拉列出全曲库曲目。
 * Apple 风：克制、圆角面板、轻投影；每行 = accent 色点 + 曲名 + 难度★；
 * 当前曲高亮，无 beatsUrl 的曲灰显禁用（「无 beats」标注，在列但不可选）。
 * 可同步集合以 syncSongList()（有 beatsUrl 的曲）为准——禁用判定集中在
 * 一处，曲库将来换支持语义（如 manifest 字段）只改 syncList。
 * 键盘：触发钮点击开合；打开聚焦当前曲行；↓↑←→ 在列表内移动焦点（跳过
 * 禁用行）；Enter/空格选中（原生 button 行为）；Esc 收起并还焦点触发钮。
 */

/** 可同步曲目 id 集（静态曲库，模块级一次构建） */
const SUPPORTED_IDS = new Set(syncSongList().map((s) => s.id))

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
    if (!SUPPORTED_IDS.has(s.id)) return // 禁用行 no-op（面板不收，保持浏览态）
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
          {songs.map((s) => {
            const enabled = SUPPORTED_IDS.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === currentId}
                aria-disabled={!enabled}
                className={`st-sw-item${s.id === currentId ? ' cur' : ''}${enabled ? '' : ' off'}`}
                title={enabled ? s.title : `${s.title}（无伴奏锚点，不支持同步微调）`}
                onClick={() => pick(s)}
              >
                <i className="st-sw-dot" style={{ background: s.accent }} />
                <span className="st-sw-item-title">{s.title}</span>
                {enabled ? (
                  <span className="st-sw-diff" aria-label={`难度 ${s.difficulty}`}>
                    {'★'.repeat(s.difficulty)}
                  </span>
                ) : (
                  <span className="st-sw-nobeats">无 beats</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

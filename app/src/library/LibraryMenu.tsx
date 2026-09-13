import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'

export interface LibraryMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  selected?: boolean
  danger?: boolean
  divider?: boolean
}

/** A small action menu; mounted only while needed, with viewport-safe placement. */
export default function LibraryMenu({ label, children, items, disabled = false }: {
  label: string; children?: ReactNode; items: LibraryMenuItem[]; disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const close = (restoreFocus = false) => {
    if (restoreFocus) trigger.current?.focus()
    setPosition(null)
  }
  useEffect(() => {
    if (!position) return
    const buttons = () => [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    buttons()[0]?.focus()
    const dismiss = () => {
      if (menu.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
      setPosition(null)
    }
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) dismiss()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'Tab') { close(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const all = buttons(), current = all.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
      all[index]?.focus()
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) dismiss() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [position])
  const open = () => {
    if (position) { close(true); return }
    const rect = trigger.current!.getBoundingClientRect()
    const height = Math.min(items.length * 45 + 16, window.innerHeight - 24)
    const below = window.innerHeight - rect.bottom - 12
    const top = below >= height || rect.top < height ? Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - height - 12)) : rect.top - height - 6
    setPosition({ left: Math.max(12, Math.min(rect.right - 224, window.innerWidth - 236)), top, maxHeight: window.innerHeight - top - 12 })
  }
  return <>
    <button ref={trigger} className="library-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined} disabled={disabled} onClick={open} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); open() } }}>
      {children ?? <Icon name="more" />}
    </button>
    {position && createPortal(<div id={id} ref={menu} className="library-action-menu" role="menu" aria-label={label} style={position}>
      {items.map((item) => <button key={item.label} role={item.selected === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.selected} disabled={item.disabled} className={`${item.danger ? 'is-danger' : ''}${item.divider ? ' has-divider' : ''}`} onClick={() => { close(true); item.onSelect() }}>
        <span>{item.label}</span>{item.selected && <Icon name="check" size={16} />}
      </button>)}
    </div>, document.body)}
  </>
}

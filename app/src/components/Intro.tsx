import { useEffect, useRef, useState } from 'react'
import './Intro.css'

const SKIP_KEY = 'syrinx_skip_intro'

interface Props {
  onDone: () => void
}

/**
 * 入场动画覆盖层：极简品牌位 —— 女神吹笛图形（logo 暗色版）+ 字标 + 跳过。
 * 「下次不再播放」写 localStorage，App 启动时读取直接跳过。
 */
export default function Intro({ onDone }: Props) {
  const [leaving, setLeaving] = useState(false)
  const [noShow, setNoShow] = useState(() => localStorage.getItem(SKIP_KEY) === '1')
  const doneRef = useRef(false)

  const close = () => {
    if (doneRef.current) return
    doneRef.current = true
    if (noShow) localStorage.setItem(SKIP_KEY, '1')
    else localStorage.removeItem(SKIP_KEY)
    setLeaving(true)
    // 淡出后再卸载（reduced-motion 时全局规则会将过渡时长压到近 0，等效立即）
    window.setTimeout(onDone, 650)
  }

  // 首次任意按键/点击也能跳过
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noShow])

  return (
    <div className={`intro${leaving ? ' leaving' : ''}`} role="dialog" aria-label="Syrinx 入场">
      <div className="intro-beam" aria-hidden="true" />
      <div className="intro-center">
        <img className="intro-emblem" src="/brand/syrinx-logo-dark.jpg" alt="" aria-hidden="true" />
        <h1 className="intro-brand">
          Syrinx<span className="dot">·</span>长笛流光
        </h1>
      </div>
      <div className="intro-actions">
        <label className="intro-noshow">
          <input
            type="checkbox"
            checked={noShow}
            onChange={(e) => setNoShow(e.target.checked)}
          />
          下次不再播放
        </label>
        <button className="intro-enter" onClick={close}>
          进入应用 ›
        </button>
      </div>
      <div className="intro-hint">Enter / Esc 跳过</div>
    </div>
  )
}

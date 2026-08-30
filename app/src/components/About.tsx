import { useEffect } from 'react'
import './About.css'

interface Props {
  onClose: () => void
}

/** 关于页：品牌位（logo 女神吹笛图形 + 字标 + 版本与简介），细线卡片、大留白 */
export default function About({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="about" role="dialog" aria-label="关于 Syrinx" onClick={onClose}>
      <div className="about-card" onClick={(e) => e.stopPropagation()}>
        <img className="about-emblem" src="/brand/syrinx-logo-dark.jpg" alt="" aria-hidden="true" />
        <h2 className="about-brand">
          Syrinx<span>·</span>长笛流光
        </h2>
        <p className="about-line">长笛演奏辅助 —— 曲谱跟随 · 伴奏同步 · 录音回放 · 音高反馈</p>
        <p className="about-sub">
          长笛女神 Syrinx 化身芦笛之名。曲谱与伴奏素材由用户自备自用，应用不分发。
        </p>
        <div className="about-foot">
          <span className="about-ver">v0.1.0</span>
          <button className="about-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

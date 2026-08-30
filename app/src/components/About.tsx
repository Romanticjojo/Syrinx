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
        <img className="about-emblem" src="/brand/syrinx-logo-white.jpg" alt="" aria-hidden="true" />
        <h2 className="about-brand">Syrinx</h2>
        <p className="about-line">曲谱跟随 · 伴奏同步 · 录音回放 · 音高反馈</p>
        <p className="about-sub">
          神话中，仙女绪任克斯为摆脱牧神潘的追逐，化为河边一丛芦苇。潘将芦苇制成长短相续的排箫，
          以她的名字为之命名——Syrinx。风过苇孔，如她的呼吸。1913 年，德彪西以一支现代长笛写下独奏曲
          《Syrinx》，追忆这段山林旧梦，也让这个名字与长笛从此相连。
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

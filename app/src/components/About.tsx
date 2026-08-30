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
          神话里，仙女绪任克斯为了摆脱牧神潘的追逐，化作河边的一丛芦苇。潘循着风声寻来，只见苇影
          摇曳，风穿过苇孔，呜咽如歌。他将芦苇截成长短不一的几截，以蜡相联，做成一支排箫，用仙女
          的名字为它命名，叫做 Syrinx。从此每一个音，都是她的呼吸。
        </p>
        <p className="about-sub">
          1913 年，德彪西以一支现代长笛写下独奏曲《Syrinx》，用缥缈而忧伤的音色追忆这段山林旧梦。
          也是从这首曲子开始，Syrinx 这个名字与现代长笛紧紧连在了一起。
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

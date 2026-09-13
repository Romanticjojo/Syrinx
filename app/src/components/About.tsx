import { useEffect } from 'react'
import './About.css'
import { assetUrl } from '../lib/assetUrl'

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
        <img className="about-emblem" src={assetUrl("/brand/syrinx-logo-white.jpg")} alt="" aria-hidden="true" />
        <h2 className="about-brand">Syrinx</h2>
        <p className="about-line">曲谱跟随 · 伴奏同步</p>
        <p className="about-sub">为逃离牧神潘炽热的追逐，水泽仙女绪任克斯纵身河畔，化作一丛芦苇。当潘循迹而至，眼前已不见佳人，唯有苇叶在风中轻轻摇曳。清风穿入苇管，呜咽声声，如泣如诉。满心怅惘的潘剪下芦苇，截成长短错落的苇管，以蜡密合，制成排箫。他以仙女之名，将这件乐器唤作 Syrinx。自此，排箫流淌出的每一个音符，皆是绪任克斯未曾消散的呼吸。</p><p className="about-sub">1913 年，德彪西为现代长笛写下无伴奏独奏曲《Syrinx》。缥缈幽婉、带着淡淡忧伤的笛声，回望这段悠远凄美的山林传说。也正是这部作品，让 Syrinx 这个古老的神话名字与现代长笛紧密相联。</p>
        <div className="about-foot">
          <span className="about-ver">v0.3.0</span>
          <button className="about-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

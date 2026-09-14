import { useEffect } from 'react'
import './About.css'
import { assetUrl } from '../lib/assetUrl'
import { useT } from '../i18n'

interface Props {
  onClose: () => void
}

/** 关于页：品牌位（logo 女神吹笛图形 + 字标 + 版本与简介），细线卡片、大留白 */
export default function About({ onClose }: Props) {
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="about" role="dialog" aria-label={t('about.dialogLabel')} onClick={onClose}>
      <div className="about-card" onClick={(e) => e.stopPropagation()}>
        <img className="about-emblem" src={assetUrl("/brand/syrinx-logo-white.jpg")} alt="" aria-hidden="true" />
        <h2 className="about-brand">Syrinx</h2>
        <p className="about-line">{t('about.tagline')}</p>
        <p className="about-sub">{t('about.story1')}</p><p className="about-sub">{t('about.story2')}</p>
        <div className="about-foot">
          <span className="about-ver">v0.3.0</span>
          <button className="about-close" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

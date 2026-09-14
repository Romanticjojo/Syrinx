import { useLangStore, useT, type Lang } from '../i18n'
import './LangSwitch.css'

/**
 * 中/EN 分段切换控件。视觉复刻预览页 .score-switch（PreviewPage.css）的
 * 分段控件语言：半透明胶囊容器 + blur + 12px 文字段，选中段亮 accent——
 * 但样式独立成 LangSwitch.css，不改动 .score-switch 本身。
 * 摆放：曲库顶栏 + 预览页顶栏；演奏/回放页不放（练习场景不打扰）。
 */
export default function LangSwitch() {
  const t = useT()
  const lang = useLangStore((s) => s.lang)
  const setLang = useLangStore((s) => s.setLang)

  const seg = (value: Lang, key: 'langSwitch.zh' | 'langSwitch.en') => (
    <button
      type="button"
      className={`seg${lang === value ? ' on' : ''}`}
      aria-pressed={lang === value}
      lang={value === 'zh' ? 'zh-CN' : 'en'}
      onClick={() => setLang(value)}
    >
      {t(key)}
    </button>
  )

  return (
    <div className="lang-switch" role="group" aria-label={t('langSwitch.label')}>
      {seg('zh', 'langSwitch.zh')}
      {seg('en', 'langSwitch.en')}
    </div>
  )
}

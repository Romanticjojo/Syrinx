import { useState } from 'react'
import './FluteView.css'

interface Props {
  accent?: string
  /** 长笛图地址；默认 public/brand 下的实拍图 */
  url?: string
  className?: string
}

/**
 * 真实长笛展示组件（PreviewPage hero 共用）。
 * 实拍图加载失败时回退 CSS 长笛条（金属渐变 + 按键圆点）。
 */
export default function FluteView({ accent = '#3ddfae', url = '/brand/flute.jpg', className = '' }: Props) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className={`flute-fallback ${className}`} aria-hidden="true">
        <div className="fb-body" style={{ boxShadow: `0 0 44px ${accent}55` }}>
          <i style={{ background: accent }} />
          <i style={{ background: accent }} />
          <i style={{ background: accent }} />
        </div>
        <span className="fb-note">♪</span>
      </div>
    )
  }

  return (
    <div className={`flute-view ${className}`} aria-hidden="true">
      <img src={url} alt="" draggable={false} onError={() => setFailed(true)} />
    </div>
  )
}

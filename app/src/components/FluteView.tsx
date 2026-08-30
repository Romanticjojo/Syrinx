import { useEffect, useRef, useState } from 'react'
import { FluteModel } from '../background/FluteModel'
import './FluteView.css'

interface Props {
  accent?: string
  /** 模型地址；默认 public 下的 flute.glb */
  url?: string
  className?: string
}

/**
 * 3D 长笛展示组件（Intro / PreviewPage hero 共用）。
 * glb 加载失败时回退 CSS 长笛条（金属渐变 + 按键圆点）。
 */
export default function FluteView({ accent = '#3ddfae', url = '/models/flute.glb', className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const model = new FluteModel(canvas, accent)
    const fit = () => {
      const r = canvas.getBoundingClientRect()
      model.resize(r.width, r.height)
    }
    fit()
    window.addEventListener('resize', fit)
    void model.load(url).then((ok) => {
      if (!ok) setFailed(true)
    })
    return () => {
      window.removeEventListener('resize', fit)
      model.dispose()
    }
  }, [accent, url])

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

  return <canvas className={`flute-view ${className}`} ref={canvasRef} aria-hidden="true" />
}

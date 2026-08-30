import { useEffect, useRef, useState, type RefObject } from 'react'
import { OSMDScore } from '../score/OSMDScore'
import type { Timeline } from '../types'

interface Props {
  xml: string | null
  timeline: Timeline | null
  accent?: string
  /** 是否显示缩放控件 */
  zoomControls?: boolean
  /** 把封装实例抛给父组件（演奏页驱动光标用） */
  scoreRef?: RefObject<OSMDScore | null>
}

/** 谱面容器：挂载 OSMDScore，负责加载/重渲染生命周期 */
export default function ScoreSheet({ xml, timeline, accent = '#3ddfae', zoomControls = false, scoreRef }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OSMDScore | null>(null)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // 创建实例（每曲一次）
  useEffect(() => {
    if (!divRef.current) return
    const osmd = new OSMDScore(divRef.current, accent)
    osmdRef.current = osmd
    if (scoreRef) scoreRef.current = osmd
    return () => {
      osmd.dispose()
      osmdRef.current = null
      if (scoreRef) scoreRef.current = null
    }
    // accent 变化意味着换曲，需要重建
  }, [accent, scoreRef])

  // 加载曲谱
  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd || !xml || !timeline) return
    setError(null)
    osmd
      .load(xml, timeline)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [xml, timeline])

  const changeZoom = (next: number) => {
    const clamped = Math.min(1.6, Math.max(0.6, Math.round(next * 10) / 10))
    osmdRef.current?.setZoom(clamped)
    setZoom(clamped)
  }

  return (
    <div className="score-sheet">
      {zoomControls && (
        <div className="sheet-tools">
          <button className="tool-pill" onClick={() => changeZoom(zoom - 0.1)} aria-label="缩小谱面">
            A−
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="tool-pill" onClick={() => changeZoom(zoom + 0.1)} aria-label="放大谱面">
            A+
          </button>
        </div>
      )}
      {error && <div className="sheet-error">曲谱渲染失败：{error}</div>}
      <div ref={divRef} className="sheet-container" />
    </div>
  )
}

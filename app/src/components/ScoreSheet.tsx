import { useEffect, useRef, useState, type RefObject } from 'react'
import { OSMDScore } from '../score/OSMDScore'
import type { Timeline } from '../types'

interface Props {
  xml: string | null
  timeline: Timeline | null
  accent?: string
  /** 把封装实例抛给父组件（演奏页驱动光标用） */
  scoreRef?: RefObject<OSMDScore | null>
  /** 小节变化回调：随实例一起挂/摘（实例在本组件内创建，挂接放这里才不会
      错过 StrictMode remount 换出来的新实例——演奏页侧挂会扑空，t_b22f5467 项 3） */
  onMeasureChange?: (measure: number, total: number) => void
  /** 谱面缩放（配合容器限宽调整每行小节数，默认 1） */
  zoom?: number
}

/** 谱面容器：挂载 OSMDScore，负责加载/重渲染生命周期 */
export default function ScoreSheet({ xml, timeline, accent = '#3ddfae', scoreRef, onMeasureChange, zoom = 1 }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OSMDScore | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 创建实例（每曲一次）
  useEffect(() => {
    if (!divRef.current) return
    const osmd = new OSMDScore(divRef.current, accent, undefined, zoom)
    osmdRef.current = osmd
    if (scoreRef) scoreRef.current = osmd
    if (onMeasureChange) osmd.onMeasureChange = onMeasureChange
    return () => {
      osmd.onMeasureChange = undefined
      osmd.dispose()
      osmdRef.current = null
      if (scoreRef) scoreRef.current = null
    }
    // accent 变化意味着换曲，需要重建
  }, [accent, scoreRef, onMeasureChange, zoom])

  // 加载曲谱
  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd || !xml || !timeline) return
    setError(null)
    osmd
      .load(xml, timeline)
      .then(() => {
        // HUD 初始化：谱面一就绪即报第 1 小节（终点标记不是真实小节），不等起奏第一帧
        if (osmdRef.current === osmd && onMeasureChange) {
          const total = timeline.measureTimes.filter((e) => !e.end).length
          onMeasureChange(1, total)
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [xml, timeline, onMeasureChange])

  return (
    <div className="score-sheet">
      {error && <div className="sheet-error">曲谱渲染失败：{error}</div>}
      <div ref={divRef} className="sheet-container" />
    </div>
  )
}

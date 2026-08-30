import { useEffect, useRef, useState, type RefObject } from 'react'
import { OSMDScore } from '../score/OSMDScore'
import type { Timeline } from '../types'

interface Props {
  xml: string | null
  timeline: Timeline | null
  accent?: string
  /** 把封装实例抛给父组件（演奏页驱动光标用） */
  scoreRef?: RefObject<OSMDScore | null>
}

/** 谱面容器：挂载 OSMDScore，负责加载/重渲染生命周期 */
export default function ScoreSheet({ xml, timeline, accent = '#3ddfae', scoreRef }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OSMDScore | null>(null)
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

  return (
    <div className="score-sheet">
      {error && <div className="sheet-error">曲谱渲染失败：{error}</div>}
      <div ref={divRef} className="sheet-container" />
    </div>
  )
}

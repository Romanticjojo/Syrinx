import { useEffect, useRef, useState } from 'react'
import type { NoteScore } from '../pitch/compare'
import type { PitchPoint } from '../types'
import './PitchChart.css'

interface Props {
  notes: NoteScore[]
  /** 已标注音分的实测轨迹（scoreAgainst 的 annotatedTrack） */
  track: PitchPoint[]
  durationSec: number
  accent?: string
}

const ML = 40 // 左侧音名轴宽
const MR = 12
const MT = 14
const MB = 22

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const midiOfHz = (hz: number): number => 69 + 12 * Math.log2(hz / 440)
const midiName = (midi: number): string =>
  `${NOTE_NAMES[midi % 12]!}${Math.floor(midi / 12) - 1}`

const IN_TUNE_CENTS = 50
/** 连续轨迹点的最大时间间隙（超过则断笔，静音段不连线） */
const GAP_SEC = 0.12

/**
 * 音高对比图（canvas，rAF 外静态重绘）：
 * x=时间，y=半音刻度；目标音符半透明色块、实测轨迹点线，
 * 超 ±50 音分偏红、准内为青（accent）。DPR 适配 + ResizeObserver。
 */
export default function PitchChart({ notes, track, durationSec, accent = '#3ddfae' }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect()
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || size.w < 60 || size.h < 60) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    cv.width = size.w * dpr
    cv.height = size.h * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(g, size.w, size.h, { notes, track, durationSec, accent })
  }, [size, notes, track, durationSec, accent])

  return (
    <div className="pitch-chart" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

type DrawArgs = Props

function draw(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  { notes, track, durationSec, accent = '#3ddfae' }: DrawArgs,
) {
  g.clearRect(0, 0, w, h)

  // 值域：目标音符与实测轨迹覆盖的半音范围（上下各留 1.5 半音）
  let lo = Infinity
  let hi = -Infinity
  for (const n of notes) {
    lo = Math.min(lo, n.note.midi)
    hi = Math.max(hi, n.note.midi)
  }
  for (const p of track) {
    const m = midiOfHz(p.hz)
    lo = Math.min(lo, m)
    hi = Math.max(hi, m)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    g.fillStyle = '#7a7a7a'
    g.font = '13px system-ui'
    g.fillText('暂无可对比的音高数据', ML, h / 2)
    return
  }
  lo = Math.floor(lo - 1.5)
  hi = Math.ceil(hi + 1.5)
  if (hi - lo < 6) {
    const mid = (hi + lo) / 2
    lo = Math.floor(mid - 3)
    hi = lo + 6
  }

  const plotW = w - ML - MR
  const plotH = h - MT - MB
  const x = (t: number): number => ML + (t / Math.max(durationSec, 0.001)) * plotW
  const y = (midi: number): number => MT + (1 - (midi - lo) / (hi - lo)) * plotH

  // 半音网格（八度线加重 + 音名）
  g.font = '10px system-ui'
  for (let m = lo; m <= hi; m++) {
    const isOctave = m % 12 === 0
    g.strokeStyle = isOctave ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)'
    g.beginPath()
    g.moveTo(ML, y(m))
    g.lineTo(w - MR, y(m))
    g.stroke()
    if (isOctave) {
      g.fillStyle = 'rgba(179,179,179,0.85)'
      g.textAlign = 'right'
      g.fillText(midiName(m), ML - 6, y(m) + 3)
    }
  }

  // 时间轴刻度
  const step = durationSec > 60 ? 15 : durationSec > 24 ? 5 : 2
  g.textAlign = 'center'
  for (let t = 0; t <= durationSec; t += step) {
    g.strokeStyle = 'rgba(255,255,255,0.07)'
    g.beginPath()
    g.moveTo(x(t), MT)
    g.lineTo(x(t), h - MB)
    g.stroke()
    g.fillStyle = 'rgba(122,122,122,0.9)'
    const mm = Math.floor(t / 60)
    const ss = String(Math.floor(t % 60)).padStart(2, '0')
    g.fillText(`${mm}:${ss}`, x(t), h - 7)
  }

  // 目标音符色块：准=accent、偏=暖红、miss（无实测）=灰
  for (const n of notes) {
    const x0 = x(n.note.time)
    const x1 = x(n.note.time + n.note.duration)
    const yc = y(n.note.midi)
    const rowH = Math.abs(y(lo) - y(lo + 1)) * 0.72
    if (n.measuredHz === null) g.fillStyle = 'rgba(255,255,255,0.07)'
    else if (n.inTune) g.fillStyle = hexA(accent, 0.16)
    else g.fillStyle = 'rgba(243,114,127,0.13)'
    g.beginPath()
    g.roundRect(x0, yc - rowH / 2, Math.max(x1 - x0, 1), rowH, 3)
    g.fill()
  }

  // 实测轨迹：断笔分段连线 + 逐点着色
  const colorOf = (p: PitchPoint): string => {
    const active = notes.some(
      (n) => p.time >= n.note.time && p.time < n.note.time + n.note.duration,
    )
    if (!active) return 'rgba(179,179,179,0.75)'
    return Math.abs(p.cents) <= IN_TUNE_CENTS ? accent : '#f3727f'
  }
  g.lineWidth = 1.6
  g.lineJoin = 'round'
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]!
    const b = track[i]!
    if (b.time - a.time > GAP_SEC) continue
    g.strokeStyle = colorOf(b)
    g.beginPath()
    g.moveTo(x(a.time), y(midiOfHz(a.hz)))
    g.lineTo(x(b.time), y(midiOfHz(b.hz)))
    g.stroke()
  }
  g.fillStyle = accent
  for (const p of track) {
    g.fillStyle = colorOf(p)
    g.beginPath()
    g.arc(x(p.time), y(midiOfHz(p.hz)), 1.4, 0, Math.PI * 2)
    g.fill()
  }
}

/** hex 颜色 + alpha → rgba 字符串 */
function hexA(hex: string, a: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(61,223,174,${a})`
  const n = parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

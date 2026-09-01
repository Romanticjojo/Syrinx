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

export const IN_TUNE_CENTS = 50
/** 连续轨迹点的最大时间间隙（超过则断笔，静音段不连线） */
const GAP_SEC = 0.12

export type NoteKind = 'hit' | 'off' | 'miss'

/** 目标音符三态：命中（有实测且准）/ 偏音（有实测超差）/ 漏音（无实测） */
export function noteKind(n: Pick<NoteScore, 'measuredHz' | 'inTune'>): NoteKind {
  if (n.measuredHz === null) return 'miss'
  return n.inTune ? 'hit' : 'off'
}

export interface SegSpec {
  color: 'accent' | 'off' | 'idle'
  width: number
}

/** 实测轨迹段规格：准内（±50 含端点）accent 高亮加粗，超差偏音红细线 */
export function segSpec(cents: number): SegSpec {
  return Math.abs(cents) <= IN_TUNE_CENTS
    ? { color: 'accent', width: 2.6 }
    : { color: 'off', width: 1.4 }
}

/** 漏音块 45° 斜纹 tile（红系警示条纹），模块级只建一次 */
let missTile: HTMLCanvasElement | null = null
function missPattern(g: CanvasRenderingContext2D): CanvasPattern | string {
  if (typeof document === 'undefined') return 'rgba(243,114,127,0.3)'
  if (!missTile) {
    const t = document.createElement('canvas')
    t.width = 8
    t.height = 8
    const tg = t.getContext('2d')!
    tg.strokeStyle = 'rgba(243,114,127,0.5)'
    tg.lineWidth = 2
    tg.beginPath()
    // 主对角线 + 两侧补线，平铺无缝的 45° 斜纹
    tg.moveTo(0, 8)
    tg.lineTo(8, 0)
    tg.moveTo(-4, 4)
    tg.lineTo(4, -4)
    tg.moveTo(4, 12)
    tg.lineTo(12, 4)
    tg.stroke()
    missTile = t
  }
  return g.createPattern(missTile, 'repeat') ?? 'rgba(243,114,127,0.3)'
}

/**
 * 音高对比图（canvas，rAF 外静态重绘）：
 * x=时间，y=半音刻度。目标音符三态色块：命中（±50 内有实测）accent 高亮、
 * 偏音暖红、漏音（无实测）红斜纹+hairline 描边；实测轨迹命中段 accent 加粗、
 * 超差偏红、谱外灰。DPR 适配 + ResizeObserver。
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

  // 目标音符色块三态（t_2264e5ba）：命中=accent 高亮、偏音=暖红、漏音=红斜纹+hairline 描边
  for (const n of notes) {
    const x0 = x(n.note.time)
    const x1 = x(n.note.time + n.note.duration)
    const yc = y(n.note.midi)
    const rowH = Math.abs(y(lo) - y(lo + 1)) * 0.72
    const round = () => {
      g.beginPath()
      g.roundRect(x0, yc - rowH / 2, Math.max(x1 - x0, 1), rowH, 3)
    }
    const kind = noteKind(n)
    if (kind === 'miss') {
      round()
      g.fillStyle = missPattern(g)
      g.fill()
      round()
      g.strokeStyle = 'rgba(243,114,127,0.45)'
      g.lineWidth = 1
      g.stroke()
    } else if (kind === 'hit') {
      round()
      g.fillStyle = hexA(accent, 0.55)
      g.fill()
    } else {
      round()
      g.fillStyle = 'rgba(243,114,127,0.28)'
      g.fill()
    }
  }

  // 实测轨迹：断笔分段连线 + 逐点着色（命中段 accent 加粗、超差偏红、谱外灰）
  const segColor = (spec: SegSpec): string =>
    spec.color === 'accent' ? accent : spec.color === 'off' ? '#f3727f' : 'rgba(179,179,179,0.75)'
  const specOf = (p: PitchPoint): SegSpec => {
    const active = notes.some(
      (n) => p.time >= n.note.time && p.time < n.note.time + n.note.duration,
    )
    return active ? segSpec(p.cents) : { color: 'idle', width: 1.2 }
  }
  g.lineJoin = 'round'
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]!
    const b = track[i]!
    if (b.time - a.time > GAP_SEC) continue
    const spec = specOf(b)
    g.strokeStyle = segColor(spec)
    g.lineWidth = spec.width
    g.beginPath()
    g.moveTo(x(a.time), y(midiOfHz(a.hz)))
    g.lineTo(x(b.time), y(midiOfHz(b.hz)))
    g.stroke()
  }
  for (const p of track) {
    const spec = specOf(p)
    g.fillStyle = segColor(spec)
    g.beginPath()
    g.arc(x(p.time), y(midiOfHz(p.hz)), spec.color === 'accent' ? 2 : 1.4, 0, Math.PI * 2)
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

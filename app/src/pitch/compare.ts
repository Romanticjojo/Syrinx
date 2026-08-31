import type { NoteEvent, PitchPoint, Timeline, TuneStats } from '../types'
import { yinDetect } from './yin'

/**
 * 实测音高轨迹提取 + 目标对比统计（全部纯函数）。
 * 输入为 AudioBuffer 的鸭子类型（sampleRate + getChannelData），
 * 录音解码后的 AudioBuffer 与测试替身都可直接传入。
 */

export interface PitchAudioBuffer {
  sampleRate: number
  getChannelData(channel: number): Float32Array
}

export interface ExtractOptions {
  /** 分析帧长（秒），默认 2048 样本 @44.1kHz */
  frameSec?: number
  /** 帧移（秒），默认约半帧重叠 */
  hopSec?: number
  /** 低于此清晰度的帧丢弃 */
  clarityMin?: number
  /** 轨迹时间整体平移（秒）：录音自伴奏中段开始时传入 Take.offsetSec */
  offsetSec?: number
}

/** 长笛基频范围（略放宽以覆盖气声发音与测试音）；实时分析共用 */
export const MIN_HZ = 180
export const MAX_HZ = 2500

/** 逐帧 YIN：静音/低清晰度/超长笛音域的帧不产出轨迹点 */
export function extractPitchTrack(
  buffer: PitchAudioBuffer,
  { frameSec = 0.0464, hopSec = 0.0232, clarityMin = 0.6, offsetSec = 0 }: ExtractOptions = {},
): PitchPoint[] {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const frameN = Math.max(64, Math.round(frameSec * sr))
  const hopN = Math.max(1, Math.round(hopSec * sr))
  const points: PitchPoint[] = []

  for (let start = 0; start + frameN <= data.length; start += hopN) {
    const seg = data.subarray(start, start + frameN)
    const r = yinDetect(seg, sr)
    if (!r || r.clarity < clarityMin) continue
    if (r.hz < MIN_HZ || r.hz > MAX_HZ) continue
    points.push({ time: start / sr + offsetSec, hz: r.hz, cents: 0 })
  }
  return points
}

export interface NoteScore {
  note: NoteEvent
  targetHz: number
  /** 音符窗口内实测中位频率；无任何实测样本（miss）为 null */
  measuredHz: number | null
  /** 相对目标的音分偏差；miss 为 null */
  cents: number | null
  /** |cents| ≤ 50 */
  inTune: boolean
}

export interface ScoreResult {
  /** 逐音符评分（含 miss） */
  notes: NoteScore[]
  /** 轨迹点带上相对当前目标音的音分（无目标音时为 0），供图表着色 */
  annotatedTrack: PitchPoint[]
  stats: TuneStats
}

const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/** 目标音符窗口内的实测中位频率（中位数抗离群帧） */
function medianHz(points: PitchPoint[]): number | null {
  if (!points.length) return null
  const sorted = [...points].map((p) => p.hz).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** 该时刻发声的目标音符（最后一个 time ≤ t 且未结束的）；实时反馈共用 */
export function noteAt(notes: NoteEvent[], t: number): NoteEvent | null {
  let hit: NoteEvent | null = null
  for (const n of notes) {
    if (n.time <= t && t < n.time + n.duration) hit = n
    else if (n.time > t) break
  }
  return hit
}

const IN_TUNE_CENTS = 50
/** 音符评分窗口内缩比例：跳过起音瞬态与收尾泄漏（边界帧常混入相邻音符） */
const ONSET_SKIP = 0.15
const OFFSET_SKIP = 0.1

/** 截断时间轴：只保留 time < stopSec 的音符（停止演奏的统计口径，t_53aa8b7a）。
 *  stopSec = Take 封存时的 audioEngine.time（绝对停止时刻）：自然结束 ≈ 全曲时长
 *  （不早于 durationSec 时返回原引用零开销）；停止演奏 = 点击时刻，之后的音符
 *  未被演奏，不进命中率/漏音统计。 */
export function timelineUpTo(timeline: Timeline, stopSec: number): Timeline {
  if (!Number.isFinite(stopSec) || stopSec >= timeline.durationSec) return timeline
  return { ...timeline, notes: timeline.notes.filter((n) => n.time < stopSec) }
}

export function scoreAgainst(track: PitchPoint[], timeline: Timeline): ScoreResult {
  const notes: NoteScore[] = timeline.notes.map((note) => {
    const targetHz = midiToHz(note.midi)
    const winStart = note.time + note.duration * ONSET_SKIP
    const winEnd = note.time + note.duration * (1 - OFFSET_SKIP)
    const inWindow = track.filter((p) => p.time >= winStart && p.time < winEnd)
    const measuredHz = medianHz(inWindow)
    const cents =
      measuredHz === null ? null : 1200 * Math.log2(measuredHz / targetHz)
    return {
      note,
      targetHz,
      measuredHz,
      cents,
      inTune: cents !== null && Math.abs(cents) <= IN_TUNE_CENTS,
    }
  })

  // 轨迹点着色用：相对当前目标音的音分
  const annotatedTrack: PitchPoint[] = track.map((p) => {
    const n = noteAt(timeline.notes, p.time)
    if (!n) return { ...p, cents: 0 }
    return { ...p, cents: 1200 * Math.log2(p.hz / midiToHz(n.midi)) }
  })

  const measured = notes.filter((n): n is NoteScore & { cents: number } => n.cents !== null)
  const stats: TuneStats = {
    noteCount: measured.length,
    inTuneRatio: measured.length ? measured.filter((n) => n.inTune).length / measured.length : 0,
    avgAbsCents: measured.length
      ? measured.reduce((s, n) => s + Math.abs(n.cents), 0) / measured.length
      : 0,
  }

  return { notes, annotatedTrack, stats }
}

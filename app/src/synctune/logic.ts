import type { NoteEvent, Timeline } from '../types'
import type { BeatsFile } from '../score/anchors'

/**
 * 同步调试页（/sync-tune）纯逻辑：
 * - 音符 ↔ 播放序四分音符位（q）换算：局部段速率（anchors.test.ts noteQOf/localRateOf
 *   同式）——真谱带中途变速（luv-letter m6 起 86bpm、m67 回 76），全局 secPerQuarter
 *   直算会把小节内偏移压缩 ~11.5%，禁止。
 * - 拍级网格 q→t：与 anchors.ts applyBeats 的 segAt 同式（相邻控制点线性插值，
 *   首/末段斜率外推），微调 diff 在本页内先行生效，保存导出后由 applyBeats 消费。
 */

/** 拍级控制点（beats.json beatAnchors 项） */
export interface CtrlPoint {
  q: number
  t: number
}

/** 待微调音符（播放序，q 为恒速谱换算的播放序四分音符位） */
export interface SyncNote {
  /** timeline.notes 下标（播放序，稳定标识） */
  idx: number
  measure: number
  midi: number
  q: number
}

/** 人工修正日志条目（manual_offsets.json，离线产线重跑后按最新 q 重放） */
export interface ManualOffset {
  q: number
  /** 相对基线（微调前 beats.json 网格）的总偏移，毫秒，正 = 推后 */
  deltaMs: number
  ts: number
  note: string
}

/** 小节号 → measureTimes 下标（首个同名项；终点标记不算，applyBeats 同约定） */
export function buildIndexByMeasure(timeline: Timeline): Map<number, number> {
  const index = new Map<number, number>()
  timeline.measureTimes.forEach((e, i) => {
    if (!e.end && !index.has(e.measure)) index.set(e.measure, i)
  })
  return index
}

/** 局部段速率（四分音符/恒速秒）：相邻小节 Δquarters/Δsec */
export function localRateOf(timeline: Timeline, k: number): number {
  const mt = timeline.measureTimes
  return (mt[k + 1].quarters - mt[k].quarters) / Math.max(mt[k + 1].time - mt[k].time, 1e-9)
}

/** 恒速谱音符时间 → 播放序四分音符位 q（局部段速率换算，禁止全局直算） */
export function noteQOf(
  timeline: Timeline,
  indexByMeasure: Map<number, number>,
  n: NoteEvent,
): number {
  const k = indexByMeasure.get(n.measure)
  if (k === undefined || k + 1 >= timeline.measureTimes.length) return 0
  const e = timeline.measureTimes[k]
  return e.quarters + (n.time - e.time) * localRateOf(timeline, k)
}

/** 恒速谱 → 全量待微调音符表（播放序） */
export function buildSyncNotes(timeline: Timeline): SyncNote[] {
  const indexByMeasure = buildIndexByMeasure(timeline)
  return timeline.notes.map((n, idx) => ({
    idx,
    measure: n.measure,
    midi: n.midi,
    q: noteQOf(timeline, indexByMeasure, n),
  }))
}

/** 拍级网格 q→t：相邻控制点线性插值，首/末段斜率外推（q 不必整数，不必递增输入） */
export function makeQ2T(points: CtrlPoint[]): (q: number) => { t: number; rate: number } {
  const pts = [...points].sort((a, b) => a.q - b.q)
  if (pts.length < 2) {
    // 单点/空网格：退化为恒速（斜率 0.5s/拍兜底），仅供防御，正常数据 ≥2 项
    const t0 = pts[0]?.t ?? 0
    return (q) => ({ t: t0 + Math.max(0, q - (pts[0]?.q ?? 0)) * 0.5, rate: 0.5 })
  }
  return (q) => {
    const n = pts.length
    let i: number
    if (q <= pts[0].q) i = 0
    else if (q >= pts[n - 1].q) i = n - 2
    else {
      let lo = 0
      let hi = n - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (pts[mid].q <= q) lo = mid
        else hi = mid
      }
      i = lo
    }
    const a = pts[i]
    const b = pts[i + 1]
    const rate = (b.t - a.t) / Math.max(b.q - a.q, 1e-9)
    return { t: a.t + (q - a.q) * rate, rate }
  }
}

/** q 的基线时刻（微调前网格插值）：人工修正 deltaMs 的基准 */
export function baselineTAt(baseline: CtrlPoint[], q: number): number {
  return makeQ2T(baseline)(q).t
}

/**
 * 音符 q 的现有控制点：v6 音符级锚点按音符 onset 建点，精确匹配为主；
 * 相同 q 取首个（数据合法性由导出校验保证 q 递增唯一）。
 */
export function cpIndexAt(points: CtrlPoint[], q: number): number {
  return points.findIndex((p) => p.q === q)
}

/** 音符是否已人工微调：q 处控制点存在且 t 偏离基线插值 > 1µs */
export function isTuned(note: SyncNote, working: CtrlPoint[], baseline: CtrlPoint[]): boolean {
  const i = cpIndexAt(working, note.q)
  if (i < 0) return false
  return Math.abs(working[i].t - baselineTAt(baseline, note.q)) > 1e-6
}

/**
 * 微调作用于选中音：q 有控制点则改其 t，无则按基线插值插入新点（计划第 5 条）。
 * 返回新数组（不可变，供撤销栈快照与 React 更新）；deltaMs 可正可负。
 */
export function adjustPoint(
  working: CtrlPoint[],
  q: number,
  baseline: CtrlPoint[],
  deltaMs: number,
): CtrlPoint[] {
  const i = cpIndexAt(working, q)
  const delta = deltaMs / 1000
  if (i >= 0) {
    const next = [...working]
    next[i] = { ...next[i], t: next[i].t + delta }
    return next
  }
  const inserted: CtrlPoint = { q, t: baselineTAt(baseline, q) + delta }
  return [...working, inserted].sort((a, b) => a.q - b.q)
}

/**
 * 重置选中音的微调：q 处是插入的新点 → 移除；是基线既有点 → 恢复基线 t。
 * 无微调可撤时原样返回（引用不变，调用方据此跳过快照）。
 */
export function resetPoint(working: CtrlPoint[], q: number, baseline: CtrlPoint[]): CtrlPoint[] {
  const wi = cpIndexAt(working, q)
  if (wi < 0) return working
  const bi = cpIndexAt(baseline, q)
  if (bi < 0) {
    const removed = [...working]
    removed.splice(wi, 1)
    return removed
  }
  if (working[wi].t === baseline[bi].t) return working // 无 diff：引用不变，调用方跳过快照
  const next = [...working]
  next[wi] = { ...next[wi], t: baseline[bi].t }
  return next
}

/** 选中音当前偏差（毫秒）：工作网格 t − 基线插值 t；无控制点为 0 */
export function deltaMsAt(working: CtrlPoint[], baseline: CtrlPoint[], q: number): number {
  const i = cpIndexAt(working, q)
  if (i < 0) return 0
  return (working[i].t - baselineTAt(baseline, q)) * 1000
}

/**
 * 试听 A/B 窗口（计划第 4 条）：修正前/后各播 −1s → +2s；起点钳 0。
 * 修正未生效（偏差 < 1µs）时 B 窗与 A 窗相同——调用方可据此跳过 B 段。
 */
export function auditionWindow(t: number): { start: number; end: number } {
  return { start: Math.max(0, t - 1), end: t + 2 }
}

/** 导出 beats.json：version+1，note 追加人工记录；anchors/其余字段原样保留 */
export function buildBeatsExport(
  baseline: BeatsFile,
  working: CtrlPoint[],
  tunedCount: number,
  dateLabel: string,
): BeatsFile {
  const note = `${baseline.note ?? ''}｜人工微调 ${tunedCount} 处（/sync-tune ${dateLabel}）`.replace(
    /^｜/,
    '',
  )
  return {
    ...baseline,
    version: baseline.version + 1,
    note,
    beatAnchors: [...working].sort((a, b) => a.q - b.q),
  }
}

/** 导出 manual_offsets.json：追加式日志（回放取每个 q 的最新条目） */
export function appendManualOffset(
  log: ManualOffset[],
  q: number,
  working: CtrlPoint[],
  baseline: CtrlPoint[],
  note: string,
): ManualOffset[] {
  return [
    ...log,
    { q, deltaMs: Math.round(deltaMsAt(working, baseline, q) * 100) / 100, ts: Date.now(), note },
  ]
}

/** MIDI → 音名（升号记法，调试面板展示用） */
export function midiName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

/** 秒 → m:ss.t（面板/波形刻度显示） */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
}

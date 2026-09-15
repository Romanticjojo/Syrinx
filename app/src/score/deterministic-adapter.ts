import type { NoteEvent, Timeline } from '../types'
import {
  parseDeterministicTimeline,
  type DeterministicTimeline,
  type DeterministicTimelineNote,
} from './deterministic-timeline.ts' // 显式扩展：node 原生 TS 剥离的冒烟脚本可直接装载本模块

/**
 * PlanB · T2 确定性时间表 → Timeline 转换器。
 *
 * 下游（OSMDScore 光标推进、synthAccompaniment、noteAt 音准对比）只认 Timeline
 * 形状，因此接入方式 = 把 T1 的 DeterministicTimeline 转换成同构对象，
 * 光标推进逻辑零改动。与 anchors.ts（beats.json 伴奏锚点）形成可运行时切换的
 * 双数据源：loadSong 按 manifest.cursorMode / 运行时覆盖选路。
 *
 * 转换规则（任务书定死）：
 * - notes：剔除 rest（midi 无意义）与 grace（不占时值，光标不停留）；
 *   time = t0Sec、duration = t1Sec - t0Sec、midi 由科学音高换算、measure 用谱面小节号
 * - measureTimes：按演奏序每小节一项 {measure, time, quarters}；末项 end:true
 *   终点标记（measure = 末小节 + 1，沿用现有约定）
 * - durationSec = endSec；tempo/secPerQuarter 取首段 BPM
 * - tie 不合并（与 anchors 路径相同的透传语义，每段 tie 各自成 NoteEvent）
 */

/** step → 半音偏移（相对 C） */
const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** 科学音高记法 → MIDI（60 = C4）："C4"→60、"A4"→69、"F#1"、"Bb3"、"C#5" */
export function pitchToMidi(pitch: string): number {
  const m = /^([A-G])(#*|b*)(-?\d+)$/.exec(pitch)
  if (!m) return 0
  const accidental = m[2]
  const alter = accidental.length * (accidental.includes('b') ? -1 : 1)
  return (Number(m[3]) + 1) * 12 + STEP_SEMITONE[m[1]] + alter
}

/**
 * 小节表聚合：确定性时间表只携带音符级数据（红线：不改 deterministic-timeline.ts），
 * measureTimes 由 notes 按「相邻同小节号游程」聚合——反复未物化的谱（同号小节
 * 在演奏序中多次出现）恰好形成多个游程，与演奏序一一对应。
 * 完全空置（无 note/forward 事件）的小节无条目会缺项：quarters 是绝对位置，
 * quarters→时间插值仍准，仅该小节内 HUD 小节号滞后（罕见，可接受）。
 */
function aggregateMeasureTimes(dt: DeterministicTimeline): Timeline['measureTimes'] {
  const measureTimes: Timeline['measureTimes'] = []
  for (const n of dt.notes) {
    const last = measureTimes[measureTimes.length - 1]
    if (!last || last.measure !== n.measure) {
      measureTimes.push({ measure: n.measure, time: n.t0Sec, quarters: n.startQ })
    } else {
      // grace 的 t0 锚在前一主音上、backup 会让小节内 startQ 回退：取游程内最小值
      if (n.t0Sec < last.time) last.time = n.t0Sec
      if (n.startQ < last.quarters) last.quarters = n.startQ
    }
  }
  measureTimes.push({
    measure: (measureTimes[measureTimes.length - 1]?.measure ?? 0) + 1,
    time: dt.endSec,
    quarters: dt.totalQ,
    end: true,
  })
  return measureTimes
}

/** DeterministicTimeline → Timeline 同构对象（下游光标逻辑零改动） */
export function deterministicToTimeline(dt: DeterministicTimeline): Timeline {
  const notes: NoteEvent[] = []
  for (const n of dt.notes as DeterministicTimelineNote[]) {
    if (n.isGrace || n.pitch === null) continue // rest 与 grace 不进光标停靠序列
    notes.push({
      time: n.t0Sec,
      duration: n.t1Sec - n.t0Sec,
      midi: pitchToMidi(n.pitch),
      measure: n.measure,
    })
  }
  const tempo = dt.tempoSegments[0]?.bpm ?? 90
  return {
    durationSec: dt.endSec,
    secPerQuarter: 60 / tempo,
    tempo,
    notes,
    measureTimes: aggregateMeasureTimes(dt),
  }
}

/** 装载入口：MusicXML → 确定性时间表 → Timeline。入参建议为已展开反复的谱面
 * （loadSong 的展开链路产物），此时演奏序 = 文件序、小节号 = 展开谱重编号 */
export function buildScoreTimeline(xml: string): Timeline {
  return deterministicToTimeline(parseDeterministicTimeline(xml))
}

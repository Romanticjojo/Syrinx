import type { Timeline } from '../types'

/**
 * beats.json（伴奏锚点文件）结构。
 * 产物由离线分析生成：resources/luv-letter/score/omr-work/t3b9/（任务 t_3b9cfc25）。
 */
export interface BeatsFile {
  songId: string
  version: number
  /** 伴奏真实速度（拍/分）：重写 timeline.tempo，倒数节拍音与光标兜底速率都用它 */
  bpm: number
  /** 每个谱面小节在伴奏音频中的真实起始时刻（秒） */
  anchors: { m: number; t: number }[]
  end?: number
}

/**
 * 伴奏锚点重写时间轴（方案 B：伴奏驱动光标）。
 *
 * 为什么需要：luv-letter 的 OMR 谱缺失约 36 个伴奏小节，XML 里用假 tempo
 * （50/56.5/50）把 62 小节撑到 269.4s 凑伴奏总长——总长对但逐拍错位，光标
 * 越走越快于伴奏乐句。锚点给出每个谱面小节在伴奏里的真实起始时刻。
 *
 * 改写内容：
 * - measureTimes[].time → 锚点时刻（有锚点的小节直接用；缺锚点的按四分音符
 *   位置在相邻锚点间线性插值，终点标记按伴奏速度外推）
 * - notes[].time/duration → 按同一分段插值重映射（实时音准对比 noteAt 依赖它）
 * - tempo/secPerQuarter → 伴奏真实速度
 */
export function applyBeats(timeline: Timeline, beats: BeatsFile): Timeline {
  const mt = timeline.measureTimes
  const anchorOf = new Map(beats.anchors.map((a) => [a.m, a.t]))
  // 锚点与小节对不上号（数据错曲）则不应用，回退恒速时间轴
  if (![...anchorOf.keys()].some((m) => mt.some((e) => e.measure === m))) return timeline

  const spq = 60 / beats.bpm
  const qs = mt.map((e) => e.quarters)

  // 各采样点（小节起点 + 终点标记）的锚定时刻
  const anchored = mt.map((e) => anchorOf.get(e.measure))
  const known = anchored.map((t, i) => (t !== undefined ? i : -1)).filter((i) => i >= 0)
  if (known.length === 0) return timeline
  const first = known[0]
  const last = known[known.length - 1]
  for (let i = 0; i < mt.length; i++) {
    if (anchored[i] !== undefined) continue
    if (i < first) {
      anchored[i] = anchored[first]! - (qs[first] - qs[i]) * spq
    } else if (i > last) {
      anchored[i] = anchored[last]! + (qs[i] - qs[last]) * spq
    } else {
      // 相邻已知锚点之间：按四分音符位置线性插值
      const l = [...known].reverse().find((k) => k < i)!
      const r = known.find((k) => k > i)!
      anchored[i] = anchored[l]! + ((anchored[r]! - anchored[l]!) * (qs[i] - qs[l])) / (qs[r] - qs[l])
    }
  }

  // 小节号 → measureTimes 下标（首个同名项；终点标记不算）
  const indexByMeasure = new Map<number, number>()
  mt.forEach((e, i) => {
    if (!e.end && !indexByMeasure.has(e.measure)) indexByMeasure.set(e.measure, i)
  })

  const fakeRate = (i: number): number =>
    (mt[i + 1].quarters - mt[i].quarters) / Math.max(mt[i + 1].time - mt[i].time, 1e-9)

  const notes = timeline.notes.map((n) => {
    const k = indexByMeasure.get(n.measure)
    if (k === undefined || k + 1 >= mt.length) return n
    const q = qs[k] + (n.time - mt[k].time) * fakeRate(k)
    // segRate：锚定系秒/四分音符；fakeRate：四分音符/假 tempo 系秒
    const segRate = (anchored[k + 1]! - anchored[k]!) / Math.max(qs[k + 1] - qs[k], 1e-9)
    const time = anchored[k]! + (q - qs[k]) * segRate
    const duration = n.duration * segRate * fakeRate(k)
    return { ...n, time, duration }
  })

  return {
    ...timeline,
    tempo: beats.bpm,
    secPerQuarter: spq,
    measureTimes: mt.map((e, i) => ({ ...e, time: Math.max(0, anchored[i]!) })),
    notes,
  }
}

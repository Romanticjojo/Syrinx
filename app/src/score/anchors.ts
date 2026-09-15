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
  /**
   * 拍级控制点（v4+，可选）：q = 播放序四分音符位置（每拍一个），t = 伴奏秒。
   * 存在且合法（≥2 项）时整条时间轴走拍级网格插值（rubato/拍内律动不再被
   * 小节级线性等分抹平），否则回退小节级逻辑。beat0 与 anchors 同源。
   */
  beatAnchors?: { q: number; t: number }[]
  /** 版本说明/人工微调记录（/sync-tune 导出时追加），离线产线可忽略 */
  note?: string
  end?: number
}

/**
 * 伴奏锚点重写时间轴（方案 B：伴奏驱动光标）。
 *
 * 为什么需要：luv-letter 伴奏含反复段，恒速谱面时间轴与伴奏乐句天然错位；
 * 锚点给出每个谱面小节在伴奏里的真实起始时刻（73 小节完整谱 + 伴奏实测，
 * 任务 t_d02450b9；早期 62 小节谱的假 tempo 凑长方案已废弃）。
 *
 * 改写内容：
 * - measureTimes[].time → 锚点时刻（有锚点的小节直接用；缺锚点的按四分音符
 *   位置在相邻锚点间线性插值，终点标记按伴奏速度外推）
 * - notes[].time/duration → 按同一分段插值重映射（实时音准对比 noteAt 依赖它）
 * - tempo/secPerQuarter → 伴奏真实速度
 *
 * v4+（beatAnchors，beat_refine/beats_v4.json）：拍级网格整体替代小节级插值——
 * 小节头仍是 beat0=小节锚点，beat1-3 为 onset-flux 局部吸附，rubato/拍内律动
 * 不再被小节内等分抹平（onset 命中率 0.334→0.564）。measureTimes 与 notes 全部
 * 走 q→t 拍级插值；无 beatAnchors 或结构不合法时回退小节级路径。
 */
export function applyBeats(timeline: Timeline, beats: BeatsFile): Timeline {
  const mt = timeline.measureTimes
  const anchorOf = new Map(beats.anchors.map((a) => [a.m, a.t]))
  // 锚点与小节对不上号（数据错曲）则不应用，回退恒速时间轴
  if (![...anchorOf.keys()].some((m) => mt.some((e) => e.measure === m))) return timeline

  const spq = 60 / beats.bpm
  const qs = mt.map((e) => e.quarters)

  // 小节号 → measureTimes 下标（首个同名项；终点标记不算）
  const indexByMeasure = new Map<number, number>()
  mt.forEach((e, i) => {
    if (!e.end && !indexByMeasure.has(e.measure)) indexByMeasure.set(e.measure, i)
  })

  // 拍级网格（v4+）：存在且结构合法才启用，否则走小节级（Nocturne 等无 beatAnchors 不受影响）
  const ba = beats.beatAnchors
  const grid =
    Array.isArray(ba) &&
    ba.length >= 2 &&
    ba.every((p) => !!p && Number.isFinite(p.q) && Number.isFinite(p.t))
      ? [...ba].sort((a, b) => a.q - b.q)
      : null

  /**
   * 任意播放序四分音符位置 → { 伴奏秒, 所在段斜率（秒/四分音符） }。
   * 相邻控制点线性插值；首点之前/末点之后按首/末段斜率外推（q 不必是整数）。
   * 仅供拍级路径使用（调用处已保证 grid 非空）。
   */
  const segAt = (q: number): { t: number; rate: number } => {
    const pts = grid!
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

  // 各采样点（小节起点 + 终点标记）的锚定时刻；notes 为重映射结果
  let anchored: (number | undefined)[]
  let notes: Timeline['notes']

  if (grid) {
    // —— 拍级路径（v4+）：小节内部不再等分，拍级控制点承载 rubato/拍内律动 ——
    // 恒速系秒偏移 → 播放序四分音符位置用局部段速率（相邻小节 Δquarters/Δsec）：
    // 恒速谱上 = 1/oldSecPerQuarter，与「oldSecPerQuarter 直算」严格等价；
    // luv-letter 真谱带中途变速（m6 起 86bpm、m67 回 76），全局直算会把小节内
    // 偏移压缩 ~11.5%（≈0.1-0.3s 拍位错位 + 时值截短），故按段内实际速率换算。
    const localRate = (i: number): number =>
      (mt[i + 1].quarters - mt[i].quarters) / Math.max(mt[i + 1].time - mt[i].time, 1e-9)
    anchored = mt.map((e) => segAt(e.quarters).t)
    notes = timeline.notes.map((n) => {
      const k = indexByMeasure.get(n.measure)
      if (k === undefined || k + 1 >= mt.length) return n
      const noteQ = mt[k].quarters + (n.time - mt[k].time) * localRate(k)
      const seg = segAt(noteQ)
      return { ...n, time: seg.t, duration: n.duration * localRate(k) * seg.rate }
    })
  } else {
    // —— 小节级路径（v3 及以下）：原有逻辑原样保留 ——
    anchored = mt.map((e) => anchorOf.get(e.measure))
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
        anchored[i] =
          anchored[l]! + ((anchored[r]! - anchored[l]!) * (qs[i] - qs[l])) / (qs[r] - qs[l])
      }
    }

    const fakeRate = (i: number): number =>
      (mt[i + 1].quarters - mt[i].quarters) / Math.max(mt[i + 1].time - mt[i].time, 1e-9)

    notes = timeline.notes.map((n) => {
      const k = indexByMeasure.get(n.measure)
      if (k === undefined || k + 1 >= mt.length) return n
      const q = qs[k] + (n.time - mt[k].time) * fakeRate(k)
      // segRate：锚定系秒/四分音符；fakeRate：四分音符/假 tempo 系秒
      const segRate = (anchored[k + 1]! - anchored[k]!) / Math.max(qs[k + 1] - qs[k], 1e-9)
      const time = anchored[k]! + (q - qs[k]) * segRate
      const duration = n.duration * segRate * fakeRate(k)
      return { ...n, time, duration }
    })
  }

  // durationSec 同步重映射到锚定系（t_d02450b9）：恒速网格的旧值在诚实 bpm 谱上
  // 会远小于伴奏锚点终点，导致演奏主循环提前判定结束。取「末音结束」与
  // 「终点标记锚定时刻」的较大者（末小节整小节休止时仅后者有效）。
  const anchoredEnd = Math.max(...anchored.map((t) => t ?? 0))
  const durationSec = Math.max(
    notes.reduce((end, n) => Math.max(end, n.time + n.duration), 0),
    anchoredEnd,
  )

  return {
    ...timeline,
    tempo: beats.bpm,
    secPerQuarter: spq,
    durationSec,
    measureTimes: mt.map((e, i) => ({ ...e, time: Math.max(0, anchored[i]!) })),
    notes,
  }
}

/**
 * 全局锚点微调（manifest.anchorOffsetMs，秒）：谱面时间轴整体平移。
 * 锚点标定的系统性残差（伴奏与谱面恒定错位）不需要逐小节改 beats.json，
 * 在应用锚点之后整体平移即可——notes/measureTimes/durationSec 同步移动，
 * 负向平移越界的时刻钳到 0（与 applyBeats 的钳制语义一致）。
 */
export function applyAnchorOffset(timeline: Timeline, offsetSec: number): Timeline {
  if (!offsetSec) return timeline
  const shift = (t: number) => Math.max(0, t + offsetSec)
  return {
    ...timeline,
    durationSec: Math.max(0, timeline.durationSec + offsetSec),
    notes: timeline.notes.map((n) => ({ ...n, time: shift(n.time) })),
    measureTimes: timeline.measureTimes.map((e) => ({ ...e, time: shift(e.time) })),
  }
}

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyAnchorOffset, applyBeats, type BeatsFile } from './anchors'
import { expandRepeats, parseMusicXml } from './musicxml'
import type { Timeline } from '../types'

/** 最小时间轴替身：3 小节 4/4，假 tempo=50（m2 起换 100 模拟假变速） */
const FAKE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>50</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`

describe('applyBeats 伴奏锚点重写', () => {
  const tl = parseMusicXml(FAKE_XML)

  /** 恒速替身时间轴：3 小节 4/4，secPerQuarter=0.5（q: 0/4/8，终点标记 12） */
  const TL2: Timeline = {
    tempo: 120,
    secPerQuarter: 0.5,
    durationSec: 6,
    measureTimes: [
      { measure: 1, time: 0, quarters: 0 },
      { measure: 2, time: 2, quarters: 4 },
      { measure: 3, time: 4, quarters: 8 },
      { measure: 4, time: 6, quarters: 12, end: true },
    ],
    notes: [
      { time: 0, duration: 0.5, midi: 72, measure: 1 },
      { time: 2.75, duration: 0.5, midi: 74, measure: 2 }, // q=5.5（m2 内 1.5 拍）
      { time: 4, duration: 0.5, midi: 76, measure: 3 }, // q=8
    ],
  }

  it('全部小节有锚点：measureTimes/notes/tempo 全部重映射', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 1,
      bpm: 90,
      anchors: [
        { m: 1, t: 0 },
        { m: 2, t: 2.6667 },
        { m: 3, t: 5.3333 },
      ],
    }
    const out = applyBeats(tl, beats)
    expect(out.tempo).toBe(90)
    expect(out.secPerQuarter).toBeCloseTo(60 / 90, 5)
    // 小节时间 = 锚点值
    expect(out.measureTimes[0].time).toBe(0)
    expect(out.measureTimes[1].time).toBeCloseTo(2.6667, 3)
    expect(out.measureTimes[2].time).toBeCloseTo(5.3333, 3)
    // 终点标记：末小节起点 + 4 拍 @90bpm
    expect(out.measureTimes[3].time).toBeCloseTo(5.3333 + 4 * (60 / 90), 3)
    // 音符跟随小节起点（假 tempo 50→100 的拉伸被锚点抹平）
    expect(out.notes[0].time).toBe(0)
    expect(out.notes[1].time).toBeCloseTo(2.6667, 3)
    expect(out.notes[2].time).toBeCloseTo(5.3333, 3)
    // 音符时长换算到锚定速率：4 拍 @90bpm = 2.6667s
    expect(out.notes[0].duration).toBeCloseTo(4 * (60 / 90), 3)
  })

  it('缺锚点的小节按四分音符位置在相邻锚点间插值', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 1,
      bpm: 90,
      anchors: [
        { m: 1, t: 0 },
        { m: 3, t: 6 },
      ],
    }
    const out = applyBeats(tl, beats)
    // m2 = 中点（四分音符位置 4 在 0 与 8 的正中）
    expect(out.measureTimes[1].time).toBeCloseTo(3, 3)
    expect(out.notes[1].time).toBeCloseTo(3, 3)
  })

  it('锚点与曲谱小节对不上号：原样返回（回退恒速）', () => {
    const beats: BeatsFile = { songId: 'x', version: 1, bpm: 90, anchors: [{ m: 99, t: 5 }] }
    expect(applyBeats(tl, beats)).toBe(tl)
  })

  it('beatAnchors 拍级网格：音符按拍级插值而非小节级等分（v4）', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 4,
      bpm: 60,
      anchors: [
        { m: 1, t: 0 },
        { m: 2, t: 4 },
        { m: 3, t: 8 },
      ],
      beatAnchors: [
        { q: 0, t: 0 },
        { q: 1, t: 1 },
        { q: 2, t: 2 },
        { q: 3, t: 3 },
        { q: 4, t: 4 },
        { q: 5, t: 5.5 },
        { q: 6, t: 6.2 },
        { q: 7, t: 7 },
        { q: 8, t: 8 },
        { q: 9, t: 9 },
        { q: 10, t: 10 },
        { q: 11, t: 11 },
      ],
    }
    const out = applyBeats(TL2, beats)
    expect(out.tempo).toBe(60)
    expect(out.secPerQuarter).toBe(1)
    // measureTimes = q2t(quarters)：小节头落在 beat0 = 小节锚点
    expect(out.measureTimes[1].time).toBe(4)
    expect(out.measureTimes[2].time).toBe(8)
    // 终点标记 q=12 越过末点：按末段斜率外推
    expect(out.measureTimes[3].time).toBe(12)
    // q=5.5 → beat5(q=5,t=5.5) 与 beat6(q=6,t=6.2) 之间插值 = 5.85（小节级等分会给 5.5）
    expect(out.notes[1].time).toBeCloseTo(5.85, 5)
    // 时长 = 时值拍数 × 所在段斜率（(6.2-5.5)/1 = 0.7s/拍）
    expect(out.notes[1].duration).toBeCloseTo(0.7, 5)
    // 小节头音符原样落在锚点
    expect(out.notes[2].time).toBe(8)
  })

  it('beatAnchors 结构不合法：回退小节级路径（小节内等分）', () => {
    const base = {
      songId: 'x',
      version: 4,
      bpm: 60,
      anchors: [
        { m: 1, t: 0 },
        { m: 2, t: 4 },
        { m: 3, t: 8 },
      ],
    }
    // 少于 2 项 / 含非有限值 → 拍级网格弃用，q=5.5 回到小节级等分 5.5
    expect(applyBeats(TL2, { ...base, beatAnchors: [{ q: 0, t: 0 }] }).notes[1].time).toBeCloseTo(
      5.5,
      5,
    )
    expect(
      applyBeats(TL2, { ...base, beatAnchors: [{ q: 0, t: 0 }, { q: 1, t: Number.NaN }] }).notes[1]
        .time,
    ).toBeCloseTo(5.5, 5)
  })

  it('applyAnchorOffset：整体平移 + 负向钳 0（manifest.anchorOffsetMs，t_b3080db9）', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 1,
      bpm: 90,
      anchors: [
        { m: 1, t: 0 },
        { m: 2, t: 2.6667 },
        { m: 3, t: 5.3333 },
      ],
    }
    const anchored = applyBeats(tl, beats)
    // 0 = 语义 no-op（返回同一引用，跳过重建）
    expect(applyAnchorOffset(anchored, 0)).toBe(anchored)
    // 正偏移：谱面整体延后，tempo 等其余字段保持
    const late = applyAnchorOffset(anchored, 0.12)
    expect(late.measureTimes[0].time).toBeCloseTo(0.12, 5)
    expect(late.notes[0].time).toBeCloseTo(0.12, 5)
    expect(late.notes[1].time).toBeCloseTo(2.6667 + 0.12, 5)
    expect(late.durationSec).toBeCloseTo(anchored.durationSec + 0.12, 5)
    expect(late.tempo).toBe(anchored.tempo)
    // 负偏移：m1 锚点 0 之前的时刻钳到 0，其余正常平移
    const early = applyAnchorOffset(anchored, -0.05)
    expect(early.measureTimes[0].time).toBe(0)
    expect(early.notes[1].time).toBeCloseTo(2.6667 - 0.05, 5)
    // 终点标记（end:true）同样跟随平移
    expect(early.measureTimes[3].time).toBeCloseTo(anchored.measureTimes[3].time - 0.05, 5)
  })

  it('luv-letter 真实数据：v5b 音符级锚点落地——抽样 10 音对照离线音符级网格（t_76c0cbff / beat_refine）', () => {
    // 新谱带反复记号：与应用 loadSong 一致，先 expandRepeats 再 parse → applyBeats
    const raw = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8').replace(
      /^<\?xml[^>]*\?>/,(m) => m.replace(/'/g, '"'),
    )
    const beats = JSON.parse(
      readFileSync('public/songs/luv-letter/beats.json', 'utf-8'),
    ) as BeatsFile
    // v5b：97 小节锚点不变 + 音符级控制点（442：beat0 偶发 + 吸附成功的音符 onset + 段落边界）
    expect(beats.version).toBe(5)
    expect(beats.anchors).toHaveLength(97)
    expect(beats.beatAnchors!.length).toBeGreaterThan(400)
    const ts = beats.anchors.map((a) => a.t)
    expect(ts[0]).toBeGreaterThanOrEqual(0)
    for (const [i, t] of ts.entries()) {
      if (i === 0) continue
      expect(t, `anchor#${i + 1}`).toBeGreaterThan(ts[i - 1])
    }
    // 控制点 q 严格递增、t 非降（数据合法性）
    const ba = beats.beatAnchors!
    for (const [i, p] of ba.entries()) {
      if (i === 0) continue
      expect(p.q, `ctrlQ#${i}`).toBeGreaterThan(ba[i - 1].q)
      expect(p.t, `ctrlT#${i}`).toBeGreaterThanOrEqual(ba[i - 1].t)
    }
    expect(ba[0].q).toBe(0)
    expect(ba[0].t).toBe(beats.anchors[0].t)

    const pre = parseMusicXml(expandRepeats(raw))
    const out = applyBeats(pre, beats)
    expect(out.tempo).toBe(90)
    expect(out.measureTimes).toHaveLength(98) // 97 播放小节 + 终点标记
    expect(out.measureTimes[0].time).toBeCloseTo(beats.anchors[0].t, 2)
    expect(out.measureTimes[96].time).toBeCloseTo(beats.anchors[96].t, 2)
    // 终点标记：q=388 按末段斜率外推，落回离线标定的 end
    expect(out.measureTimes[97].time).toBeCloseTo(beats.end!, 2)
    // durationSec 同步重映射到锚定系（否则恒速网格旧值会让主循环提前结束）
    expect(out.durationSec).toBeGreaterThanOrEqual(beats.anchors[96].t)

    // 测试内独立实现拍级插值（与 refine_beats.py q2t_beat 同式）作对照基准
    const q2tGrid = (q: number): number => {
      let lo = 0
      if (q >= ba[ba.length - 1].q) lo = ba.length - 2
      else if (q > ba[0].q) {
        let hi = ba.length - 1
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if (ba[mid].q <= q) lo = mid
          else hi = mid
        }
      }
      const a = ba[lo]
      const b = ba[Math.min(lo + 1, ba.length - 1)]
      return a.t + ((b.t - a.t) * (q - a.q)) / Math.max(b.q - a.q, 1e-9)
    }
    // 小节级等分基准（v3 语义）：用于确认拍级路径确实生效
    const q2tMeasure = (q: number): number => {
      const pi = Math.min(Math.floor(q / 4), 96)
      const t0 = ts[pi]
      const t1 = pi + 1 < 97 ? ts[pi + 1] : beats.end!
      return t0 + ((t1 - t0) * (q - 4 * pi)) / 4
    }

    // 抽样 10 音：m1 首音、7 个散点小节首音、m70 全音符（播放序 92 最长音）、m97 终音
    const indexByMeasure = new Map<number, number>()
    pre.measureTimes.forEach((e, i) => {
      if (!e.end && !indexByMeasure.has(e.measure)) indexByMeasure.set(e.measure, i)
    })
    const sampleIdx: number[] = []
    const pickFirst = (mno: number) => {
      const i = pre.notes.findIndex((n) => n.measure === mno)
      expect(i, `m${mno} 存在音符`).toBeGreaterThanOrEqual(0)
      sampleIdx.push(i)
    }
    pickFirst(1)
    for (const mno of [10, 23, 37, 50, 64, 78, 86]) pickFirst(mno)
    const m92 = pre.notes.filter((n) => n.measure === 92)
    expect(m92.length, 'm92').toBeGreaterThan(0)
    const wholeDur = Math.max(...m92.map((n) => n.duration))
    sampleIdx.push(pre.notes.findIndex((n) => n.measure === 92 && n.duration === wholeDur))
    sampleIdx.push(pre.notes.length - 1)
    expect(pre.notes[sampleIdx[9]].measure, '末音在播放序 m97').toBe(97)
    expect(sampleIdx).toHaveLength(10)

    // 每个抽样音：恒速系 → 播放序 q → 拍级网格期望时刻；|实际 - 期望| < 0.05s。
    // q 换算用局部段速率（与实现同式）：真谱带中途变速（印谱 m6 起 86bpm、m67 回 76），
    // 全局 secPerQuarter 直算会把小节内偏移压缩 ~11.5%，拍位错位 0.1-0.3s。
    const localRateOf = (k: number): number => {
      const mt = pre.measureTimes
      return (mt[k + 1].quarters - mt[k].quarters) / Math.max(mt[k + 1].time - mt[k].time, 1e-9)
    }
    const noteQOf = (i: number): number => {
      const n = pre.notes[i]
      const k = indexByMeasure.get(n.measure)!
      return (
        pre.measureTimes[k].quarters +
        (n.time - pre.measureTimes[k].time) * localRateOf(k)
      )
    }
    for (const i of sampleIdx) {
      expect(
        Math.abs(out.notes[i].time - q2tGrid(noteQOf(i))),
        `m${pre.notes[i].measure}#i${i} q=${noteQOf(i)}`,
      ).toBeLessThan(0.05)
    }
    // 拍级路径确实生效：全曲至少一音明显偏离小节级等分（>0.05s）
    let maxDelta = 0
    for (let i = 0; i < pre.notes.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(out.notes[i].time - q2tMeasure(noteQOf(i))))
    }
    expect(maxDelta, '拍级 vs 小节级最大偏差').toBeGreaterThan(0.05)

    // 变速段钉子：q 换算必须用局部速率——若有人改回全局 secPerQuarter 直算，
    // 86 段小节内音符的落点会整体偏移，此处断言立即失败
    let worst = -1
    let worstGap = 0
    let worstLocalQ = 0
    for (let i = 0; i < pre.notes.length; i++) {
      const n = pre.notes[i]
      if (n.measure < 6) continue // m1-m5 为 76bpm 恒速段，两种换算一致
      const k = indexByMeasure.get(n.measure)!
      const dt = n.time - pre.measureTimes[k].time
      const localQ = pre.measureTimes[k].quarters + dt * localRateOf(k)
      const globalQ = pre.measureTimes[k].quarters + dt / pre.secPerQuarter
      const gap = Math.abs(q2tGrid(localQ) - q2tGrid(globalQ))
      if (gap > worstGap) {
        worstGap = gap
        worst = i
        worstLocalQ = localQ
      }
    }
    expect(worstGap, '变速段局部/全局换算分歧').toBeGreaterThan(0.05)
    expect(
      Math.abs(out.notes[worst].time - q2tGrid(worstLocalQ)),
      `变速段音 m${pre.notes[worst].measure}#i${worst} 贴局部换算`,
    ).toBeLessThan(0.02)
    // 音符重映射后不早于其小节锚点（抽查 m36 / m70 首遍 / 末小节 m72 播放序 97）
    for (const mno of [46, 92, 97]) {
      const ns = out.notes.filter((n) => n.measure === mno)
      expect(ns.length, `m${mno}`).toBeGreaterThan(0)
      expect(Math.min(...ns.map((n) => n.time))).toBeGreaterThanOrEqual(
        out.measureTimes[mno - 1].time - 0.01,
      )
    }
  })
})

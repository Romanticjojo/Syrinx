import { describe, expect, it } from 'vitest'
import {
  adjustPoint,
  appendManualOffset,
  baselineTAt,
  buildBeatsExport,
  buildIndexByMeasure,
  buildSyncNotes,
  cpIndexAt,
  deltaMsAt,
  isTuned,
  localRateOf,
  makeQ2T,
  midiName,
  noteQOf,
  resetPoint,
} from './logic'
import type { BeatsFile } from '../score/anchors'
import type { Timeline } from '../types'

/** 2 小节 4/4 假变速替身：m1@76（0.5s/拍）、m2 段 4 拍只占 1s（4 拍/s）——
 *  局部速率换算与全局 secPerQuarter=0.5 直算在此谱上分歧 1 拍 */
const TL: Timeline = {
  tempo: 120,
  secPerQuarter: 0.5,
  durationSec: 5,
  measureTimes: [
    { measure: 1, time: 0, quarters: 0 },
    { measure: 2, time: 2, quarters: 4 },
    { measure: 3, time: 3, quarters: 8 },
    { measure: 4, time: 4, quarters: 12, end: true },
  ],
  notes: [
    { time: 0, duration: 0.5, midi: 72, measure: 1 },
    { time: 2.25, duration: 0.5, midi: 74, measure: 2 },
    { time: 3, duration: 0.5, midi: 76, measure: 3 },
  ],
}

describe('noteQOf 局部段速率换算（禁止全局 secPerQuarter 直算）', () => {
  it('变速段音符按所在段实际速率换算 q', () => {
    const idx = buildIndexByMeasure(TL)
    // m2 内 0.25s 偏移 × 4拍/s = 1 拍 → q=5；全局直算只会给 4.5
    expect(noteQOf(TL, idx, TL.notes[1])).toBeCloseTo(5, 6)
    expect(localRateOf(TL, 1)).toBeCloseTo(4, 6)
  })

  it('buildSyncNotes：全量音符播放序 q 表', () => {
    const notes = buildSyncNotes(TL)
    expect(notes.map((n) => n.q)).toEqual([0, 5, 8])
    expect(notes.map((n) => n.measure)).toEqual([1, 2, 3])
  })
})

describe('makeQ2T 拍级网格插值', () => {
  const grid = [
    { q: 0, t: 0 },
    { q: 4, t: 2 },
    { q: 8, t: 3.5 },
  ]

  it('段内线性插值 + 首/末段斜率外推', () => {
    const q2t = makeQ2T(grid)
    expect(q2t(5).t).toBeCloseTo(2 + 0.375, 6) // (3.5-2)/4=0.375s/拍
    expect(q2t(-2).t).toBeCloseTo(-1, 6) // 首段斜率 0.5 外推
    expect(q2t(10).t).toBeCloseTo(3.5 + 2 * 0.375, 6) // 末段外推
  })

  it('乱序输入先排序；不足 2 点退化为防御性恒速', () => {
    expect(makeQ2T([...grid].reverse())(5).t).toBeCloseTo(2.375, 6)
    expect(makeQ2T([{ q: 1, t: 4 }])(3).t).toBeCloseTo(5, 6)
  })

  it('baselineTAt：基线插值（微调 deltaMs 的基准）', () => {
    expect(baselineTAt(grid, 5)).toBeCloseTo(2.375, 6)
  })
})

describe('adjustPoint 微调：有则改、无则插（计划第 5 条）', () => {
  const baseline = [
    { q: 0, t: 0 },
    { q: 4, t: 2 },
  ]

  it('已有控制点：t 平移 deltaMs', () => {
    const next = adjustPoint(baseline, 4, baseline, 50)
    expect(cpIndexAt(next, 4)).toBeGreaterThanOrEqual(0)
    expect(next.find((p) => p.q === 4)!.t).toBeCloseTo(2.05, 6)
    expect(baseline.find((p) => p.q === 4)!.t).toBe(2) // 基线不被改动
  })

  it('无控制点：按基线插值插入新点并保持 q 递增', () => {
    const next = adjustPoint(baseline, 2, baseline, -100)
    expect(next.map((p) => p.q)).toEqual([0, 2, 4])
    expect(next.find((p) => p.q === 2)!.t).toBeCloseTo(1 + -0.1, 6) // 基线 q=2 → 1s
  })

  it('resetPoint：插入的新点被移除；基线既有点恢复原 t；未调音原样返回', () => {
    const inserted = adjustPoint(baseline, 2, baseline, 50)
    expect(resetPoint(inserted, 2, baseline).map((p) => p.q)).toEqual([0, 4])
    const modified = adjustPoint(baseline, 4, baseline, 50)
    const restored = resetPoint(modified, 4, baseline)
    expect(restored.find((p) => p.q === 4)!.t).toBe(2)
    expect(cpIndexAt(restored, 4)).toBeGreaterThanOrEqual(0) // 点仍在，只是恢复
    expect(resetPoint(baseline, 4, baseline)).toBe(baseline) // 无 diff：引用不变
  })
})

describe('偏差与已调判定', () => {
  const baseline = [
    { q: 0, t: 0 },
    { q: 4, t: 2 },
  ]
  const note = { idx: 0, measure: 1, midi: 72, q: 4 }

  it('deltaMsAt：工作网格 t − 基线插值（毫秒）', () => {
    const working = adjustPoint(baseline, 4, baseline, -50)
    expect(deltaMsAt(working, baseline, 4)).toBeCloseTo(-50, 4)
    expect(deltaMsAt(baseline, baseline, 4)).toBe(0)
  })

  it('isTuned：有控制点且偏离基线才算已调；无控制点为未调', () => {
    expect(isTuned(note, baseline, baseline)).toBe(false)
    expect(isTuned(note, adjustPoint(baseline, 4, baseline, 10), baseline)).toBe(true)
    expect(isTuned({ ...note, q: 2 }, baseline, baseline)).toBe(false)
  })
})

describe('buildBeatsExport 导出（version+1，note 追加，基线不动）', () => {
  const beats: BeatsFile = {
    songId: 'luv-letter',
    version: 6,
    bpm: 90,
    note: 'v6 原始记录',
    anchors: [
      { m: 1, t: 0.2 },
      { m: 2, t: 4.95 },
    ],
    beatAnchors: [
      { q: 0, t: 0.2 },
      { q: 4, t: 4.95 },
    ],
    end: 260,
  }

  it('working 全量写回（含未调点），乱序输入排序，基线对象不被改写', () => {
    const working = [
      { q: 8, t: 8 },
      { q: 4, t: 5.01 },
      { q: 0, t: 0.2 },
    ]
    const out = buildBeatsExport(beats, working, 1, '2026-08-31')
    expect(out.version).toBe(7)
    expect(out.note).toContain('v6 原始记录')
    expect(out.note).toContain('人工微调 1 处')
    expect(out.beatAnchors!.map((p) => p.q)).toEqual([0, 4, 8])
    expect(out.beatAnchors!.find((p) => p.q === 4)!.t).toBeCloseTo(5.01, 6)
    expect(out.anchors).toEqual(beats.anchors)
    expect(out.end).toBe(260)
    expect(beats.version).toBe(6) // 原文件不被改写
  })
})

describe('manual_offsets 日志（追加式，回放取每个 q 最新条目）', () => {
  it('追加条目：deltaMs 记录相对基线的总偏移（毫秒，2 位小数）', () => {
    const baseline = [
      { q: 0, t: 0 },
      { q: 4, t: 2 },
    ]
    const after1 = adjustPoint(baseline, 4, baseline, 50)
    const log1 = appendManualOffset([], 4, after1, baseline, 'm2')
    const after2 = adjustPoint(after1, 4, baseline, 50)
    const log2 = appendManualOffset(log1, 4, after2, baseline, 'm2')
    expect(log2).toHaveLength(2) // 追加不覆盖
    expect(log2[0]).toMatchObject({ q: 4, deltaMs: 50, note: 'm2' })
    expect(log2[1]).toMatchObject({ q: 4, deltaMs: 100, note: 'm2' })
    expect(typeof log2[1].ts).toBe('number')
  })
})

it('midiName / 类型冒烟', () => {
  expect(midiName(60)).toBe('C4')
  expect(midiName(61)).toBe('C#4')
  expect(midiName(73)).toBe('C#5')
})

import { describe, expect, it } from 'vitest'
import type { Timeline } from '../types'
import { extractPitchTrack, scoreAgainst, timelineUpTo } from './compare'

const SR = 44100

/** AudioBuffer 替身：0-1s 441Hz、1-2s 静音、2-3s 220Hz */
function makeBuffer() {
  const data = new Float32Array(3 * SR)
  for (let i = 0; i < SR; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 441 * i) / SR)
  for (let i = 2 * SR; i < 3 * SR; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
  return { sampleRate: SR, getChannelData: () => data }
}

/** 时间轴替身：3 个音符——441 实测对 A4(440)、静音段 miss、220 实测对 A2(110) 差八度 */
const timeline: Timeline = {
  durationSec: 3,
  secPerQuarter: 0.5,
  tempo: 120,
  notes: [
    { time: 0, duration: 1, midi: 69, measure: 1 }, // A4 = 440Hz
    { time: 1, duration: 1, midi: 60, measure: 1 }, // 落在静音段 → miss
    { time: 2, duration: 1, midi: 45, measure: 2 }, // A2 = 110Hz
  ],
  measureTimes: [
    { measure: 1, time: 0, quarters: 0 },
    { measure: 2, time: 2, quarters: 4 },
    { measure: 3, time: 3, quarters: 6, end: true },
  ],
}

describe('extractPitchTrack', () => {
  const track = extractPitchTrack(makeBuffer())

  it('首秒检出 441Hz（±2Hz）', () => {
    const first = track.filter((p) => p.time < 0.9)
    expect(first.length).toBeGreaterThan(20)
    expect(first.every((p) => Math.abs(p.hz - 441) < 2)).toBe(true)
  })

  it('静音段（1-2s）无轨迹点', () => {
    expect(track.filter((p) => p.time > 1.05 && p.time < 1.95)).toHaveLength(0)
  })

  it('第三秒检出 220Hz（±2Hz）', () => {
    const last = track.filter((p) => p.time > 2.05 && p.time < 2.95)
    expect(last.length).toBeGreaterThan(20)
    expect(last.every((p) => Math.abs(p.hz - 220) < 2)).toBe(true)
  })
})

describe('scoreAgainst', () => {
  const result = scoreAgainst(extractPitchTrack(makeBuffer()), timeline)

  it('音符窗口取实测中位频率：441 vs 440 → 约 4 音分，算准', () => {
    expect(result.notes[0].measuredHz).toBeGreaterThan(439)
    expect(result.notes[0].measuredHz).toBeLessThan(443)
    expect(result.notes[0].cents).toBeCloseTo(1200 * Math.log2(441 / 440), 0)
    expect(result.notes[0].inTune).toBe(true)
  })

  it('差一个八度：220 vs 110 → 约 1200 音分，不算准', () => {
    expect(result.notes[2].cents).toBeCloseTo(1200, -1)
    expect(result.notes[2].inTune).toBe(false)
  })

  it('无实测样本的音符记 miss（measuredHz/cents 为 null）', () => {
    expect(result.notes[1].measuredHz).toBeNull()
    expect(result.notes[1].cents).toBeNull()
    expect(result.notes[1].inTune).toBe(false)
  })

  it('统计：noteCount 只计有实测的音符，inTuneRatio=0.5，avgAbsCents≈602', () => {
    expect(result.stats.noteCount).toBe(2)
    expect(result.stats.inTuneRatio).toBeCloseTo(0.5, 5)
    expect(result.stats.avgAbsCents).toBeCloseTo(602, 0)
  })

  it('annotatedTrack：实测点带相对当前目标音的音分（A4 段 ≈4，A2 段 ≈1200）', () => {
    const inA4 = result.annotatedTrack.filter((p) => p.time > 0.1 && p.time < 0.9)
    expect(inA4.length).toBeGreaterThan(10)
    expect(inA4.every((p) => Math.abs(p.cents - 1200 * Math.log2(441 / 440)) < 1)).toBe(true)
    const inA2 = result.annotatedTrack.filter((p) => p.time > 2.1 && p.time < 2.9)
    expect(inA2.every((p) => Math.abs(p.cents - 1200) < 1)).toBe(true)
  })

  it('评分窗口掐头 15% 去尾 10%：起音/收尾段帧不进中位数', () => {
    // 音符 0-1s：窗口应为 [0.15, 0.9)。给掐头区 0.05s、去尾区 0.95s 各一个 880Hz 干扰点，
    // 窗口中段 0.4s/0.6s 两个 440Hz 点 -> 中位数必须是 440
    const track = [
      { time: 0.05, hz: 880, cents: 0 },
      { time: 0.4, hz: 440, cents: 0 },
      { time: 0.6, hz: 440, cents: 0 },
      { time: 0.95, hz: 880, cents: 0 },
    ]
    const r = scoreAgainst(track, timeline)
    expect(r.notes[0].measuredHz).toBe(440)
    expect(r.notes[0].inTune).toBe(true)
  })

  it('全部帧落在跳过区 -> 该音符 miss，且不进统计分母', () => {
    const track = [
      { time: 1.05, hz: 440, cents: 0 }, // 音符2(1-2s) 的掐头区内（<1.15）
      { time: 2.95, hz: 440, cents: 0 }, // 音符3(2-3s) 的去尾区内（>=2.9）
    ]
    const r = scoreAgainst(track, timeline)
    expect(r.notes[1].measuredHz).toBeNull()
    expect(r.stats.noteCount).toBe(0)
    expect(r.stats.inTuneRatio).toBe(0)
  })
})

describe('timelineUpTo（停止演奏截断口径）', () => {
  it('停止时刻在中段：只保留 time < stopSec 的音符', () => {
    const t = timelineUpTo(timeline, 1.5)
    expect(t.notes.map((n) => n.midi)).toEqual([69, 60])
  })

  it('停止时刻不晚于首音符起点：音符清空（不抛异常）', () => {
    const t = timelineUpTo(timeline, 0)
    expect(t.notes).toEqual([])
  })

  it('停止时刻不早于全曲时长：返回原引用（自然结束零开销不截断）', () => {
    expect(timelineUpTo(timeline, 3)).toBe(timeline)
    expect(timelineUpTo(timeline, 99)).toBe(timeline)
  })

  it('与 scoreAgainst 组合：截断后第三秒音符不进统计', () => {
    // stopSec=2.0（第三音符 2.0s 起未被演奏）：只留前两个音符
    const r = scoreAgainst(extractPitchTrack(makeBuffer()), timelineUpTo(timeline, 2))
    expect(r.notes).toHaveLength(2)
    expect(r.notes.map((n) => n.note.midi)).toEqual([69, 60])
    expect(r.stats.noteCount).toBeLessThanOrEqual(2)
  })
})

import { describe, expect, it } from 'vitest'
import { timeStretch } from './timestretch'

/** 保调时域拉伸单测：时长按 1/tempo 收缩/拉长，基频不变。
 *  若实现误用重采样（playbackRate 式），440Hz 在 tempo 1.25 下会变成 550Hz——断言足以击穿。
 *  48k 用例是 soundtouchjs 0.3.0 离线路径缺陷（静音边界 → 220Hz 次谐波）的固化回归。 */
const freqOf = (data: Float32Array, sr: number, fromSec: number, toSec: number): number => {
  const from = Math.floor(fromSec * sr), to = Math.floor(toSec * sr)
  let crossings = 0
  for (let i = from + 1; i < to; i++) {
    if ((data[i - 1]! <= 0) !== (data[i]! < 0)) crossings++
  }
  return crossings / 2 / ((to - from) / sr)
}

const peakOf = (data: Float32Array, sr: number, fromSec: number, toSec: number): number => {
  const from = Math.floor(fromSec * sr), to = Math.floor(toSec * sr)
  let peak = 0
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]!))
  return peak
}

const sineAt = (sr: number, freq: number, startSec: number, endSec: number, amp: number, totalSec: number): Float32Array<ArrayBuffer> => {
  const buf = new Float32Array(Math.round(totalSec * sr))
  for (let i = Math.round(startSec * sr); i < Math.round(endSec * sr); i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  }
  return buf
}

describe('timeStretch 保调时域拉伸（WSOLA）', () => {
  it('tempo 1.25：时长收缩到 1/1.25 且基频保持 440Hz（重采样会变 550Hz）', () => {
    const sr = 8000
    const input = [sineAt(sr, 440, 0, 2, 0.6, 2)]
    const out = timeStretch(input, 0, 2 * sr, 1.25, sr)
    expect(out).toHaveLength(1)
    const seconds = out[0]!.length / sr
    expect(seconds).toBeGreaterThan(1.5)
    expect(seconds).toBeLessThanOrEqual(1.6 + 0.01)
    expect(Math.abs(freqOf(out[0]!, sr, 0.2, 1.4) - 440)).toBeLessThan(5)
    expect(out[0]!.every(Number.isFinite)).toBe(true)
  })

  it('tempo 0.8：时长拉长到 1/0.8 且基频保持（重采样会变 352Hz）', () => {
    const sr = 8000
    const input = [sineAt(sr, 440, 0, 2, 0.6, 2)]
    const out = timeStretch(input, 0, 2 * sr, 0.8, sr)
    const seconds = out[0]!.length / sr
    expect(seconds).toBeGreaterThan(2.4)
    expect(seconds).toBeLessThanOrEqual(2.5 + 0.01)
    expect(Math.abs(freqOf(out[0]!, sr, 0.3, 2.2) - 440)).toBeLessThan(5)
  })

  it('只消费 [startFrame, startFrame+frameCount) 窗口：窗口外样本不进入输出', () => {
    const sr = 8000
    const buffer = sineAt(sr, 440, 1, 3, 0.6, 3)
    const out = timeStretch([buffer], sr, 2 * sr, 1.25, sr)
    const seconds = out[0]!.length / sr
    expect(seconds).toBeGreaterThan(1.5)
    expect(seconds).toBeLessThanOrEqual(1.6 + 0.01)
    // 窗口内容是正弦：输出必须有能量（若误从 0 读则整段静音）
    expect(peakOf(out[0]!, sr, 0.3, 1.3)).toBeGreaterThan(0.3)
    expect(Math.abs(freqOf(out[0]!, sr, 0.3, 1.3) - 440)).toBeLessThan(5)
  })

  it('立体声两声道各自保调且互不串轨', () => {
    const sr = 8000
    const input = [sineAt(sr, 440, 0, 2, 0.6, 2), sineAt(sr, 880, 0, 2, 0.6, 2)]
    const out = timeStretch(input, 0, 2 * sr, 1.25, sr)
    expect(out).toHaveLength(2)
    expect(Math.abs(freqOf(out[0]!, sr, 0.2, 1.4) - 440)).toBeLessThan(5)
    expect(Math.abs(freqOf(out[1]!, sr, 0.2, 1.4) - 880)).toBeLessThan(5)
  })

  it('48k 长窗静音边界（soundtouchjs 回归）：音区 440Hz、静音区零污染、脉冲对齐', () => {
    const sr = 48000
    const buffer = sineAt(sr, 440, 7, 10, 0.45, 10)
    buffer[Math.round(1 * sr)] = 0.9
    const out = timeStretch([buffer], 0, 10 * sr, 1.25, sr)
    const seconds = out[0]!.length / sr
    expect(seconds).toBeGreaterThan(7.9)
    expect(seconds).toBeLessThanOrEqual(8 + 0.01)
    // 音区：7~10s 映射到 5.6~8s
    expect(Math.abs(freqOf(out[0]!, sr, 6, 7.8) - 440)).toBeLessThan(5)
    // 静音区（输入 4.5~6.5s → 输出 3.6~5.2s）不被污染
    expect(peakOf(out[0]!, sr, 3.6, 5.2)).toBeLessThan(0.02)
    // 脉冲 1s → 0.8s（±80ms 交叉淡化弥散容差）
    let peak = 0, peakAt = -1
    for (let i = 0; i < out[0]!.length; i++) {
      const a = Math.abs(out[0]![i]!)
      if (a > peak) { peak = a; peakAt = i }
    }
    expect(Math.abs(peakAt / sr - 0.8)).toBeLessThan(0.08)
  })
})

import { describe, expect, it } from 'vitest'
import { computeRmsEnvelope, sampleBlockMeans } from './waveform'

/** [T6b] 能量块进度条纯函数单测：RMS 桶引擎保留（块宽改 ~0.5s 由调用方传入），
 *  新增视口均分块取桶 RMS 均值聚合；仅服务连续包络的平滑/归一/最大值采样
 *  （smoothEnvelope/normalizeGain/sampleEnvelopeView）随包络退役同步删除 */

describe('computeRmsEnvelope 桶能量（RMS）', () => {
  it('恒定电平信号：每桶 RMS = 电平值；总桶数 = ceil(len/step)', () => {
    const s = new Float32Array(1024).fill(0.5)
    const env = computeRmsEnvelope(s, 512)
    expect(env.length).toBe(2)
    expect(env[0]).toBeCloseTo(0.5, 6)
    expect(env[1]).toBeCloseTo(0.5, 6)
  })

  it('正弦波 RMS ≈ 幅度/√2（能量口径而非峰值口径；非整周期桶有纹波）', () => {
    const s = new Float32Array(512 * 40)
    for (let i = 0; i < s.length; i++) s[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 44100)
    for (const v of computeRmsEnvelope(s, 512)) expect(v).toBeCloseTo(0.8 / Math.SQRT2, 1)
  })

  it('单采样尖峰被能量平均压掉：512 桶内一个 1.0 → 1/√512（min/max 口径会是 1.0）', () => {
    const s = new Float32Array(512)
    s[100] = 1
    expect(computeRmsEnvelope(s, 512)[0]).toBeCloseTo(1 / Math.sqrt(512), 6)
  })

  it('尾部不足一桶按实际样本数；零信号桶为 0；非法步长返回空包络', () => {
    const env = computeRmsEnvelope(new Float32Array(600).fill(0.3), 512)
    expect(env.length).toBe(2)
    expect(env[1]).toBeCloseTo(0.3, 6)
    expect(computeRmsEnvelope(new Float32Array(1024), 512)[0]).toBe(0)
    expect(computeRmsEnvelope(new Float32Array(8), 0).length).toBe(0)
  })
})

describe('sampleBlockMeans 视口均分块聚合（桶 RMS 均值）', () => {
  const env = new Float32Array([0.1, 0.4, 0.2, 0.9, 0.3])

  it('每块恰一桶：块值 = 桶 RMS；半开区间不渗邻桶（块尾 1.0 不含桶 1）', () => {
    expect([...sampleBlockMeans(env, 1, 0, 5, 5)]).toEqual([...env])
    // 10 块 × 0.5s：第 0/1 块 [0,0.5)/[0.5,1.0) 都只覆盖桶 0；第 2 块 [1.0,1.5) 起才是桶 1
    const v = sampleBlockMeans(env, 1, 0, 5, 10)
    expect(v[0]).toBeCloseTo(0.1, 6)
    expect(v[1]).toBeCloseTo(0.1, 6)
    expect(v[2]).toBeCloseTo(0.4, 6)
  })

  it('宽视图多桶聚合取均值（能量块进度条口径，而非旧包络的最大值）', () => {
    expect(sampleBlockMeans(env, 1, 0, 5, 1)[0]).toBeCloseTo(1.9 / 5, 6)
    expect(sampleBlockMeans(env, 1, 0, 4, 2)[1]).toBeCloseTo(0.55, 6) // [2,4) 覆盖桶 2、3
  })

  it('深缩放（视口窄于单桶）收敛到覆盖桶，不丢能量', () => {
    expect(sampleBlockMeans(env, 1, 0.55, 0.6, 1)[0]).toBeCloseTo(0.1, 6)
    expect(sampleBlockMeans(env, 1, 3.7, 3.9, 1)[0]).toBeCloseTo(0.9, 6)
  })

  it('空包络/非法参数返回全零块', () => {
    expect([...sampleBlockMeans(new Float32Array(0), 1, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleBlockMeans(env, 0, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleBlockMeans(env, 1, 5, 5, 3)]).toEqual([0, 0, 0])
    expect(sampleBlockMeans(env, 1, 0, 5, 0).length).toBe(0)
  })
})

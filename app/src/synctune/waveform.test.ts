import { describe, expect, it } from 'vitest'
import { computeRmsEnvelope, normalizeGain, sampleEnvelopeView, smoothEnvelope } from './waveform'

/** T6 波形可读性纯函数单测：RMS 桶能量/居中滑动平均/峰值增益归一/视口像素列
 *  能量聚合。口径用例对应看板根因——低电平伴奏（0.1-0.3）+ 单采样尖峰（高频
 *  毛刺替身）+ 宽视图多桶聚合 */

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

describe('smoothEnvelope 居中滑动平均（边界收缩窗）', () => {
  it('恒定包络不变；win<2 原样返回拷贝（不改输入）', () => {
    for (const v of smoothEnvelope(new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]), 5))
      expect(v).toBeCloseTo(0.2, 6)
    const src = new Float32Array([0.1, 0.5, 0.9])
    const same = smoothEnvelope(src, 1)
    expect([...same]).toEqual([...src])
    expect(same).not.toBe(src)
  })

  it('孤立尖峰被摊平：峰值降、邻桶抬（边界用收缩窗）', () => {
    const sm = smoothEnvelope(new Float32Array([0.1, 0.1, 1, 0.1, 0.1]), 5)
    expect(sm[2]).toBeCloseTo(1.4 / 5, 6) // j∈[0,4] 全窗：0.1×4+1
    expect(sm[1]).toBeCloseTo(1.3 / 4, 6) // j∈[0,3] 边界收缩窗四值
    expect(Math.max(...sm)).toBeLessThan(1)
  })
})

describe('normalizeGain 峰值归一化增益', () => {
  it('全局 max × gain = target（伴奏低电平 0.1-0.3 拉到 85%）', () => {
    const g = normalizeGain(new Float32Array([0.05, 0.18, 0.3, 0.12, 0.02]), 0.85)
    expect(0.3 * g).toBeCloseTo(0.85, 6)
  })

  it('全静音/极小包络返回 1（除零保护，不产 Infinity/NaN）', () => {
    expect(normalizeGain(new Float32Array(8), 0.85)).toBe(1)
    expect(normalizeGain(new Float32Array([1e-9]), 0.85)).toBe(1)
  })
})

describe('sampleEnvelopeView 视口按像素列聚合（能量最大值）', () => {
  const env = new Float32Array([0.1, 0.4, 0.2, 0.9, 0.3])

  it('每列恰一桶：列值 = 桶 RMS；半开区间不渗邻桶（列尾 1.0 不含桶 1）', () => {
    expect([...sampleEnvelopeView(env, 1, 0, 5, 5)]).toEqual([...env])
    // 10 列 × 0.5s：第 0/1 列 [0,0.5)/[0.5,1.0) 都只覆盖桶 0；第 2 列 [1.0,1.5) 起才是桶 1
    const v = sampleEnvelopeView(env, 1, 0, 5, 10)
    expect(v[0]).toBeCloseTo(0.1, 6)
    expect(v[1]).toBeCloseTo(0.1, 6)
    expect(v[2]).toBeCloseTo(0.4, 6)
  })

  it('宽视图多桶聚合取能量最大值（R3：能量视角而非 min/max）', () => {
    expect(sampleEnvelopeView(env, 1, 0, 5, 1)[0]).toBeCloseTo(0.9, 6)
    expect(sampleEnvelopeView(env, 1, 0, 4, 2)[1]).toBeCloseTo(0.9, 6) // [2,4) 覆盖桶 2、3
  })

  it('深缩放（视口窄于单桶）收敛到覆盖桶，不丢包络', () => {
    expect(sampleEnvelopeView(env, 1, 0.55, 0.6, 1)[0]).toBeCloseTo(0.1, 6)
    expect(sampleEnvelopeView(env, 1, 3.7, 3.9, 1)[0]).toBeCloseTo(0.9, 6)
  })

  it('空包络/非法参数返回全零列', () => {
    expect([...sampleEnvelopeView(new Float32Array(0), 1, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleEnvelopeView(env, 0, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleEnvelopeView(env, 1, 5, 5, 3)]).toEqual([0, 0, 0])
    expect(sampleEnvelopeView(env, 1, 0, 5, 0).length).toBe(0)
  })
})

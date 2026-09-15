import { describe, expect, it } from 'vitest'
import { REC_GAIN_MAX, volToGain } from './volCurve'

/** 录音播放感知响度曲线（t_2264e5ba）：滑杆 0-1 → WebAudio 增益。
 *  平方近似等响感知 + 满格 x3 增益补偿直采录音电平偏低（用户实测反馈初始音量小）。 */
describe('volToGain：录音滑杆 → 增益', () => {
  it('0 静音、满格给满增益', () => {
    expect(volToGain(0)).toBe(0)
    expect(volToGain(1)).toBe(REC_GAIN_MAX)
  })

  it('平方感知曲线：半格输出 1/4 满增益（小音量段更细腻）', () => {
    expect(volToGain(0.5)).toBeCloseTo(REC_GAIN_MAX / 4)
  })

  it('越界输入钳到 [0,1] 再映射', () => {
    expect(volToGain(-0.5)).toBe(0)
    expect(volToGain(1.7)).toBe(REC_GAIN_MAX)
  })

  it('单调不减（不会越拖越小声再回头）', () => {
    let prev = -1
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const g = volToGain(v)
      expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
  })
})

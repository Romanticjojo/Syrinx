import { describe, expect, it } from 'vitest'
import { yinDetect } from './yin'

const SR = 44100

/** 合成正弦波（与真实演奏一样带幅度包络意义不大，纯音即可验证周期估计） */
const sine = (hz: number, n = 2048, sr = SR): Float32Array => {
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) buf[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr)
  return buf
}

/** 确定性伪白噪声（固定种子，避免测试随机翻转） */
const noise = (n = 2048): Float32Array => {
  let seed = 42
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buf[i] = (seed / 0x3fffffff - 1) * 0.5
  }
  return buf
}

describe('yinDetect', () => {
  it('检测 441Hz 正弦波（±2Hz 内）且清晰度高', () => {
    const r = yinDetect(sine(441), SR)
    expect(r).not.toBeNull()
    expect(r!.hz).toBeGreaterThan(439)
    expect(r!.hz).toBeLessThan(443)
    expect(r!.clarity).toBeGreaterThan(0.9)
  })

  it('检测 220Hz 正弦波（长笛低音区，±2Hz 内）', () => {
    const r = yinDetect(sine(220), SR)
    expect(r).not.toBeNull()
    expect(r!.hz).toBeGreaterThan(218)
    expect(r!.hz).toBeLessThan(222)
  })

  it('白噪声无周期 → 返回 null', () => {
    expect(yinDetect(noise(), SR)).toBeNull()
  })

  it('静音（全零）→ 返回 null', () => {
    expect(yinDetect(new Float32Array(2048), SR)).toBeNull()
  })
})

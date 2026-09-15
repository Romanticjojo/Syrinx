/**
 * YIN 音高检测（纯函数，无浏览器依赖，可离线跑）。
 * 算法：差分函数 → 累积均值归一化 → 绝对阈值找首个局部最小 →
 * 抛物线插值精化周期 → sampleRate/tau 得基频。
 * 长笛为单音乐器，YIN 足够；检测器接口化后可替换 CREPE/tfjs（后续）。
 *
 * 差分与归一化按周期递增计算；找到第一个阈值谷就停止，不计算后续无用周期。
 * 可用 minHz 限定最大周期。默认仍支持完整帧可解析的音域。
 */

export interface YinResult {
  hz: number
  /** 1 - d'(tau)，越高越确定（纯音 ≈ 1） */
  clarity: number
}

/** 静音判定：RMS 低于此值不做周期分析 */
const SILENCE_RMS = 1e-4

export function yinDetect(
  buf: Float32Array,
  sampleRate: number,
  threshold = 0.12,
  minHz = 0,
): YinResult | null {
  const W = Math.floor(buf.length / 2)
  if (W < 16) return null

  // 静音检查
  let energy = 0
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i]
  if (Math.sqrt(energy / buf.length) < SILENCE_RMS) return null

  // 多留一个周期供抛物线插值；长笛无需搜索帧长一半的所有周期。
  const maxTau = Math.min(W - 1, minHz > 0 ? Math.ceil(sampleRate / minHz) + 1 : W - 1)
  let runSum = 0
  let previous2 = 1
  let previous = 1
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau]
      sum += diff * diff
    }
    runSum += sum
    const normalized = runSum === 0 ? 1 : (sum * tau) / runSum
    // 同原算法：首个低于阈值的局部最小。音域截断处仍下降时不伪造谷点。
    if (tau >= 3 && previous < threshold && (normalized >= previous || tau === W - 1)) {
      const denom = previous2 + normalized - 2 * previous
      const shift = denom !== 0 ? (0.5 * (previous2 - normalized)) / denom : 0
      return { hz: sampleRate / (tau - 1 + shift), clarity: 1 - previous }
    }
    previous2 = previous
    previous = normalized
  }
  return null
}

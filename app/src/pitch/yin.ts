/**
 * YIN 音高检测（纯函数，无浏览器依赖，可离线跑）。
 * 算法：差分函数 → 累积均值归一化 → 绝对阈值找首个局部最小 →
 * 抛物线插值精化周期 → sampleRate/tau 得基频。
 * 长笛为单音乐器，YIN 足够；检测器接口化后可替换 CREPE/tfjs（后续）。
 *
 * 复杂度 O(W²)（W=帧长一半）：离线分析 40s 录音约数百帧，秒级完成，MVP 可接受；
 * 若要实时再换 FFT 差分优化。
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
): YinResult | null {
  const W = Math.floor(buf.length / 2)
  if (W < 16) return null

  // 静音检查
  let energy = 0
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i]
  if (Math.sqrt(energy / buf.length) < SILENCE_RMS) return null

  // 差分函数 d(tau) = Σ (x[i] - x[i+tau])²
  const d = new Float64Array(W)
  for (let tau = 1; tau < W; tau++) {
    let sum = 0
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau]
      sum += diff * diff
    }
    d[tau] = sum
  }

  // 累积均值归一化 d'(tau) = d(tau) · tau / Σ_{j<=tau} d(j)
  const dp = new Float64Array(W)
  dp[0] = 1
  let runSum = 0
  for (let tau = 1; tau < W; tau++) {
    runSum += d[tau]
    dp[tau] = runSum === 0 ? 1 : (d[tau] * tau) / runSum
  }

  // 绝对阈值下首个谷：低于 threshold 后走到局部最小
  let tau = -1
  for (let t = 2; t < W - 1; t++) {
    if (dp[t] < threshold) {
      while (t + 1 < W - 1 && dp[t + 1] < dp[t]) t++
      tau = t
      break
    }
  }
  if (tau === -1) return null

  // 抛物线插值精化周期
  const y0 = dp[tau - 1]
  const y1 = dp[tau]
  const y2 = dp[tau + 1]
  const denom = y0 + y2 - 2 * y1
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  const tauRefined = tau + shift

  return { hz: sampleRate / tauRefined, clarity: 1 - y1 }
}

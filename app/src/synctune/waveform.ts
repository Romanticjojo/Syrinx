/**
 * [T6b] 能量块进度条纯函数：T6 连续包络链（平滑/归一/最大值采样）随包络退役，
 * 只保留 RMS 桶引擎（预计算块宽改 ~0.5s，由调用方按采样率换算传入）并新增
 * 视口均分块均值聚合（进度条口径：能量轮廓而非逐像素包络）：
 *  1) computeRmsEnvelope：单声道样本 → 每桶 RMS 能量（能量口径天然抑毛刺）
 *  2) sampleBlockMeans：[t0,t1] 均分 blocks 块，每块取覆盖桶 RMS 的均值
 */

/** 单声道样本 → 每桶 RMS 能量包络：bucket i 覆盖 [i·step, (i+1)·step) 样本，
 *  尾部不满桶按实际样本数归一；空输入/非法步长返回空包络 */
export function computeRmsEnvelope(samples: Float32Array, step: number): Float32Array {
  if (step <= 0) return new Float32Array(0)
  const n = Math.ceil(samples.length / step)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const end = Math.min(samples.length, (i + 1) * step)
    let sum = 0
    for (let j = i * step; j < end; j++) sum += samples[j] * samples[j]
    env[i] = Math.sqrt(sum / (end - i * step))
  }
  return env
}

/** 能量块聚合：[t0,t1] 均分 blocks 块，每块取覆盖桶 RMS 的均值（进度条口径
 *  ——能量轮廓，区别于 T6 包络的列内最大值）；块为半开区间 [ta,tb)——桶范围
 *  floor(ta/step)..ceil(tb/step)-1，相邻块不互相渗桶，均值只计 [0,n) 内有效
 *  桶；视口窄于单桶时收敛到最近桶（深缩放不丢能量）；空包络/非法参数返回
 *  全零块 */
export function sampleBlockMeans(
  env: Float32Array,
  stepSec: number,
  t0: number,
  t1: number,
  blocks: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(blocks)))
  const n = env.length
  if (n === 0 || stepSec <= 0 || t1 <= t0) return out
  const span = t1 - t0
  for (let x = 0; x < out.length; x++) {
    const ta = t0 + (x / out.length) * span
    const tb = ta + span / out.length
    let b0 = Math.floor(ta / stepSec)
    const b1 = Math.min(Math.ceil(tb / stepSec) - 1, n - 1)
    if (b1 < b0) b0 = Math.max(0, b1)
    let sum = 0
    let cnt = 0
    for (let b = b0; b <= b1; b++) {
      if (b < 0 || b >= n) continue
      sum += env[b]
      cnt++
    }
    out[x] = cnt > 0 ? sum / cnt : 0
  }
  return out
}

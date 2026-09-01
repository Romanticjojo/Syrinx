/**
 * 波形可读性纯函数集（T6 降噪/增益自适应）：
 * 旧绘制直接用 min/max 包络，三重根因——伴奏录音电平低（包络趴 mid 线像噪声
 * 毛刺）、min/max 把高频毛刺全画出来、每桶独立取值相邻跳变观感「碎」。
 * 三轮解法对应四个纯函数（不触 DOM/AudioBuffer，vitest 直测）：
 *  1) computeRmsEnvelope：min/max → 每桶 RMS 能量（感知加权，毛刺天然抑制）
 *  2) smoothEnvelope：3~5 桶滑动平均（相邻桶跳变抹平，能量轮廓连续）
 *  3) normalizeGain：全局峰值归一化（增益自适应，峰值拉到目标高度）
 *  4) sampleEnvelopeView：视口按像素列聚合，列内取桶 RMS 最大值（宽视图
 *     总览的能量视角；窄视口退化为最近桶，深缩放不丢包络）
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

/** 居中滑动平均平滑：窗口 win（<2 视为不平滑，原样拷贝），两端收缩窗口按
 *  实际样本数归一；返回新数组，不改输入 */
export function smoothEnvelope(env: Float32Array, win: number): Float32Array {
  const n = env.length
  const out = new Float32Array(n)
  if (win < 2) {
    out.set(env)
    return out
  }
  const half = Math.floor(win / 2)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += env[j]
    out[i] = sum / (hi - lo + 1)
  }
  return out
}

/** 峰值归一化增益：target / 全局最大桶值（增益自适应——低电平伴奏拉到目标
 *  高度）；全零/极小包络返回 1（除零保护，不产 Infinity/NaN） */
export function normalizeGain(env: Float32Array, target = 0.85): number {
  let mx = 0
  for (let i = 0; i < env.length; i++) if (env[i] > mx) mx = env[i]
  return mx > 1e-6 ? target / mx : 1
}

/** 视口采样：[t0,t1] 均分 columns 列，列覆盖的桶取 RMS 最大值（能量视角聚
 *  合）；列为半开区间 [ta,tb)——桶范围 floor(ta/step)..ceil(tb/step)-1，相邻
 *  列不互相渗桶；视口窄于单桶时收敛到最近桶（深缩放不丢包络）；空包络/
 *  非法参数返回全零列 */
export function sampleEnvelopeView(
  env: Float32Array,
  stepSec: number,
  t0: number,
  t1: number,
  columns: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(columns)))
  const n = env.length
  if (n === 0 || stepSec <= 0 || t1 <= t0) return out
  const span = t1 - t0
  for (let x = 0; x < out.length; x++) {
    const ta = t0 + (x / out.length) * span
    const tb = ta + span / out.length
    let b0 = Math.floor(ta / stepSec)
    const b1 = Math.min(Math.ceil(tb / stepSec) - 1, n - 1)
    if (b1 < b0) b0 = Math.max(0, b1)
    let mx = 0
    for (let b = b0; b <= b1; b++) {
      if (b < 0 || b >= n) continue
      if (env[b] > mx) mx = env[b]
    }
    out[x] = mx
  }
  return out
}

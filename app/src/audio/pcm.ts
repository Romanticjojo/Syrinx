/**
 * 录音 PCM 纯函数：分片拼接、RMS 诊断、线性插值重采样、导出 WAV 组装。
 * 从 recorder.ts 写入支路抽出，供单测（不依赖真实麦克风/AudioContext）。
 */
import { encodeWav } from './wav'

/** 导出目标采样率：32kHz 单声道 16-bit ≈ 64KB/s（一分钟约 4MB），
 *  对长笛音域（≤2.5kHz，远低于 16kHz 奈奎斯特）无信息损失 */
export const EXPORT_RATE = 32000
/** 整段 RMS 低于此值视为静音（诊断标记，不阻断产出） */
export const SILENT_RMS = 1e-4

/** 按序拼接多段 Float32；空输入返回长度 0 的新数组 */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Float32Array(n)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 方均根电平（0..1） */
export function rmsOf(buf: Float32Array): number {
  if (!buf.length) return 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
  return Math.sqrt(sum / buf.length)
}

/** 线性插值重采样：srcRate===dstRate 时原样返回（调用方传入的即拼接新数组，可安全共享）。
 *  输出长度 = ceil(src.length * dstRate / srcRate)；末端下标夹取（保持最后样本）。 */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src
  if (!src.length) return new Float32Array(0)
  const out = new Float32Array(Math.ceil((src.length * dstRate) / srcRate))
  const ratio = srcRate / dstRate
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.min(Math.floor(pos), src.length - 1)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0]! * (1 - frac) + src[i1]! * frac
  }
  return out
}

export interface RecordingWav {
  blob: Blob
  /** 整段 RMS < SILENT_RMS 时 true：疑似麦克风静音，供上层提示诊断 */
  silent: boolean
}

/** 采集分片 -> 拼接 -> RMS 诊断 -> 32kHz 单声道 WAV */
export function buildRecordingWav(chunks: readonly Float32Array[], srcRate: number): RecordingWav {
  const pcm = resampleLinear(concatFloat32(chunks), srcRate, EXPORT_RATE)
  const silent = rmsOf(pcm) < SILENT_RMS
  const blob = encodeWav({
    sampleRate: EXPORT_RATE,
    numberOfChannels: 1,
    length: pcm.length,
    getChannelData: () => pcm,
  })
  return { blob, silent }
}

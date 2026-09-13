import type { PitchPoint } from '../types'
import { yinDetect } from './yin'

export interface PitchAudioBuffer {
  sampleRate: number
  getChannelData(channel: number): Float32Array
}

export interface ExtractOptions {
  /** 分析帧长（秒），默认 2048 样本 @44.1kHz */
  frameSec?: number
  /** 帧移（秒），默认约半帧重叠 */
  hopSec?: number
  /** 低于此清晰度的帧丢弃 */
  clarityMin?: number
  /** 录音原始秒数的整体平移；变速映射由调用方统一处理。 */
  offsetSec?: number
}

export const MIN_HZ = 180
export const MAX_HZ = 2500

const DEFAULT_EXTRACT_OPTS: Required<ExtractOptions> = {
  frameSec: 0.0464,
  hopSec: 0.0232,
  clarityMin: 0.6,
  offsetSec: 0,
}

/** 同步、Worker 和分片回退共用逐帧计算，保留完整评分样本。 */
export class PitchExtraction {
  readonly points: PitchPoint[] = []
  private readonly data: Float32Array
  private readonly sampleRate: number
  private readonly options: Required<ExtractOptions>
  private readonly frameN: number
  private readonly hopN: number
  private readonly frameCount: number
  private completedFrames = 0

  constructor(data: Float32Array, sampleRate: number, options: ExtractOptions = {}) {
    this.data = data
    this.sampleRate = sampleRate
    this.options = { ...DEFAULT_EXTRACT_OPTS, ...options }
    this.frameN = Math.max(64, Math.round(this.options.frameSec * sampleRate))
    this.hopN = Math.max(1, Math.round(this.options.hopSec * sampleRate))
    this.frameCount = Math.max(0, Math.floor((data.length - this.frameN) / this.hopN) + 1)
  }

  get done(): boolean { return this.completedFrames >= this.frameCount }
  get progress(): number { return this.frameCount ? this.completedFrames / this.frameCount : 1 }

  advance(): void {
    if (this.done) return
    const start = this.completedFrames * this.hopN
    const result = yinDetect(this.data.subarray(start, start + this.frameN), this.sampleRate, 0.12, MIN_HZ)
    if (result && result.clarity >= this.options.clarityMin && result.hz >= MIN_HZ && result.hz <= MAX_HZ) {
      this.points.push({ time: start / this.sampleRate + this.options.offsetSec, hz: result.hz, cents: 0 })
    }
    this.completedFrames++
  }
}

export function extractPitchTrack(buffer: PitchAudioBuffer, options: ExtractOptions = {}): PitchPoint[] {
  const extraction = new PitchExtraction(buffer.getChannelData(0), buffer.sampleRate, options)
  while (!extraction.done) extraction.advance()
  return extraction.points
}

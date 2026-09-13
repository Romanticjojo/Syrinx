import type { Take } from '../types'
import { timeStretch } from './timestretch'

/** 混音时间轴规划（纯函数，单位秒） */
export interface MixPlan {
  /** 混音总时长 = 录音实长（伴奏窗口较短时自然结束，不截断录音） */
  recDuration: number
  /** 伴奏源窗口起点（伴奏时间轴 = take.startSec） */
  accStart: number
  /** 伴奏源消费速率 = takeRate：混音局部 t ↔ 伴奏 accStart + t·accRate（与对照播放 seek 公式一致） */
  accRate: number
  /** 伴奏源窗口时长（录音映射 ∩ 伴奏实长） */
  accDur: number
}

/** takeRate 口径与回放页一致：有限且落在 [0.5, 1.5] 才生效 */
export function mixRateOf(playbackRate?: number): number {
  return playbackRate !== undefined && Number.isFinite(playbackRate) && playbackRate >= 0.5 && playbackRate <= 1.5
    ? playbackRate
    : 1
}

/**
 * 规划混音时间轴映射。伴奏缺失（accDurationSec 无效）返回 null，调用方据此禁用混音；
 * 录音实长无效时回退 take 元数据（stopSec-startSec）/takeRate。
 */
export function planMix(
  take: Pick<Take, 'startSec' | 'stopSec' | 'playbackRate'>,
  recDurationSec: number,
  accDurationSec: number | null,
): MixPlan | null {
  if (accDurationSec === null || !Number.isFinite(accDurationSec) || accDurationSec < 0) return null
  const accRate = mixRateOf(take.playbackRate)
  const accStart = Number.isFinite(take.startSec) ? Math.max(0, take.startSec) : 0
  const recDuration = Number.isFinite(recDurationSec) && recDurationSec > 0
    ? recDurationSec
    : Math.max(0, (Number.isFinite(take.stopSec) ? take.stopSec : accStart) - accStart) / accRate
  return {
    recDuration,
    accStart,
    accRate,
    accDur: Math.max(0, Math.min(recDuration * accRate, accDurationSec - accStart)),
  }
}

/** 把伴奏窗口保调拉伸成可从 0 播的 AudioBuffer（混音局部时间轴） */
function stretchAccompaniment(ctx: BaseAudioContext, acc: AudioBuffer, plan: MixPlan): AudioBuffer {
  const channelCount = Math.min(2, acc.numberOfChannels)
  const channels: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < channelCount; c++) channels.push(acc.getChannelData(c))
  const start = Math.floor(plan.accStart * acc.sampleRate)
  const frames = Math.min(acc.length - start, Math.ceil(plan.accDur * acc.sampleRate))
  const stretched = timeStretch(channels, start, frames, plan.accRate, acc.sampleRate)
  const buffer = ctx.createBuffer(stretched.length, stretched[0]!.length, ctx.sampleRate)
  stretched.forEach((data, channel) => buffer.copyToChannel(data, channel))
  return buffer
}

/**
 * 离线渲染「录音+伴奏」混音：时长 = 录音实长，两轨各 1.0 定增益
 * （不接监听链路 recGraph/volCurve——那是演奏页增益曲线，混音不需要）。
 * 输出采样率/声道跟随伴奏（录音 32k 单声道由 WebAudio 自动重采样/上混）。
 *
 * takeRate≠1 时伴奏窗口先经 WSOLA 保调拉伸（preservesPitch 同款铁律），
 * 禁止 AudioBufferSourceNode.playbackRate（重采样变调）。
 */
export async function renderMix(plan: MixPlan, recBuffer: AudioBuffer, accBuffer: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(
    Math.max(1, Math.min(2, accBuffer.numberOfChannels)),
    Math.max(1, Math.ceil(plan.recDuration * accBuffer.sampleRate)),
    accBuffer.sampleRate,
  )

  const recGain = ctx.createGain()
  recGain.gain.value = 1
  recGain.connect(ctx.destination)
  const recSource = ctx.createBufferSource()
  recSource.buffer = recBuffer
  recSource.connect(recGain)
  recSource.start(0)

  if (plan.accDur > 0 && plan.accStart < accBuffer.duration) {
    const accGain = ctx.createGain()
    accGain.gain.value = 1
    accGain.connect(ctx.destination)
    const accSource = ctx.createBufferSource()
    if (plan.accRate === 1) {
      accSource.buffer = accBuffer
      accSource.connect(accGain)
      accSource.start(0, plan.accStart)
    } else {
      accSource.buffer = stretchAccompaniment(ctx, accBuffer, plan)
      accSource.connect(accGain)
      accSource.start(0)
    }
  }

  return ctx.startRendering()
}

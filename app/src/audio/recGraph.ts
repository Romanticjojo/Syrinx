/** 录音元素 → WebAudio 增益图接线（t_2264e5ba）
 *  HTMLAudioElement.volume 上限 1，直采录音电平偏低（用户实测满格仍小声），
 *  回放卡把录音 <audio> 经 MediaElementSource 接进 audioEngine 的 AudioContext，
 *  用 GainNode 按 volToGain 曲线放大（满格 x3）。
 *  createMediaElementSource 每元素只允许调用一次——本模块用 WeakMap 保证幂等；
 *  接线失败（如跨域媒体限制）返回 null，调用方回退 element.volume 直控。 */
/** 接线所需的最小 AudioContext 形状（依赖收窄，测试可注入浅 mock） */
export interface RecGraphCtx {
  createMediaElementSource(el: HTMLAudioElement): { connect(node: unknown): void }
  createGain(): RecGainNode
  destination: unknown
}

export interface RecGainNode {
  gain: { value: number }
  connect(node: unknown): void
}

const gains = new WeakMap<HTMLAudioElement, RecGainNode>()

export function ensureRecGain(el: HTMLAudioElement, ctx: RecGraphCtx): RecGainNode | null {
  const cached = gains.get(el)
  if (cached) return cached
  try {
    const src = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    src.connect(gain)
    gain.connect(ctx.destination)
    gains.set(el, gain)
    return gain
  } catch (e: unknown) {
    console.warn(`[recGraph] 录音增益接线失败，回退 element.volume 直控：${e instanceof Error ? e.message : e}`)
    return null
  }
}

/** 仅供验证脚本/测试读取已接线的录音增益（无头断言用，业务代码勿用） */
export const _recGainForTest = (el: HTMLAudioElement | null): RecGainNode | null =>
  el ? (gains.get(el) ?? null) : null

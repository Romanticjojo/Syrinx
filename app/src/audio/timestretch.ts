/**
 * 保调时域拉伸（自研 WSOLA：Hann 交叉淡化 + 互相关块匹配）。
 *
 * 铁律背景：对照播放走 HTMLMediaElement preservesPitch=true，混音必须同款保调；
 * AudioBufferSourceNode.playbackRate 是重采样变调（±5% ≈ ±84 音分），禁止用于此。
 * （曾试 soundtouchjs 0.3.0：其 dist 版 Stretch 在 48k 长窗/静音边界输入下输出
 * 220Hz 次谐波与噪声，quickSeek/setParameters 均无法挽救，验证记录见
 * D:/LLM_work/result-mix-download/，故按任务书回退路径自实现。）
 *
 * 算法：分析帧按 hopA = hopS·tempo 名义推进，输出帧按 hopS 推进（时序映射
 * input u ↔ output (u-start)/tempo 无漂移）；每帧在 ±SEEK 内选与已写输出尾部
 * 互相关最大的偏移，用升余弦交叉淡化衔接，消除块边界相位跳变。
 */

/** 帧长/重叠/搜索窗（毫秒）；相关计算按 ~12kHz 抽取、搜索步进 2 样本控算力 */
const FRAME_MS = 50
const OVERLAP_RATIO = 0.75
const SEEK_MS = 6
const CORR_WINDOW_MS = 12
const CORR_TARGET_SR = 12000
const SEARCH_STEP = 2

/**
 * @param channels planar 输入（1-2 声道，>2 只处理前两路）
 * @param startFrame 窗口起点（含）
 * @param frameCount 窗口帧数；窗口外读取按 0 处理（不读进后续内容）
 * @param tempo 变速率：>1 更快更短，音高不变（调用方保证 [0.5, 1.5]）
 * @param sampleRate 输入采样率（帧参数按毫秒换算，与采样率无关）
 * @returns 拉伸后的 planar 通道（声道数与输入一致，长度 = ceil(frameCount/tempo)）
 */
export function timeStretch(
  channels: Float32Array<ArrayBuffer>[],
  startFrame: number,
  frameCount: number,
  tempo: number,
  sampleRate: number,
): Float32Array<ArrayBuffer>[] {
  const active = channels.slice(0, 2)
  const start = Math.max(0, Math.min(startFrame, active[0]!.length))
  const end = Math.min(active[0]!.length, start + Math.max(0, frameCount))
  const frames = end - start
  if (frames <= 0 || !Number.isFinite(tempo) || tempo <= 0) {
    return channels.map(() => new Float32Array(0))
  }

  const frame = Math.max(32, Math.round((sampleRate * FRAME_MS) / 1000))
  const overlap = Math.round(frame * OVERLAP_RATIO)
  const hopOut = frame - overlap
  const seek = Math.round((sampleRate * SEEK_MS) / 1000)
  const corrWin = Math.min(overlap, Math.round((sampleRate * CORR_WINDOW_MS) / 1000))
  const corrStep = Math.max(1, Math.round(sampleRate / CORR_TARGET_SR))
  const lead = active[0]!

  const outLength = Math.ceil(frames / tempo)
  const outs = channels.map(() => new Float32Array(outLength))
  // 窗口外一律读 0：窗口语义严格（不把窗口后的曲子混进成品）
  const read = (data: Float32Array, index: number): number =>
    index >= start && index < end ? data[index]! : 0

  let nominal = start // 分析位置名义值（浮点累计，无舍入漂移）
  for (let outPos = 0; outPos < outLength; outPos += hopOut) {
    const base = Math.round(nominal)

    if (outPos === 0) {
      // 首帧直写（无前文可对齐），头部短淡入避免从音乐中段切入的爆点
      const fadeIn = Math.min(hopOut, outLength)
      for (let i = 0; i < Math.min(frame, outLength); i++) {
        const g = i < fadeIn ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn) : 1
        for (let c = 0; c < active.length; c++) {
          outs[c]![outPos + i] = read(active[c]!, base + i) * g
        }
      }
    } else {
      // WSOLA：在 ±seek 内选与已写输出尾部互相关最大的偏移（模板取 0 声道）
      let bestOffset = 0
      let bestScore = -Infinity
      for (let offset = -seek; offset <= seek; offset += SEARCH_STEP) {
        const cand = base + offset
        let dot = 0
        for (let i = 0; i < corrWin; i += corrStep) {
          dot += outs[0]![outPos + i]! * read(lead, cand + i)
        }
        if (dot > bestScore) {
          bestScore = dot
          bestOffset = offset
        }
      }
      const at = base + bestOffset
      for (let i = 0; i < overlap && outPos + i < outLength; i++) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (overlap + 1))
        for (let c = 0; c < active.length; c++) {
          const out = outs[c]!
          out[outPos + i] = out[outPos + i]! * (1 - g) + read(active[c]!, at + i) * g
        }
      }
      for (let i = overlap; i < frame && outPos + i < outLength; i++) {
        for (let c = 0; c < active.length; c++) {
          outs[c]![outPos + i] = read(active[c]!, at + i)
        }
      }
    }

    nominal += hopOut * tempo
  }

  // 尾部短淡出，避免窗口末端硬切爆点
  const fadeOut = Math.min(Math.round(sampleRate * 0.005), Math.floor(outLength / 2))
  for (let i = 0; i < fadeOut; i++) {
    const g = 1 - i / fadeOut
    for (const out of outs) out[outLength - 1 - i] = out[outLength - 1 - i]! * g
  }
  return outs
}

import type { Timeline } from '../types'

/**
 * 伴奏程序化合成：曲谱音符事件 → OfflineAudioContext 渲染 AudioBuffer。
 * 谱/音同源（同一 Timeline），天然对齐，零外部素材依赖。
 * 正式伴奏由 Song Pack 的 accompanimentUrl 提供，此实现为占位与兜底。
 */

// 合成配方参数（集中便于调优）
const RECIPE = {
  attack: 0.04, // 主旋律起音
  release: 0.3, // 主旋律收尾
  detuneCents: 4, // 双振荡器合唱感
  padOctave: -12, // 低音 pad 相对根音降八度
  padLowpass: 400, // pad 低通截止 Hz
  padGain: 0.16,
  noiseCenter: 800, // 氛围噪声带通中心
  noiseGain: 0.015,
  delayTime: 0.28, // 反馈延迟混响感
  delayFeedback: 0.25,
  delayWet: 0.18,
  masterGain: 0.8,
  tailSec: 1.5, // 尾音长度
  leadGain: 0.22,
}

const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/**
 * 合成整曲伴奏。夜曲风格：
 * - 主旋律：triangle 双振荡器（detune 合唱感）+ ADSR
 * - 低音 pad：每小节根音 sine + lowpass，全小节长
 * - 氛围：白噪声 bandpass 气声
 * - 空间感：旋律总线 feedback delay
 */
export async function synthAccompaniment(
  timeline: Timeline,
  sampleRate = 44100,
): Promise<AudioBuffer> {
  const totalSec = timeline.durationSec + RECIPE.tailSec
  const ctx = new OfflineAudioContext(2, Math.ceil(totalSec * sampleRate), sampleRate)

  const master = ctx.createGain()
  master.gain.value = RECIPE.masterGain
  master.connect(ctx.destination)

  // 旋律总线：dry + delay wet
  const leadBus = ctx.createGain()
  leadBus.gain.value = 1
  leadBus.connect(master)

  const delay = ctx.createDelay(1)
  delay.delayTime.value = RECIPE.delayTime
  const feedback = ctx.createGain()
  feedback.gain.value = RECIPE.delayFeedback
  const wet = ctx.createGain()
  wet.gain.value = RECIPE.delayWet
  leadBus.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(master)

  // 主旋律：每音符一对 detune 振荡器
  for (const note of timeline.notes) {
    if (note.midi <= 0) continue // 和声外的占位音（休止不进 notes，防御式跳过）
    const freq = midiToFreq(note.midi)
    const start = note.time
    const dur = Math.max(note.duration, 0.05)
    const amp = ctx.createGain()
    // ADSR：attack 线性起音，release 指数收尾
    amp.gain.setValueAtTime(0.0001, start)
    amp.gain.linearRampToValueAtTime(RECIPE.leadGain, start + RECIPE.attack)
    amp.gain.setValueAtTime(RECIPE.leadGain, start + Math.max(dur - RECIPE.release, start + RECIPE.attack))
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur + RECIPE.release)
    amp.connect(leadBus)

    for (const cents of [0, RECIPE.detuneCents]) {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = freq
      osc.detune.value = cents
      osc.connect(amp)
      osc.start(start)
      osc.stop(start + dur + RECIPE.release + 0.02)
    }
  }

  // 低音 pad：每小节根音（该小节首个音符），全小节长
  const measures = new Map<number, { rootMidi: number; start: number; end: number }>()
  for (const mt of timeline.measureTimes) {
    const start = mt.time
    const idx = timeline.measureTimes.indexOf(mt)
    const next = timeline.measureTimes[idx + 1]
    const end = next ? next.time : timeline.durationSec
    const first = timeline.notes.find((n) => n.measure === mt.measure && n.midi > 0)
    if (first) measures.set(mt.measure, { rootMidi: first.midi, start, end })
  }
  for (const m of measures.values()) {
    const dur = Math.max(m.end - m.start, 0.1)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = midiToFreq(m.rootMidi + RECIPE.padOctave)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = RECIPE.padLowpass
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(0.0001, m.start)
    amp.gain.linearRampToValueAtTime(RECIPE.padGain, m.start + 0.3)
    amp.gain.setValueAtTime(RECIPE.padGain, m.start + Math.max(dur - 0.3, 0.3))
    amp.gain.exponentialRampToValueAtTime(0.0001, m.start + dur)
    osc.connect(lp)
    lp.connect(amp)
    amp.connect(master)
    osc.start(m.start)
    osc.stop(m.start + dur + 0.05)
  }

  // 氛围：整曲白噪声 → bandpass 气声
  const noiseLen = Math.ceil(totalSec * sampleRate)
  const noiseBuf = ctx.createBuffer(1, noiseLen, sampleRate)
  const data = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseLen; i++) data[i] = Math.random() * 2 - 1
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuf
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = RECIPE.noiseCenter
  bp.Q.value = 0.8
  const noiseGain = ctx.createGain()
  noiseGain.gain.value = RECIPE.noiseGain
  noise.connect(bp)
  bp.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(0)
  noise.stop(totalSec)

  return ctx.startRendering()
}

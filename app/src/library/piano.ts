import type { Timeline } from '../types'
import { MAX_NOTES, MAX_SECONDS } from './score-parse'

const SAMPLE_RATE = 24000
const yieldThread = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消钢琴合成', 'AbortError') }

/** Deterministic local additive 合成钢琴, no samples, network, or live audio context.
 * Mono 24 kHz, at most 172.8 MB for the 30-minute limit. Only one output allocation.
 */
export async function synthesizePiano(timeline: Timeline, signal?: AbortSignal): Promise<AudioBuffer> {
  abort(signal)
  if (!Number.isFinite(timeline.durationSec) || timeline.durationSec <= 0 || timeline.durationSec > MAX_SECONDS) throw new Error('钢琴合成曲长须大于零且不超过 30 分钟')
  if (timeline.notes.length > MAX_NOTES * 4) throw new Error('钢琴合成音符数超过限制')
  for (const n of timeline.notes) if (![n.time, n.duration, n.midi].every(Number.isFinite) || n.time < 0 || n.duration <= 0 || n.time + n.duration > timeline.durationSec + .001 || !Number.isInteger(n.midi) || n.midi < 0 || n.midi > 127) throw new Error('钢琴合成音符数据无效')
  // Bound adversarial dense input's work as well as its allocation.
  const work = timeline.notes.reduce((sum, n) => sum + Math.min(n.duration + .12, 12) * SAMPLE_RATE, 0)
  if (work > 400_000_000) throw new Error('乐谱过于密集，请减少钢琴声部后重试')
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: Math.ceil(timeline.durationSec * SAMPLE_RATE), sampleRate: SAMPLE_RATE })
  const output = buffer.getChannelData(0)
  const harmonics = [1, .48, .23, .12, .06, .035]
  let processed = 0
  await yieldThread(); abort(signal)
  for (const note of timeline.notes) {
    abort(signal)
    const start = Math.round(note.time * SAMPLE_RATE), held = Math.min(note.duration, 12), length = Math.min(Math.ceil((held + .12) * SAMPLE_RATE), output.length - start)
    const frequency = 440 * 2 ** ((note.midi - 69) / 12)
    const decay = 1.4 + Math.max(0, note.midi - 48) / 30
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE
      const attack = Math.min(1, t / .006)
      const release = t > held ? Math.max(0, 1 - (t - held) / .12) ** 2 : 1
      let value = 0
      for (let h = 0; h < harmonics.length; h++) {
        const hz = frequency * (h + 1) * Math.sqrt(1 + .00004 * h * h)
        if (hz >= SAMPLE_RATE * .45) break
        value += harmonics[h] * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * decay * (1 + .32 * h))
      }
      output[start + i] += .18 * value * attack * release
      if (++processed >= 32768) { processed = 0; await yieldThread(); abort(signal) }
    }
  }
  // Gentle saturation prevents clipping of large chords without pumping gain.
  for (let i = 0; i < output.length; i++) {
    output[i] = .98 * Math.tanh(output[i])
    if (i % 131072 === 0) { await yieldThread(); abort(signal) }
  }
  abort(signal)
  return buffer
}

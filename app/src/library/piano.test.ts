import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizePiano } from './piano'
import type { Timeline } from '../types'
const timeline = (durationSec = 1): Timeline => ({ durationSec, tempo: 60, secPerQuarter: 1, measureTimes: [], notes: [{ time: 0, duration: .8, midi: 69, measure: 1 }] })
// happy-dom has no native AudioBuffer; only its storage primitive is replaced.
class TestBuffer {
  sampleRate: number; length: number; duration: number; numberOfChannels: number; data: Float32Array[]
  constructor(options: AudioBufferOptions) { this.sampleRate = options.sampleRate; this.length = options.length; this.duration = this.length / this.sampleRate; this.numberOfChannels = options.numberOfChannels!; this.data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length)) }
  getChannelData(i: number) { return this.data[i] }
}
afterEach(() => vi.unstubAllGlobals())
describe('offline 合成钢琴', () => {
  it('produces a bounded, nonzero, decaying deterministic pitched waveform', async () => {
    vi.stubGlobal('AudioBuffer', TestBuffer)
    const buffer = await synthesizePiano(timeline())
    const data = buffer.getChannelData(0)
    expect(buffer.duration).toBe(1)
    expect(data.every(Number.isFinite)).toBe(true)
    const peak = data.reduce((p, x) => Math.max(p, Math.abs(x)), 0)
    expect(peak).toBeGreaterThan(.03); expect(peak).toBeLessThanOrEqual(.98)
    const rms = (start: number, end: number) => Math.sqrt(data.slice(start, end).reduce((sum, x) => sum + x*x, 0) / (end - start))
    expect(rms(200, 2000)).toBeGreaterThan(rms(14000, 17000))
    // Fundamental correlation at A4 must beat a deliberately wrong frequency.
    const energy = (hz: number) => { let re = 0, im = 0; for (let i = 1000; i < 8000; i++) { re += data[i] * Math.cos(2*Math.PI*hz*i/buffer.sampleRate); im += data[i] * Math.sin(2*Math.PI*hz*i/buffer.sampleRate) } return re*re+im*im }
    expect(energy(440)).toBeGreaterThan(energy(370) * 10)
    expect((await synthesizePiano(timeline())).getChannelData(0)).toEqual(data)
  })
  it('keeps silent mode full-length and honors cancellation before and during rendering', async () => {
    vi.stubGlobal('AudioBuffer', TestBuffer)
    const silent = await synthesizePiano({ ...timeline(2), notes: [] })
    expect(silent.duration).toBe(2); expect(silent.getChannelData(0).every(v => v === 0)).toBe(true)
    const controller = new AbortController(); controller.abort()
    await expect(synthesizePiano(timeline(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const active = new AbortController()
    const pending = synthesizePiano({ ...timeline(30), notes: [{ time: 0, duration: 30, midi: 45, measure: 1 }] }, active.signal)
    setTimeout(() => active.abort(), 0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('rejects excessive duration and invalid note ranges before allocating', async () => {
    vi.stubGlobal('AudioBuffer', TestBuffer)
    await expect(synthesizePiano(timeline(1801))).rejects.toThrow(/30 分钟/)
    await expect(synthesizePiano({ ...timeline(), notes: [{ time: -1, duration: 2, midi: 69, measure: 1 }] })).rejects.toThrow(/音符/)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractPitchTrack, extractPitchTrackAsync } from './compare'

function fluteBuffer(seconds = 0.3, sampleRate = 44100, hz = 261.625565) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) {
    const phase = 2 * Math.PI * hz * i / sampleRate
    data[i] = 0.4 * Math.sin(phase) + 0.15 * Math.sin(phase * 2) + 0.04 * Math.sin(phase * 3)
  }
  return { sampleRate, getChannelData: () => data }
}

afterEach(() => vi.unstubAllGlobals())

describe('asynchronous pitch extraction fallback', () => {
  it('reports monotonic completed-frame progress and keeps every measured point', async () => {
    vi.stubGlobal('Worker', undefined)
    const progress: number[] = []
    const buffer = fluteBuffer()
    const result = await extractPitchTrackAsync(buffer, {
      sliceMs: 0.001,
      offsetSec: 7.5,
      onProgress: fraction => progress.push(fraction),
    })
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress.some(fraction => fraction > 0 && fraction < 1)).toBe(true)
    expect(progress.every((fraction, i) => i === 0 || fraction >= progress[i - 1])).toBe(true)
    expect(result).toEqual(extractPitchTrack(buffer, { offsetSec: 7.5 }))
    expect(result!.length).toBe(11)
    expect(result![0].time).toBe(7.5)
    expect(result!.every(point => Math.abs(1200 * Math.log2(point.hz / 261.625565)) < 3)).toBe(true)
  })

  it('resolves null when aborted during progress and never publishes completion', async () => {
    vi.stubGlobal('Worker', undefined)
    const controller = new AbortController()
    const progress: number[] = []
    const result = await extractPitchTrackAsync(fluteBuffer(), {
      sliceMs: 0.001,
      signal: controller.signal,
      onProgress: fraction => {
        progress.push(fraction)
        if (fraction > 0) controller.abort()
      },
    })
    expect(result).toBeNull()
    expect(progress.at(-1)).toBeLessThan(1)
    const count = progress.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(progress).toHaveLength(count)
  })

  it('does not read audio after cancellation before starting', async () => {
    const controller = new AbortController()
    controller.abort()
    let read = false
    const result = await extractPitchTrackAsync({
      sampleRate: 44100,
      getChannelData: () => { read = true; return new Float32Array(0) },
    }, { signal: controller.signal })
    expect(result).toBeNull()
    expect(read).toBe(false)
  })

  it('reports completion for audio shorter than one frame', async () => {
    const progress: number[] = []
    expect(await extractPitchTrackAsync(fluteBuffer(0.01), {
      onProgress: fraction => progress.push(fraction),
    })).toEqual([])
    expect(progress.at(-1)).toBe(1)
  })
})

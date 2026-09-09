import { describe, expect, it, vi } from 'vitest'
import type { SongManifest, Timeline } from '../types'
import { createAccompanimentLoader } from './accompaniment'

const timeline: Timeline = {
  durationSec: 4,
  secPerQuarter: 1,
  tempo: 60,
  notes: [],
  measureTimes: [],
}

const song = (id: string, accompanimentUrl = `/songs/${id}/accompaniment.mp3`): SongManifest => ({
  id,
  title: id,
  composer: 'Composer',
  difficulty: 1,
  durationLabel: '0:04',
  keyLabel: 'C major',
  description: 'A test song',
  tags: ['sample'],
  scoreUrl: `/songs/${id}/score.musicxml`,
  accompanimentUrl,
  accent: '#5fb8a8',
  backgroundTheme: 'lumiere',
  bpm: 60,
})

const buffer = (duration: number) => ({ duration }) as AudioBuffer

describe('accompaniment loader', () => {
  it('deduplicates concurrent preload and load through one fetch and decode', async () => {
    let release!: (value: ArrayBuffer) => void
    const download = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { release = resolve }))
    const decode = vi.fn(async () => buffer(4))
    const loader = createAccompanimentLoader({ download, decode, synth: vi.fn(), resolveUrl: (url) => url })
    const manifest = song('one')

    const preloaded = loader.load(manifest, timeline)
    const enteredPerform = loader.load(manifest, timeline)
    release(new ArrayBuffer(8))

    await expect(preloaded).resolves.toEqual({ buffer: expect.any(Object), synthesized: false })
    await expect(enteredPerform).resolves.toEqual({ buffer: expect.any(Object), synthesized: false })
    expect(download).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('aborts the previous download and discards an obsolete decoded result after switching songs', async () => {
    const signals: AbortSignal[] = []
    const releases = new Map<string, (value: ArrayBuffer) => void>()
    const download = vi.fn((url: string, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<ArrayBuffer>((resolve) => releases.set(url, resolve))
    })
    const decode = vi.fn(async (data: ArrayBuffer) => buffer(data.byteLength))
    const loader = createAccompanimentLoader({ download, decode, synth: vi.fn(), resolveUrl: (url) => url })

    const oldLoad = loader.load(song('old'), timeline)
    const currentLoad = loader.load(song('current'), timeline)
    expect(signals[0].aborted).toBe(true)
    releases.get('/songs/old/accompaniment.mp3')!(new ArrayBuffer(1))
    releases.get('/songs/current/accompaniment.mp3')!(new ArrayBuffer(2))

    await expect(oldLoad).rejects.toMatchObject({ name: 'AbortError' })
    await expect(currentLoad).resolves.toMatchObject({ buffer: { duration: 2 }, synthesized: false })
    await expect(loader.load(song('current'), timeline)).resolves.toMatchObject({ buffer: { duration: 2 } })
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('falls back to synthesis after a download failure when a timeline is available', async () => {
    const synthesized = buffer(5.5)
    const loader = createAccompanimentLoader({
      download: vi.fn(async () => { throw new Error('offline') }),
      decode: vi.fn(),
      synth: vi.fn(async () => synthesized),
      resolveUrl: (url) => url,
    })

    await expect(loader.load(song('fallback'), timeline)).resolves.toEqual({ buffer: synthesized, synthesized: true })
  })

  it('removes failed work from the cache so the same song can retry', async () => {
    let attempts = 0
    const loader = createAccompanimentLoader({
      download: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('offline')
        return new ArrayBuffer(3)
      }),
      decode: vi.fn(async () => buffer(3)),
      synth: vi.fn(async () => { throw new Error('synthesis unavailable') }),
      resolveUrl: (url) => url,
    })

    await expect(loader.load(song('retry'), timeline)).rejects.toThrow('synthesis unavailable')
    await expect(loader.load(song('retry'), timeline)).resolves.toMatchObject({ buffer: { duration: 3 }, synthesized: false })
    expect(attempts).toBe(2)
  })

  it('cancels pending preview work but retains a completed current-song buffer', async () => {
    let release!: (value: ArrayBuffer) => void
    const download = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { release = resolve }))
    const loader = createAccompanimentLoader({
      download,
      decode: vi.fn(async () => buffer(4)),
      synth: vi.fn(),
      resolveUrl: (url) => url,
    })
    const manifest = song('preview')

    const pending = loader.load(manifest, timeline)
    loader.cancelPending(manifest.id)
    release(new ArrayBuffer(4))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const completed = loader.load(manifest, timeline)
    release(new ArrayBuffer(4))
    await completed
    loader.cancelPending(manifest.id)
    await loader.load(manifest, timeline)
    expect(download).toHaveBeenCalledTimes(2)
  })
})

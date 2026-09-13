import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSong, loadSong } from './index'
import { loadAccompaniment, cancelPendingAccompaniment } from '../audio/accompaniment'
import { clearRuntimeSong, registerRuntimeSong } from './runtime'
import type { SongManifest, Timeline } from '../types'

const timeline: Timeline = { durationSec: 2, tempo: 120, secPerQuarter: 0.5, notes: [], measureTimes: [{ measure: 1, time: 0, quarters: 0 }, { measure: 2, time: 2, quarters: 4, end: true }] }
const manifest: SongManifest = { id: 'personal:one', source: 'personal', title: '本地小谱', composer: '', difficulty: 1, durationLabel: '0:02', keyLabel: 'C 大调', description: '', tags: [], scoreUrl: 'personal:one', accent: '#5fb8a8', backgroundTheme: 'lumiere', bpm: 120, cursorMode: 'score' }
afterEach(() => { clearRuntimeSong(); vi.restoreAllMocks() })

describe('personal runtime source', () => {
  it('resolves score and accompaniment locally with no HTTP fallback', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const buffer = { duration: 2 } as AudioBuffer
    registerRuntimeSong({ manifest, xml: '<score-partwise/>', timeline, loadAudio: async () => buffer, cancelAudio: () => {} })
    expect(getSong(manifest.id)?.title).toBe('本地小谱')
    expect((await loadSong(manifest)).timeline.durationSec).toBe(2)
    expect((await loadAccompaniment(manifest, timeline)).buffer).toBe(buffer)
    expect(network).not.toHaveBeenCalled()
  })
  it('releases the previous active source and rejects stale score requests rather than selecting curated audio', async () => {
    let cancelled = false
    registerRuntimeSong({ manifest, xml: '<score-partwise/>', timeline, loadAudio: async () => ({ duration: 2 }) as AudioBuffer, cancelAudio: () => { cancelled = true } })
    registerRuntimeSong({ manifest: { ...manifest, id: 'personal:two' }, xml: '<score-partwise/>', timeline, loadAudio: async () => ({ duration: 2 }) as AudioBuffer, cancelAudio: () => {} })
    expect(cancelled).toBe(true)
    expect(getSong(manifest.id)).toBeUndefined()
    await expect(loadSong(manifest)).rejects.toThrow('重新')
    await expect(loadAccompaniment(manifest)).rejects.toThrow('重新')
  })
  it('cancels current local generation on ordinary departure', () => {
    let cancelled = false
    registerRuntimeSong({ manifest, xml: '', timeline, loadAudio: async () => ({}) as AudioBuffer, cancelAudio: () => { cancelled = true } })
    cancelPendingAccompaniment(manifest.id)
    expect(cancelled).toBe(true)
  })
})

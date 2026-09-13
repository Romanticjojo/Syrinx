import { afterEach, describe, expect, it, vi } from 'vitest'
import { activatePersonalScore } from './bridge'
import { prepareScore } from './score'
import { clearRuntimeSong } from '../songs/runtime'
import type { PersonalScore } from './types'
const synth = vi.hoisted(() => vi.fn().mockResolvedValue({ duration: 2 }))
vi.mock('./piano', () => ({ synthesizePiano: synth }))
const xml = '<score-partwise><part-list><score-part id="F"><part-name>Flute</part-name></score-part><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="F"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part><part id="P"><measure number="1"><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part></score-partwise>'
const record: PersonalScore = { id: 'bridge', fingerprint: 'a'.repeat(64), originalXml: xml, title: 'Test', composer: '', tags: [], favorite: false, createdAt: 1, updatedAt: 1, lastOpenedAt: null, settings: { melodyPartId: 'F', pianoPartIds: ['P'], mode: 'original', style: 'block', tonic: null, minor: false } }
afterEach(() => { clearRuntimeSong(); synth.mockClear() })
describe('personal audio entry boundary', () => {
  it.each(['none', 'generated'] as const)('rejects %s before any audio synthesis', mode => {
    const changed = { ...record, settings: { ...record.settings, mode } }
    const prepared = prepareScore(xml, changed.settings)
    expect(() => activatePersonalScore(changed, prepared)).toThrow(/仅阅谱|原谱钢琴/)
    expect(synth).not.toHaveBeenCalled()
  })
  it('rejects multiple or non-piano parts while admitting a single original piano lazily', async () => {
    const prepared = prepareScore(xml, record.settings)
    expect(() => activatePersonalScore({ ...record, settings: { ...record.settings, pianoPartIds: ['P', 'F'] } }, prepared)).toThrow(/一个|一份/)
    expect(() => activatePersonalScore({ ...record, settings: { ...record.settings, pianoPartIds: ['F'] } }, prepared)).toThrow(/钢琴声部/)
    const source = activatePersonalScore(record, prepared)
    expect(synth).not.toHaveBeenCalled()
    await source.loadAudio()
    expect(synth).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from 'vitest'
import { initialSettings, normaliseSettings } from './settings'
import type { ScoreInspection, ScoreSettings } from './types'
const info: ScoreInspection = { title: 'Test', composer: '', parts: [{ id: 'F', name: 'Flute', isPiano: false, noteCount: 1 }, { id: 'P1', name: 'Piano 1', isPiano: true, noteCount: 2 }, { id: 'P2', name: 'Piano 2', isPiano: true, noteCount: 2 }, { id: 'D', name: 'Grand Piano drum', isPiano: false, noteCount: 3 }], defaultMelodyPartId: 'F', defaultPianoPartIds: ['P1', 'P2'], keyFifths: 0, keyMode: 'major', beats: 4, beatType: 4, tempo: 120, warnings: [] }
const old: ScoreSettings = { melodyPartId: 'F', pianoPartIds: ['D', 'P2', 'P1'], mode: 'generated', style: 'arpeggio', tonic: 2, minor: true }
describe('simple personal reading and original piano settings', () => {
  it('defaults to one original piano and excludes drums', () => {
    expect(initialSettings(info)).toMatchObject({ mode: 'original', melodyPartId: 'F', pianoPartIds: ['P1'] })
    expect(normaliseSettings(info, old)).toMatchObject({ mode: 'original', pianoPartIds: ['P2'] })
  })
  it('makes flute-only sheets read-only even if their saved mode was generated', () => {
    const flute = { ...info, parts: info.parts.filter(p => p.id === 'F'), defaultPianoPartIds: [] }
    expect(initialSettings(flute)).toMatchObject({ mode: 'none', pianoPartIds: [] })
    expect(normaliseSettings(flute, old)).toMatchObject({ mode: 'none', pianoPartIds: [] })
  })
  it('preserves explicit read-only choice and repairs stale melody/piano choices', () => {
    expect(normaliseSettings(info, { ...old, mode: 'none' })).toMatchObject({ mode: 'none', pianoPartIds: [] })
    expect(normaliseSettings(info, { ...old, melodyPartId: 'gone', pianoPartIds: ['D'] })).toMatchObject({ mode: 'original', melodyPartId: 'F', pianoPartIds: ['P1'] })
  })
})

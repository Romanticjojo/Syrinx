import { describe, expect, it } from 'vitest'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { inspectScore, prepareScore } from './score'
import type { ScoreSettings } from './types'

const note = (step: string, duration = 1, extra = '', octave = 4) => `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration></note>`
const rest = (duration: number) => `<note><rest/><duration>${duration}</duration></note>`
const attr = '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
const tempo = (bpm: number) => `<direction><sound tempo="${bpm}"/></direction>`
const measure = (body: string, number = 1, props = '') => `<measure number="${number}" ${props}>${body}</measure>`
const xml = (melody: string, piano = '') => `<score-partwise version="4.0"><work><work-title>Test Song</work-title></work><identification><creator type="composer">Composer</creator></identification><part-list><score-part id="M"><part-name>Flute</part-name></score-part>${piano ? '<score-part id="P"><part-name>Piano</part-name><midi-instrument><midi-program>1</midi-program></midi-instrument></score-part>' : ''}</part-list><part id="M">${melody}</part>${piano ? `<part id="P">${piano}</part>` : ''}</score-partwise>`
const settings: ScoreSettings = { melodyPartId: 'M', pianoPartIds: ['P'], mode: 'original', style: 'block', tonic: null, minor: false }
const prepare = (source: string, patch: Partial<ScoreSettings> = {}) => prepareScore(source, { ...settings, ...patch })

describe('personal MusicXML engine: hand-calculated musical timelines', () => {
  it('emits declared UTF-8 melody and original piano XML accepted by the installed OSMD loader', async () => {
    const source = xml(measure(attr + '<attributes><clef><sign>G</sign><line>2</line></clef></attributes>' + note('C', 4)), measure(attr + '<attributes><clef><sign>F</sign><line>4</line></clef></attributes>' + note('C', 4)))
    const result = prepare(source)
    for (const [output, id] of [[result.melodyXml, 'M'], [result.pianoXml!, 'P']]) {
      expect(output).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
      const doc = new DOMParser().parseFromString(output, 'application/xml')
      expect(doc.documentElement.localName).toBe('score-partwise')
      expect([...doc.querySelectorAll('part')].map(p => p.getAttribute('id'))).toEqual([id])
      const osmd = new OpenSheetMusicDisplay(document.createElement('div'), { backend: 'svg', autoResize: false })
      await osmd.load(output)
      expect(osmd.Sheet.SourceMeasures).toHaveLength(1)
      osmd.clear()
    }
    expect(result.displayXml).toBe(source)
  })
  it('inspects metadata and recognizes piano without choosing it as melody', () => {
    expect(inspectScore(xml(measure(attr + note('C')), measure(attr + note('C'))))).toMatchObject({ title: 'Test Song', composer: 'Composer', defaultMelodyPartId: 'M', defaultPianoPartIds: ['P'], tempo: 120, beats: 4, beatType: 4 })
  })
  it('aligns backup/staff, simultaneous chords, shared tempo changes and final rests', () => {
    const source = xml(measure(attr + tempo(60) + note('C', 2) + tempo(120) + note('D') + rest(1)), measure(attr + note('C', 4) + note('E', 4, '<chord/>') + note('G', 4, '<chord/>') + '<backup><duration>4</duration></backup>' + note('C', 4, '<voice>2</voice><staff>2</staff>', 3)))
    const result = prepare(source)
    expect(result.timeline.notes).toEqual([{ time: 0, duration: 2, midi: 60, measure: 1 }, { time: 2, duration: .5, midi: 62, measure: 1 }])
    expect(result.timeline.durationSec).toBe(3)
    expect(result.timeline.tempoSegments).toEqual([{ quarters: 0, time: 0, bpm: 60 }, { quarters: 2, time: 2, bpm: 120 }])
    expect(result.accompanimentTimeline.tempoSegments).toEqual(result.timeline.tempoSegments)
    expect(result.accompanimentTimeline.notes.map(n => [n.time, n.duration, n.midi])).toEqual([[0, 3, 48], [0, 3, 60], [0, 3, 64], [0, 3, 67]])
    expect(result.displayXml).toBe(source)
  })
  it('handles pickup, explicit tuplet durations and ties across measures', () => {
    const source = xml(measure(attr + tempo(60) + note('C', 1, '<tie type="start"/>'), 0, 'implicit="yes"') + measure('<attributes><divisions>3</divisions></attributes>' + note('C', 3, '<tie type="stop"/>') + note('D', 1, '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>') + rest(8), 1))
    const result = prepare(source, { mode: 'none', pianoPartIds: [] })
    expect(result.timeline.notes[0]).toEqual({ time: 0, duration: 2, midi: 60, measure: 1 })
    expect(result.timeline.notes[1].time).toBe(2)
    expect(result.timeline.notes[1].duration).toBeCloseTo(1 / 3)
    expect(result.timeline.measureTimes.map(m => m.time)).toEqual([0, 1, 5])
    expect(result.accompanimentTimeline.notes).toEqual([])
    expect(result.accompanimentTimeline.durationSec).toBe(5)
  })
  it('expands common repeats from any part for both audio and melody display', () => {
    const source = xml(measure(attr + tempo(60) + note('C', 4)) + measure(note('D', 4), 2), measure(attr + note('C', 4) + '<barline><repeat direction="backward"/></barline>') + measure(note('E', 4), 2))
    const result = prepare(source)
    expect(result.timeline.notes.map(n => [n.time, n.midi])).toEqual([[0, 60], [4, 60], [8, 62]])
    expect(result.accompanimentTimeline.notes.map(n => n.time)).toEqual([0, 4, 8])
    const doc = new DOMParser().parseFromString(result.melodyXml, 'application/xml')
    expect([...doc.querySelectorAll('part')].map(p => p.id)).toEqual(['M'])
    expect(doc.querySelectorAll('measure')).toHaveLength(3)
    expect(doc.querySelectorAll('repeat')).toHaveLength(0)
  })
  it('honors first and second endings in all parts', () => {
    const source = xml(measure(attr + tempo(60) + note('C', 4) + '<barline location="left"><repeat direction="forward"/></barline>') + measure('<barline location="left"><ending number="1" type="start"/></barline>' + note('D', 4) + '<barline><ending number="1" type="stop"/><repeat direction="backward"/></barline>', 2) + measure('<barline location="left"><ending number="2" type="start"/></barline>' + note('E', 4) + '<barline><ending number="2" type="stop"/></barline>', 3))
    expect(prepare(source, { mode: 'none', pianoPartIds: [] }).timeline.notes.map(n => n.midi)).toEqual([60, 62, 60, 64])
  })
  it('generates harmony-based chords and distinct regular patterns', () => {
    const source = xml(measure(attr + tempo(60) + '<harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>' + note('C', 4)))
    const block = prepare(source, { mode: 'generated', pianoPartIds: [] })
    expect(block.accompanimentTimeline.notes.map(n => n.midi)).toEqual([41, 53, 57, 60])
    const arp = prepare(source, { mode: 'generated', pianoPartIds: [], style: 'arpeggio' })
    expect(arp.accompanimentTimeline.notes.map(n => n.time)).toEqual([0, .5, 1, 1.5, 2, 2.5, 3, 3.5])
    const waltz = prepare(source.replace('<beats>4', '<beats>3').replace('<duration>4', '<duration>3'), { mode: 'generated', pianoPartIds: [], style: 'waltz' })
    expect([...new Set(waltz.accompanimentTimeline.notes.map(n => n.time))]).toEqual([0, 1, 2])
  })
  it('validates XML, selections, unsupported navigation, and microtonal pitch', () => {
    expect(() => inspectScore('<score-partwise><part></score-partwise>')).toThrow(/XML/)
    expect(() => inspectScore('<!DOCTYPE score-partwise [<!ENTITY x "BAD">]><score-partwise/>')).toThrow(/实体|DOCTYPE/)
    expect(() => inspectScore('<score-timewise/>')).toThrow(/score-partwise/)
    const source = xml(measure(attr + note('C', 4)))
    expect(() => prepare(source, { melodyPartId: 'missing', mode: 'none', pianoPartIds: [] })).toThrow(/旋律/)
    expect(() => prepare(source)).toThrow(/钢琴/)
    const navigation = source.replace('</measure>', '<direction><sound dacapo="yes"/></direction></measure>')
    expect(inspectScore(navigation).warnings.join('')).toMatch(/阅谱/)
    expect(() => prepare(navigation, { mode: 'none', pianoPartIds: [] })).toThrow(/阅谱/)
    expect(() => prepare(source.replace('<octave>', '<alter>0.5</alter><octave>'), { mode: 'none', pianoPartIds: [] })).toThrow(/微分音/)
    expect(inspectScore('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' + source).title).toBe('Test Song')
  })
  it('excludes drum-labelled piano programs from default piano selections', () => {
    const source = xml(measure(attr + note('C', 4)), measure(attr + note('D', 4))).replace('<part-name>Piano</part-name>', '<part-name>Grand Piano drum</part-name><score-instrument><instrument-sound>drum.group.set</instrument-sound></score-instrument>')
    expect(inspectScore(source).defaultPianoPartIds).toEqual([])
  })
  it('ignores an unselected percussion part for playable melody', () => {
    const source = xml(measure(attr + note('C', 4)), measure(attr + '<note><unpitched><display-step>C</display-step><display-octave>4</display-octave></unpitched><duration>4</duration></note>'))
    expect(prepare(source, { mode: 'generated', pianoPartIds: [] }).timeline.notes[0].midi).toBe(60)
    expect(() => prepare(source)).toThrow(/无固定音高/)
  })
  it('rejects external media references before passing XML to the renderer', () => {
    expect(() => inspectScore(xml(measure(attr + note('C', 4))).replace('<work>', '<credit><credit-image source="https://example.com/tracker.png"/></credit><work>'))).toThrow(/外部/)
  })
  it('rejects ambiguous nested repeats', () => {
    const source = xml(measure(attr + note('C', 4) + '<barline location="left"><repeat direction="forward"/></barline>') + measure(note('D', 4) + '<barline location="left"><repeat direction="forward"/></barline>', 2) + measure(note('E', 4) + '<barline><repeat direction="backward"/></barline>', 3))
    expect(() => prepare(source, { mode: 'none', pianoPartIds: [] })).toThrow(/嵌套/)
  })
  it('aligns documented small tuplet rounding errors to the shared barline', () => {
    const rounded = '<attributes><divisions>480</divisions></attributes>' + note('C', 1440) + Array.from({ length: 7 }, () => note('D', 69, '<time-modification><actual-notes>7</actual-notes><normal-notes>4</normal-notes></time-modification>')).join('')
    const result = prepare(xml(measure(attr + tempo(60) + note('C', 4)) + measure(note('E', 4), 2), measure(attr + rounded) + measure(note('C', 1920), 2)))
    expect(result.timeline.durationSec).toBe(8)
    expect(result.accompanimentTimeline.notes.at(-1)?.time).toBe(4)
    expect(result.accompanimentTimeline.notes[7].time + result.accompanimentTimeline.notes[7].duration).toBe(4)
    expect(result.warnings.join('')).toMatch(/取整/)
  })
  it('shares metronome tempo in dotted beats and concert transposition', () => {
    const source = xml(measure(attr + '<attributes><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>' + note('C', 4)), measure(attr + '<direction><direction-type><metronome><beat-unit>half</beat-unit><beat-unit-dot/><per-minute>40</per-minute></metronome></direction-type></direction>' + note('C', 4)))
    const result = prepare(source)
    expect(result.timeline.tempo).toBe(120)
    expect(result.timeline.durationSec).toBe(2)
    expect(result.timeline.notes[0].midi).toBe(58)
  })
  it('blocks unsupported octave shifts and text-only navigation with a reading message', () => {
    const base = xml(measure(attr + note('C', 4)))
    for (const direction of ['<direction-type><octave-shift type="down" size="8"/></direction-type>', '<direction-type><words>D.C. al Fine</words></direction-type>']) {
      const source = base.replace('</measure>', `<direction>${direction}</direction></measure>`)
      expect(() => prepare(source, { mode: 'none', pianoPartIds: [] })).toThrow(/阅谱/)
    }
  })
  it('supports a piano part with long sustained ties independently of melody targets', () => {
    const source = xml(measure(attr + tempo(60) + note('D', 4)) + measure(note('E', 4), 2), measure(attr + note('C', 4, '<tie type="start"/>')) + measure(note('C', 4, '<tie type="stop"/>'), 2))
    expect(prepare(source).accompanimentTimeline.notes).toEqual([{ time: 0, duration: 8, midi: 60, measure: 1 }])
  })
  it('keeps an explicit harmony active until the next harmony across multiple bars', () => {
    const source = xml(measure(attr + tempo(60) + '<harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>' + note('C', 4)) + measure(note('C', 4), 2) + measure(note('C', 4), 3))
    const result = prepare(source, { mode: 'generated', pianoPartIds: [] })
    expect(result.accompanimentTimeline.notes.filter(n => n.time === 8).map(n => n.midi)).toEqual([41, 53, 57, 60])
  })
  it.each(['generated', 'none'] as const)('does not display unused piano or require matching piano bars in %s mode', mode => {
    const source = xml(measure(attr + note('C', 4)) + measure(note('D', 4), 2), measure(attr + note('C', 4)))
    const result = prepare(source, { mode })
    expect(result.pianoXml).toBeNull()
    expect(result.timeline.measureTimes).toHaveLength(3)
    expect(result.accompanimentTimeline.durationSec).toBe(result.timeline.durationSec)
    expect(prepare(source, { mode, pianoPartIds: ['unused-old-part'] }).pianoXml).toBeNull()
    expect(() => prepare(source, { mode: 'original' })).toThrow(/小节数量/)
  })
})

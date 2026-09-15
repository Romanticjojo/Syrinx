import type { NoteEvent, Timeline } from '../types'
import type { PreparedScore, ScoreInspection, ScoreSettings } from './types'
import { child, MAX_NOTES, MAX_SECONDS, parseScore, playbackOrder } from './score-parse'
import type { Bar, BeatNote, Harmony, ParsedScore } from './score-parse'

export function inspectScore(xml: string): ScoreInspection { return parseScore(xml).inspection }

interface ExpandedNote extends BeatNote { measure: number; partId: string }
interface ExpandedBar { bar: Bar; start: number; length: number; measure: number }
const reject = (text: string): never => { throw new Error(text) }

function displayPart(parsed: ParsedScore, ids: string[], order: number[]): string {
  // Copy only metadata and selected parts, avoiding a full orchestral DOM clone.
  const doc = new DOMParser().parseFromString('<score-partwise/>', 'application/xml')
  const root = doc.documentElement
  for (const a of parsed.doc.documentElement.attributes) root.setAttribute(a.name, a.value)
  for (const e of parsed.doc.documentElement.children) if (e.localName !== 'part') root.appendChild(doc.importNode(e, true))
  const list = child(root, 'part-list')!
  for (const p of [...list.children]) if (p.localName !== 'score-part' || !ids.includes(p.getAttribute('id') || '')) p.remove()
  // Make the selected melody the first (and only) part for the legacy OSMD cursor.
  for (const id of ids) {
    const part = doc.createElement('part'); part.setAttribute('id', id)
    const source = parsed.parts.find(p => p.id === id)!
    order.forEach((sourceIndex, i) => {
      const bar = source.bars[sourceIndex]
      const measure = doc.importNode(bar.element, true) as Element
      measure.setAttribute('number', String(i + 1))
      for (const e of measure.querySelectorAll('repeat, ending')) e.remove()
      for (const e of measure.querySelectorAll('print')) { e.removeAttribute('new-system'); e.removeAttribute('new-page') }
      // Re-establish inherited state at jumps (including divisions, key, meter, clefs).
      if (i === 0 || sourceIndex !== order[i - 1] + 1) {
        const attr = doc.createElement('attributes')
        for (const a of bar.attributes) attr.appendChild(doc.importNode(a, true))
        measure.insertBefore(attr, measure.firstChild)
      }
      part.appendChild(measure)
    })
    root.appendChild(part)
  }
  // OSMD's string loader recognizes inline XML by its declaration; without it
  // the complete score string can be treated as a URL instead of a document.
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc)
}

function inferredChord(bar: Bar, melody: BeatNote[], settings: ScoreSettings): { root: number; intervals: number[] } {
  const minor = settings.tonic === null ? bar.minor : settings.minor
  const tonic = settings.tonic ?? ((bar.fifths * 7 + (minor ? 9 : 0)) % 12 + 12) % 12
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
  const choices = [0, 3, 4, 5, 1, 2, 6].map(degree => {
    const root = (tonic + scale[degree]) % 12
    const intervals = [0, (scale[(degree + 2) % 7] - scale[degree] + 12) % 12, (scale[(degree + 4) % 7] - scale[degree] + 12) % 12]
    const pitches = intervals.map(i => (root + i) % 12)
    const weight = melody.reduce((sum, n) => sum + (pitches.includes(n.midi % 12) ? 1 : -.3) * n.duration * (Math.abs(n.beat % (4 / bar.beatType)) < 1e-6 ? 2 : 1) * (n.beat === 0 ? 1.5 : 1), 0)
    return { root, intervals, weight }
  })
  return choices.sort((a, b) => b.weight - a.weight)[0]
}

export function prepareScore(xml: string, settings: ScoreSettings): PreparedScore {
  const parsed = parseScore(xml)
  const melody = parsed.parts.find(p => p.id === settings.melodyPartId)
  if (!melody) reject('请选择有效的主旋律声部')
  if (!['original', 'generated', 'none'].includes(settings.mode) || !['block', 'arpeggio', 'waltz'].includes(settings.style)) reject('伴奏设置无效')
  if (settings.tonic !== null && (!Number.isInteger(settings.tonic) || settings.tonic < 0 || settings.tonic > 11)) reject('调性设置无效')
  if (settings.mode === 'original' && (new Set(settings.pianoPartIds).size !== settings.pianoPartIds.length || settings.pianoPartIds.some(id => !parsed.parts.some(p => p.id === id)))) reject('请选择有效的钢琴声部')
  if (settings.mode === 'original' && !settings.pianoPartIds.length) reject('原谱伴奏需要至少一个钢琴声部')
  if (parsed.unsupported.length) reject(parsed.unsupported.join('；'))
  const selected = parsed.parts.filter(p => p.id === melody!.id || settings.mode === 'original' && settings.pianoPartIds.includes(p.id))
  const partUnsupported = selected.flatMap(p => p.unsupported)
  if (partUnsupported.length) reject(partUnsupported.join('；'))
  if (selected.some(p => p.bars.length !== melody!.bars.length)) reject('所选声部的小节数量不一致，目前仅可阅谱')
  const navigationParts = parsed.parts.filter(p => p.bars.length === melody!.bars.length)
  const order = playbackOrder(navigationParts, melody!.bars.length)
  const warnings = [...parsed.inspection.warnings]
  const firstPitched = melody!.bars.flatMap(b => b.notes)[0]
  if (!firstPitched) reject('主旋律声部没有可演奏的音符，目前仅可阅谱')
  if (melody!.bars.some(b => b.notes.some(n => n.voice !== firstPitched.voice || n.staff !== firstPitched.staff))) warnings.push('主旋律评分采用首个有音高的声部与谱表；其余音符保留显示。')
  const events: ExpandedNote[] = [], melodyBars: ExpandedBar[] = []
  const tempoEvents: { beat: number; bpm: number }[] = []
  const measureTimes: Timeline['measureTimes'] = []
  // Tempo is a score-wide map; missing changes in one part inherit all other parts.
  const temposByBar = melody!.bars.map((_, index) => {
    const map = new Map<number, number>()
    for (const p of navigationParts) for (const t of p.bars[index].tempos) {
      const key = Math.round(t.beat * 1e8) / 1e8
      if (map.has(key) && Math.abs(map.get(key)! - t.bpm) > 1e-6) reject('同一位置的声部速度不一致，目前仅可阅谱')
      map.set(key, t.bpm)
    }
    return [...map].map(([beat, bpm]) => ({ beat, bpm })).sort((a, b) => a.beat - b.beat)
  })
  let sourceTempo = 120
  const enteringTempo = temposByBar.map(ts => { const initial = sourceTempo; for (const t of ts) sourceTempo = t.bpm; return initial })
  let durationBeats = 0
  for (let i = 0; i < order.length; i++) {
    const index = order[i], bar = melody!.bars[index]
    const length = Math.max(...selected.map(p => p.bars[index].length))
    if (selected.some(p => Math.abs(p.bars[index].length - length) > 1e-6)) reject('所选声部的小节时值不一致，目前仅可阅谱')
    measureTimes.push({ measure: i + 1, time: 0, quarters: durationBeats })
    if (i === 0 || index !== order[i - 1] + 1) tempoEvents.push({ beat: durationBeats, bpm: enteringTempo[index] })
    for (const t of temposByBar[index]) tempoEvents.push({ beat: durationBeats + t.beat, bpm: t.bpm })
    melodyBars.push({ bar, start: durationBeats, length, measure: i + 1 })
    for (const p of selected) for (const n of p.bars[index].notes) events.push({ ...n, beat: n.beat + durationBeats, measure: i + 1, partId: p.id })
    durationBeats += length
    if (events.length > MAX_NOTES * 4 || durationBeats > 18_000) reject('展开后的音符或曲长超过支持范围')
  }
  const map = new Map<number, number>()
  for (const t of tempoEvents) map.set(t.beat, t.bpm)
  const tempoMap = [...map].map(([beat, bpm]) => ({ beat, bpm, time: 0 })).sort((a, b) => a.beat - b.beat)
  for (let i = 1; i < tempoMap.length; i++) tempoMap[i].time = tempoMap[i - 1].time + (tempoMap[i].beat - tempoMap[i - 1].beat) * 60 / tempoMap[i - 1].bpm
  const seconds = (beat: number): number => {
    let lo = 0, hi = tempoMap.length - 1
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tempoMap[mid].beat <= beat + 1e-9) lo = mid; else hi = mid - 1 }
    const t = tempoMap[lo]; return t.time + (beat - t.beat) * 60 / t.bpm
  }
  const durationSec = seconds(durationBeats)
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_SECONDS) reject('曲长须大于零且不超过 30 分钟')
  for (const m of measureTimes) m.time = seconds(m.quarters)
  measureTimes.push({ measure: order.length + 1, time: durationSec, quarters: durationBeats, end: true })
  const timeline = (notes: NoteEvent[]): Timeline => ({ durationSec, tempo: tempoMap[0].bpm, secPerQuarter: 60 / tempoMap[0].bpm, tempoSegments: tempoMap.map(t => ({ quarters: t.beat, time: t.time, bpm: t.bpm })), measureTimes: measureTimes.map(m => ({ ...m })), notes: notes.sort((a, b) => a.time - b.time || a.midi - b.midi) })
  const convert = (notes: ExpandedNote[]): NoteEvent[] => {
    const result: NoteEvent[] = [], ties = new Map<string, { event: NoteEvent; end: number }>()
    for (const n of notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi)) {
      const key = `${n.partId}/${n.voice}/${n.staff}/${n.midi}`
      const prior = ties.get(key)
      if (n.tieStop && prior && Math.abs(prior.end - n.beat) < 1e-6) {
        prior.event.duration = seconds(n.beat + n.duration) - prior.event.time
        if (n.tieStart) prior.end = n.beat + n.duration; else ties.delete(key)
      } else {
        const event = { time: seconds(n.beat), duration: seconds(n.beat + n.duration) - seconds(n.beat), midi: n.midi, measure: n.measure }
        result.push(event)
        if (n.tieStart) ties.set(key, { event, end: n.beat + n.duration }); else ties.delete(key)
      }
    }
    return result
  }
  const melodyNotes = events.filter(n => n.partId === melody!.id && n.voice === firstPitched.voice && n.staff === firstPitched.staff)
  // In a chord, the highest pitch is the single pitch target for wind practice.
  const high = new Map<number, ExpandedNote>()
  for (const n of melodyNotes) if (!high.has(n.beat) || high.get(n.beat)!.midi < n.midi) high.set(n.beat, n)
  if (high.size < melodyNotes.length) warnings.push('主旋律含和弦，评分采用每个和弦的最高音。')
  let accompaniment: NoteEvent[] = []
  if (settings.mode === 'original') accompaniment = convert(events.filter(n => settings.pianoPartIds.includes(n.partId)))
  if (settings.mode === 'generated') {
    warnings.push('伴奏为本机合成钢琴基础编配；优先使用和弦标记，否则按调性与旋律推断。')
    const sharedHarmonies = melody!.bars.map((bar, index) => [...(bar.harmonies.length ? bar.harmonies : navigationParts.flatMap(p => p.bars[index].harmonies))].sort((a, b) => a.beat - b.beat))
    let priorHarmony: Harmony | null = null
    const enteringHarmony = sharedHarmonies.map(hs => { const prior = priorHarmony; if (hs.length) priorHarmony = hs[hs.length - 1]; return prior })
    for (const { bar, start, length, measure } of melodyBars) {
      const index = order[measure - 1]
      const segments = [...sharedHarmonies[index]]
      if (!segments.length || segments[0].beat > 0) segments.unshift({ ...(enteringHarmony[index] || inferredChord(bar, bar.notes.filter(n => n.voice === firstPitched.voice && n.staff === firstPitched.staff), settings)), beat: 0 })
      for (let j = 0; j < segments.length; j++) {
        const h = segments[j], end = Math.min(length, segments[j + 1]?.beat ?? length)
        if (h.beat >= end) continue
        const root = 36 + h.root, chord = h.intervals.map(n => root + 12 + n)
        const emit = (beat: number, duration: number, midi: number) => accompaniment.push({ time: seconds(start + beat), duration: seconds(start + Math.min(end, beat + duration)) - seconds(start + beat), midi, measure })
        if (settings.style === 'block') for (const midi of [root, ...chord]) emit(h.beat, end - h.beat, midi)
        else if (settings.style === 'arpeggio') { const pattern = [root, ...chord, ...chord.slice().reverse()]; let k = 0; for (let b = h.beat; b < end - 1e-8; b += .5) emit(b, .45, pattern[k++ % pattern.length]) }
        else { const unit = 4 / bar.beatType; for (let b = h.beat; b < end - 1e-8; b += unit) { for (const midi of Math.round((b - h.beat) / unit) % 3 === 0 ? [root] : chord) emit(b, unit * .85, midi) } }
      }
    }
  }
  return { displayXml: xml, melodyXml: displayPart(parsed, [melody!.id], order), pianoXml: settings.mode === 'original' ? displayPart(parsed, settings.pianoPartIds, order) : null, timeline: timeline(convert([...high.values()])), accompanimentTimeline: timeline(accompaniment), warnings: [...new Set(warnings)], mode: settings.mode }
}

import { XMLValidator } from 'fast-xml-parser'
import type { ScoreInspection } from './types'

export const MAX_XML_BYTES = 10 * 1024 * 1024
export const MAX_NOTES = 100_000
export const MAX_MEASURES = 4000
export const MAX_SECONDS = 30 * 60
export const children = (e: Element, name: string) => [...e.children].filter(c => c.localName === name)
export const child = (e: Element, name: string) => children(e, name)[0]
export const value = (e: Element, name: string, fallback = '') => child(e, name)?.textContent?.trim() || fallback
const fail = (s: string): never => { throw new Error(s) }
export const number = (s: string, label: string, min = 0, max = 1e7) => {
  const n = Number(s)
  return s.trim() && Number.isFinite(n) && n >= min && n <= max ? n : fail(`${label}无效或超过支持范围`)
}

/** Strip, never resolve, the ordinary external MusicXML DTD. No internal subset/entities. */
export function parseXml(xml: string): Document {
  if (!xml || new TextEncoder().encode(xml).length > MAX_XML_BYTES) fail('XML 文件为空或超过 10 MiB')
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) fail('不支持包含实体或内部子集的 DOCTYPE')
  const clean = xml.replace(/<!DOCTYPE\s+[\s\S]*?>/gi, '')
  if ((clean.match(/<[A-Za-z_]/g)?.length || 0) > 300_000) fail('XML 元素数量超过 300000')
  if (XMLValidator.validate(clean) !== true) fail('MusicXML 格式无效，请检查 XML 文件')
  const doc = new DOMParser().parseFromString(clean, 'application/xml')
  if (doc.querySelector('parsererror')) fail('MusicXML 格式无效')
  if (doc.querySelector('credit-image, image, link, opus')) fail('乐谱包含外部图片或资源引用，请移除后导入')
  return doc
}

export interface BeatNote { beat: number; duration: number; midi: number; voice: string; staff: string; tieStart: boolean; tieStop: boolean }
export interface Harmony { beat: number; root: number; intervals: number[] }
export interface Bar { element: Element; notes: BeatNote[]; length: number; beats: number; beatType: number; divisions: number; fifths: number; minor: boolean; tempos: { beat: number; bpm: number }[]; harmonies: Harmony[]; transpose: number; attributes: Element[] }
export interface ParsedPart { id: string; bars: Bar[]; unsupported: string[] }
export interface ParsedScore { doc: Document; parts: ParsedPart[]; inspection: ScoreInspection; unsupported: string[] }
const pitchClasses: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const harmonyKinds: Record<string, number[]> = { major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8], dominant: [0, 4, 7, 10], 'major-seventh': [0, 4, 7, 11], 'minor-seventh': [0, 3, 7, 10], 'suspended-second': [0, 2, 7], 'suspended-fourth': [0, 5, 7] }
export function parseScore(xml: string): ParsedScore {
  const doc = parseXml(xml)
  if (doc.documentElement.localName !== 'score-partwise') fail('仅支持 score-partwise MusicXML；请先转换 score-timewise')
  const partElements = children(doc.documentElement, 'part')
  if (!partElements.length || partElements.length > 32) fail('乐谱声部数量须为 1–32')
  const defs = doc.querySelectorAll('part-list > score-part')
  const warnings: string[] = []
  const unsupported: string[] = []
  const unsupportedOnce = (s: string) => { if (!unsupported.includes(s)) unsupported.push(s) }
  if (doc.querySelector('sound[dacapo], sound[dalsegno], sound[tocoda], sound[fine], segno, coda')) unsupportedOnce('含 D.C./D.S./Coda 等导航，目前仅可阅谱')
  if ([...doc.querySelectorAll('words')].some(w => /\bD\.?\s*[CS]\.?\s*(al|$)|da\s+capo|dal\s+segno|to\s+coda|^\s*fine\s*$/i.test(w.textContent || ''))) unsupportedOnce('含文字反复导航，目前仅可阅谱')
  if (doc.querySelector('measure-repeat, multiple-rest, beat-repeat')) unsupportedOnce('含小节缩写或多小节休止，请展开后演奏；目前仅可阅谱')
  if (doc.querySelector('grace')) warnings.push('装饰音保留显示，播放与评分暂略过装饰音。')
  if (doc.querySelector('fermata')) warnings.push('延长记号按书面时值播放，不额外延长。')
  let count = 0
  const ids = new Set<string>()
  const parts = partElements.map(part => {
    const partUnsupported: string[] = []
    const unsupportedPart = (s: string) => { if (!partUnsupported.includes(s)) partUnsupported.push(s) }
    if (part.querySelector('octave-shift')) unsupportedPart('八度移位线暂不支持演奏，目前仅可阅谱')
    const id = part.getAttribute('id') || ''
    if (!id || ids.has(id)) fail('乐谱声部 ID 缺失或重复')
    ids.add(id)
    let divisions = 1, beats = 4, beatType = 4, fifths = 0, minor = false, transpose = 0
    const attributes: Element[] = []
    const measures = children(part, 'measure')
    if (!measures.length || measures.length > MAX_MEASURES) fail('单声部小节数量须为 1–4000')
    const bars = measures.map((m, index): Bar => {
      let position = 0, extent = 0, lastNote = -1
      const notes: BeatNote[] = [], tempos: Bar['tempos'] = [], harmonies: Harmony[] = []
      for (const el of m.children) {
        if (el.localName === 'attributes') {
          for (const a of el.children) {
            const old = attributes.findIndex(x => x.localName === a.localName && x.getAttribute('number') === a.getAttribute('number'))
            if (old >= 0) attributes.splice(old, 1)
            attributes.push(a.cloneNode(true) as Element)
          }
          if (child(el, 'divisions')) divisions = number(value(el, 'divisions'), 'divisions', 1, 100_000)
          const time = child(el, 'time')
          if (time) {
            if (children(time, 'beats').length !== 1 || !/^\d+(\+\d+)*$/.test(value(time, 'beats'))) unsupportedOnce('复合拍号格式暂不支持演奏，目前仅可阅谱')
            else { beats = value(time, 'beats').split('+').reduce((a, b) => a + number(b, '拍号', 1, 64), 0); beatType = number(value(time, 'beat-type'), '拍号单位', 1, 64) }
          }
          const key = child(el, 'key')
          if (key) { fifths = number(value(key, 'fifths', '0'), '调号', -7, 7); minor = value(key, 'mode') === 'minor' }
          const trans = child(el, 'transpose')
          if (trans) transpose = number(value(trans, 'chromatic', '0'), '移调', -24, 24) + 12 * number(value(trans, 'octave-change', '0'), '八度移调', -4, 4)
        } else if (el.localName === 'backup' || el.localName === 'forward') {
          const delta = number(value(el, 'duration'), '时值', 0, 1e8) / divisions
          position += el.localName === 'backup' ? -delta : delta
          if (position < -1e-7) fail('backup 超出小节起点')
          position = Math.max(0, position); extent = Math.max(extent, position); lastNote = -1
        } else if (el.localName === 'direction' || el.localName === 'sound') {
          const sound = el.localName === 'sound' ? el : el.querySelector('sound')
          let bpm = sound?.getAttribute('tempo') ? number(sound.getAttribute('tempo')!, '速度', 10, 600) : 0
          const metro = el.querySelector('metronome')
          if (!bpm && metro) {
            const units: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25 }
            const unit = units[value(metro, 'beat-unit')]
            if (!unit || !child(metro, 'per-minute')) unsupportedOnce('节拍器标记暂不支持，目前仅可阅谱')
            else bpm = number(value(metro, 'per-minute'), '速度', 10, 600) * unit * (children(metro, 'beat-unit-dot').length ? 2 - 2 ** -children(metro, 'beat-unit-dot').length : 1)
          }
          if (bpm) tempos.push({ beat: position + number(value(el, 'offset', '0'), '速度偏移', -1e8, 1e8) / divisions, bpm })
        } else if (el.localName === 'harmony') {
          const root = child(el, 'root')
          const kind = value(el, 'kind', 'major')
          if (root && pitchClasses[value(root, 'root-step')] !== undefined && harmonyKinds[kind]) harmonies.push({ beat: position + number(value(el, 'offset', '0'), '和弦偏移', -1e8, 1e8) / divisions, root: (pitchClasses[value(root, 'root-step')] + number(value(root, 'root-alter', '0'), '和弦变化音', -2, 2) + transpose + 120) % 12, intervals: harmonyKinds[kind] })
          else warnings.push('部分和弦标记暂未支持，将使用调性与旋律推断。')
        } else if (el.localName === 'note') {
          if (++count > MAX_NOTES) fail('音符总数超过 100000')
          if (child(el, 'grace')) continue
          const duration = number(value(el, 'duration'), '音符时值', .000001, 1e8) / divisions
          const chord = !!child(el, 'chord')
          if (chord && lastNote < 0) fail('和弦音缺少前导音符')
          const beat = chord ? lastNote : position
          const pitch = child(el, 'pitch')
          if (pitch) {
            const pc = pitchClasses[value(pitch, 'step')]
            if (pc === undefined) fail('音高 step 无效')
            const alter = number(value(pitch, 'alter', '0'), '变化音', -2, 2)
            if (!Number.isInteger(alter)) unsupportedPart('微分音目前仅可阅谱')
            const midi = (number(value(pitch, 'octave'), '八度', 0, 9) + 1) * 12 + pc + alter + transpose
            if (midi < 0 || midi > 127) fail('音高超出 MIDI 范围')
            const ties = [...el.querySelectorAll('tie, tied')]
            notes.push({ beat, duration, midi, voice: value(el, 'voice', '1'), staff: value(el, 'staff', '1'), tieStart: ties.some(t => t.getAttribute('type') === 'start'), tieStop: ties.some(t => t.getAttribute('type') === 'stop') })
          } else if (!child(el, 'rest')) unsupportedPart('无固定音高声部目前仅可阅谱')
          if (!chord) { lastNote = position; position += duration }
          extent = Math.max(extent, beat + duration, position)
        }
      }
      const expected = beats * 4 / beatType
      // Integer MusicXML divisions may round each tuplet note by half a tick.
      // Accept only that measured rounding budget (capped at .02 quarter notes),
      // snap the barline, and disclose it. Larger inconsistencies remain errors.
      const roundingBudget = Math.min(.02, m.querySelectorAll('time-modification').length / (2 * divisions))
      if (extent > expected + 1e-7 && extent - expected <= roundingBudget + 1e-7) {
        warnings.push('部分连音符时值有取整误差（不超过 0.02 拍），已按小节线对齐。')
        for (const n of notes) if (n.beat < expected && n.beat + n.duration > expected) n.duration = expected - n.beat
        if (notes.some(n => n.beat >= expected)) fail('连音符取整导致音符超出小节，目前仅可阅谱')
        extent = expected
      }
      const length = m.getAttribute('implicit') === 'yes' || index === 0 && extent > 0 && extent < expected ? extent : Math.max(extent, expected)
      if (length <= 0 || length > 256) fail('小节长度无效或超过 256 四分音符')
      if (tempos.some(t => t.beat < 0 || t.beat > length) || harmonies.some(h => h.beat < 0 || h.beat > length)) fail('速度或和弦偏移超出小节')
      return { element: m, notes, length, beats, beatType, divisions, fifths, minor, transpose, tempos, harmonies, attributes: attributes.map(a => a.cloneNode(true) as Element) }
    })
    return { id, bars, unsupported: partUnsupported }
  })
  const scoreParts = parts.map(p => {
    const def = [...defs].find(d => d.getAttribute('id') === p.id)
    if (!def) fail('声部缺少 part-list 定义')
    const name = value(def!, 'part-name', p.id)
    const program = Number(def!.querySelector('midi-program')?.textContent)
    const drum = /drum|percussion|打击|打擊/i.test(name + (def!.querySelector('instrument-sound')?.textContent || '')) || Number(def!.querySelector('midi-channel')?.textContent) === 10
    return { id: p.id, name, isPiano: !drum && (/piano|钢琴|鋼琴|pianoforte|klavier/i.test(name) || program >= 1 && program <= 8), noteCount: p.bars.reduce((n, b) => n + b.notes.length, 0) }
  })
  const first = parts[0].bars[0]
  const inspection: ScoreInspection = { title: doc.querySelector('work-title')?.textContent?.trim() || doc.querySelector('movement-title')?.textContent?.trim() || '未命名乐谱', composer: doc.querySelector('creator[type="composer"]')?.textContent?.trim() || '', parts: scoreParts, defaultMelodyPartId: (scoreParts.find(p => !p.isPiano && p.noteCount) || scoreParts[0]).id, defaultPianoPartIds: scoreParts.filter(p => p.isPiano).map(p => p.id), keyFifths: first.fifths, keyMode: first.minor ? 'minor' : 'major', beats: first.beats, beatType: first.beatType, tempo: parts.flatMap(p => p.bars[0].tempos).find(t => t.beat === 0)?.bpm || 120, warnings: [...new Set([...warnings, ...unsupported])] }
  inspection.warnings.push(...parts.flatMap(p => p.unsupported.map(s => `${p.id}：${s}`)))
  return { doc, parts, inspection, unsupported }
}

/** Common, non-nested repeat blocks and numbered endings. Reject ambiguity. */
export function playbackOrder(parts: ParsedPart[], count: number): number[] {
  const forward = new Set<number>(), backward = new Map<number, number>(), endings = new Map<number, number[]>()
  for (const part of parts) {
    let activeEnding: number[] | null = null
    part.bars.forEach((bar, i) => {
      for (const ending of bar.element.querySelectorAll('ending[type="start"]')) {
        const raw = ending.getAttribute('number') || ''
        if (!/^\d+(\s*,\s*\d+)*$/.test(raw)) fail('反复房子编号暂不支持，目前仅可阅谱')
        activeEnding = raw.split(',').map(Number)
      }
      if (activeEnding) {
        const prior = endings.get(i)
        if (prior && String(prior) !== String(activeEnding)) fail('声部的反复房子不一致，目前仅可阅谱')
        endings.set(i, activeEnding)
      }
      if (bar.element.querySelector('ending[type="stop"], ending[type="discontinue"]')) activeEnding = null
      for (const repeat of bar.element.querySelectorAll('repeat')) {
        if (repeat.getAttribute('direction') === 'forward') forward.add(i)
        else if (repeat.getAttribute('direction') === 'backward') {
          const times = number(repeat.getAttribute('times') || '2', '反复次数', 2, 4)
          if (!Number.isInteger(times) || backward.has(i) && backward.get(i) !== times) fail('声部反复次数不一致，目前仅可阅谱')
          backward.set(i, times)
        }
      }
    })
  }
  const result: number[] = []
  let start = 0, pass = 1, open = false
  for (let i = 0; i < count; i++) {
    if (forward.has(i)) {
      if (open && i !== start) fail('嵌套反复暂不支持，目前仅可阅谱')
      if (!open) { start = i; pass = 1; open = true }
    }
    const ending = endings.get(i)
    if (!ending || ending.includes(pass)) result.push(i)
    const times = backward.get(i)
    if (times) {
      if (pass < times) { pass++; i = start - 1; open = true }
      else { open = false; start = i + 1 }
    } else if (!ending && !open) pass = 1
    if (result.length > MAX_MEASURES * 4) fail('展开反复后小节过多')
  }
  if (open) fail('反复起点缺少终点，目前仅可阅谱')
  return result
}

/**
 * PlanB · T1 确定性时间轴解析器 单元测试。
 * 全部用手写内联 MusicXML 字符串，不依赖外部文件。
 */
import { describe, expect, it } from 'vitest'
import { parseDeterministicTimeline } from './deterministic-timeline'

// ---------- 内联 MusicXML 构造助手 ----------

interface NoteOpts {
  alter?: number
  dur?: number
  voice?: number
  chord?: boolean
  grace?: boolean
  tie?: 'start' | 'stop'
  ties?: Array<'start' | 'stop'>
}

function noteXml(step: string, octave: number, opts: NoteOpts = {}): string {
  const dur = opts.dur ?? 1
  const voice = opts.voice ?? 1
  const alter = opts.alter ? `<alter>${opts.alter}</alter>` : ''
  const grace = opts.grace ? '<grace/>' : ''
  const chord = opts.chord ? '<chord/>' : ''
  const ties = (opts.ties ?? (opts.tie ? [opts.tie] : []))
    .map((t) => `<tie type="${t}"/>`)
    .join('')
  return `<note>${grace}${chord}<pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch><duration>${dur}</duration>${ties}<voice>${voice}</voice></note>`
}

function restXml(dur: number, voice = 1): string {
  return `<note><rest/><duration>${dur}</duration><voice>${voice}</voice></note>`
}

function forwardXml(dur: number, voice?: number): string {
  return `<forward><duration>${dur}</duration>${voice ? `<voice>${voice}</voice>` : ''}</forward>`
}

function backupXml(dur: number): string {
  return `<backup><duration>${dur}</duration></backup>`
}

interface MeasureOpts {
  divisions?: number
  time?: [number, number]
  tempo?: number
  soundTempo?: number
  forward?: boolean
  backward?: boolean
  endingStart?: string
  endingStop?: string
  words?: string
  segno?: boolean
  coda?: boolean
  number?: string
}

function measureXml(inner: string, opts: MeasureOpts = {}): string {
  const attrs: string[] = []
  if (opts.divisions !== undefined) attrs.push(`<divisions>${opts.divisions}</divisions>`)
  if (opts.time) attrs.push(`<time><beats>${opts.time[0]}</beats><beat-type>${opts.time[1]}</beat-type></time>`)
  const attributeXml = attrs.length > 0 ? `<attributes>${attrs.join('')}</attributes>` : ''
  const tempoXml =
    opts.tempo !== undefined
      ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${opts.tempo}</per-minute></metronome></direction-type></direction>`
      : ''
  const soundTempoXml = opts.soundTempo !== undefined ? `<sound tempo="${opts.soundTempo}"/>` : ''
  const wordsXml = opts.words
    ? `<direction placement="above"><direction-type><words>${opts.words}</words></direction-type></direction>`
    : ''
  const segnoXml = opts.segno
    ? '<direction placement="above"><direction-type><segno/></direction-type></direction>'
    : ''
  const codaXml = opts.coda
    ? '<direction placement="above"><direction-type><coda/></direction-type></direction>'
    : ''
  const leftBarlines: string[] = []
  if (opts.forward) leftBarlines.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>')
  if (opts.endingStart !== undefined) leftBarlines.push(`<barline location="left"><ending number="${opts.endingStart}" type="start"/></barline>`)
  const rightBarlines: string[] = []
  if (opts.endingStop !== undefined) rightBarlines.push(`<barline location="right"><ending number="${opts.endingStop}" type="stop"/></barline>`)
  if (opts.backward) rightBarlines.push('<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>')
  const num = opts.number !== undefined ? ` number="${opts.number}"` : ''
  return `<measure${num}>${leftBarlines.join('')}${attributeXml}${tempoXml}${soundTempoXml}${wordsXml}${segnoXml}${codaXml}${inner}${rightBarlines.join('')}</measure>`
}

function scoreXml(measures: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">${measures.join('')}</part>
</score-partwise>`
}

const closeTo = (expected: number) => expect.closeTo(expected, 3) // ±1ms 级精度

// ---------- 用例 ----------

describe('parseDeterministicTimeline', () => {
  it('单声部 4/4 恒速：起始秒精确（含 rest）', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4) + noteXml('D', 4) + restXml(1) + noteXml('E', 4), {
        divisions: 1,
        time: [4, 4],
        tempo: 90,
      }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes).toHaveLength(4)
    const [c, d, r, e] = tl.notes
    expect(c.pitch).toBe('C4')
    expect(c.startQ).toBe(0)
    expect(c.durQ).toBe(1)
    expect(c.t0Sec).toBe(0)
    expect(c.t1Sec).toEqual(closeTo(2 / 3))
    expect(d.pitch).toBe('D4')
    expect(d.startQ).toBe(1)
    expect(d.t0Sec).toEqual(closeTo(2 / 3))
    expect(r.pitch).toBeNull() // rest
    expect(r.startQ).toBe(2)
    expect(e.pitch).toBe('E4')
    expect(e.startQ).toBe(3)
    expect(e.t0Sec).toEqual(closeTo(2))
    expect(e.t1Sec).toEqual(closeTo(8 / 3))
    expect(tl.tempoSegments).toEqual([{ startQ: 0, bpm: 90 }])
    expect(tl.totalQ).toBe(4)
    expect(tl.endSec).toEqual(closeTo(8 / 3))
    expect(tl.warnings).toHaveLength(0)
  })

  it('三连音 + 附点 + 双附点：duration 为唯一真值', () => {
    // divisions=12：三连音四分音符 dur 4 = 1/3 Q；附点四分 dur 18 = 1.5 Q；双附点四分 dur 21 = 1.75 Q
    const triplet = [noteXml('C', 4, { dur: 4 }), noteXml('D', 4, { dur: 4 }), noteXml('E', 4, { dur: 4 })]
    const xml = scoreXml([
      measureXml(triplet.join('') + noteXml('F', 4, { dur: 18 }) + restXml(18), {
        divisions: 12,
        time: [4, 4],
        tempo: 60,
      }),
      measureXml(noteXml('G', 4, { dur: 21 }) + noteXml('A', 4, { dur: 9 }) + noteXml('B', 4, { dur: 18 })),
    ])
    const tl = parseDeterministicTimeline(xml)
    const [t0, t1, t2, dotted, r] = tl.notes
    expect(t0.durQ).toEqual(closeTo(1 / 3))
    expect(t1.startQ).toEqual(closeTo(1 / 3))
    expect(t2.startQ).toEqual(closeTo(2 / 3))
    expect(dotted.startQ).toEqual(closeTo(1))
    expect(dotted.durQ).toEqual(closeTo(1.5)) // 附点：duration 已含，无需特判
    expect(r.startQ).toEqual(closeTo(2.5))
    expect(r.durQ).toEqual(closeTo(1.5))
    const [dd, d8, dq] = tl.notes.slice(5)
    expect(dd.durQ).toEqual(closeTo(1.75)) // 双附点
    expect(d8.startQ).toEqual(closeTo(4 + 1.75)) // 第 2 小节绝对位置
    expect(d8.durQ).toEqual(closeTo(0.75))
    expect(dq.startQ).toEqual(closeTo(4 + 2.5))
    expect(dq.durQ).toEqual(closeTo(1.5))
    expect(tl.totalQ).toEqual(closeTo(8))
    expect(tl.warnings).toHaveLength(0)
  })

  it('双声部钢琴谱：backup/forward 时间轴回退前进', () => {
    const xml = scoreXml([
      measureXml(
        noteXml('C', 4, { dur: 4, voice: 1 }) +
          backupXml(4) +
          restXml(2, 2) +
          noteXml('G', 4, { dur: 2, voice: 2 }),
        { divisions: 1, time: [4, 4], tempo: 120 },
      ),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes).toHaveLength(3)
    const [c, r, g] = tl.notes
    expect(c.voice).toBe(1)
    expect(c.startQ).toBe(0)
    expect(c.durQ).toBe(4)
    expect(r.pitch).toBeNull()
    expect(r.voice).toBe(2)
    expect(r.startQ).toBe(0) // backup 后游标回到小节头
    expect(g.pitch).toBe('G4')
    expect(g.voice).toBe(2)
    expect(g.startQ).toBe(2) // 前一半休止占位
    expect(g.t0Sec).toEqual(closeTo(1))
    expect(tl.totalQ).toBe(4)
    expect(tl.warnings).toHaveLength(0)
  })

  it('forward 空拍推进游标', () => {
    const xml = scoreXml([
      measureXml(forwardXml(2, 1) + noteXml('C', 4, { dur: 2, voice: 1 }), {
        divisions: 1,
        time: [4, 4],
        tempo: 60,
      }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes).toHaveLength(1)
    expect(tl.notes[0].startQ).toBe(2)
    expect(tl.notes[0].t0Sec).toBe(2)
    expect(tl.totalQ).toBe(4)
    expect(tl.warnings).toHaveLength(0)
  })

  it('chord：成员同时发声不累加时间，只记一次', () => {
    const xml = scoreXml([
      measureXml(
        noteXml('C', 4, { dur: 1 }) +
          noteXml('E', 4, { dur: 1, chord: true }) +
          noteXml('G', 4, { dur: 1, chord: true }) +
          restXml(1) +
          restXml(2),
        { divisions: 1, time: [4, 4], tempo: 60 },
      ),
    ])
    const tl = parseDeterministicTimeline(xml)
    // 只记一次：和弦成员不产生独立时间表条目
    expect(tl.notes.map((n) => n.pitch)).toEqual(['C4', null, null])
    const [c, r1, r2] = tl.notes
    expect(c.durQ).toBe(1)
    expect(r1.startQ).toBe(1) // 和弦不推进游标
    expect(r2.startQ).toBe(2)
    expect(tl.totalQ).toBe(4)
    expect(tl.warnings).toHaveLength(0)
  })

  it('grace note：不占时值，t0 锚在前一主音', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 1 }) + noteXml('D', 4, { dur: 1, grace: true, alter: 1 }) + noteXml('E', 4, { dur: 1 }) + restXml(2), {
        divisions: 1,
        time: [4, 4],
        tempo: 60,
      }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes).toHaveLength(4)
    const [c, grace, e, r] = tl.notes
    expect(grace.pitch).toBe('D#4')
    expect(grace.isGrace).toBe(true)
    expect(grace.durQ).toBe(0)
    expect(grace.t0Sec).toBe(c.t0Sec) // 前一主音 t0
    expect(grace.t1Sec).toBe(grace.t0Sec)
    expect(e.startQ).toBe(1) // grace 不推进游标
    expect(r.startQ).toBe(2)
    expect(r.durQ).toBe(2)
    expect(tl.warnings).toHaveLength(0)
  })

  it('tie：标记透传，不合并时值', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 2, tie: 'start' }) + noteXml('C', 4, { dur: 2, tie: 'stop' }), {
        divisions: 1,
        time: [4, 4],
        tempo: 90,
      }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes).toHaveLength(2)
    const [a, b] = tl.notes
    expect(a.isTieStart).toBe(true)
    expect(a.isTieStop).toBe(false)
    expect(b.isTieStart).toBe(false)
    expect(b.isTieStop).toBe(true)
    expect(a.durQ).toBe(2) // 不合并
    expect(b.durQ).toBe(2)
    expect(b.startQ).toBe(2)
    expect(tl.warnings).toHaveLength(0)
  })

  it('中途变速（90→120）：秒数分段换算', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 90 }),
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2' }),
      measureXml(noteXml('E', 4, { dur: 4 }), { number: '3', tempo: 120 }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.tempoSegments).toEqual([
      { startQ: 0, bpm: 90 },
      { startQ: 8, bpm: 120 },
    ])
    const [c, d, e] = tl.notes
    // 前 8 拍 @90：每拍 2/3 秒
    expect(c.t1Sec).toEqual(closeTo(4 * (60 / 90)))
    expect(d.startQ).toBe(4)
    expect(d.t0Sec).toEqual(closeTo(8 * (60 / 90) / 2))
    expect(d.t1Sec).toEqual(closeTo(8 * (60 / 90)))
    // 第 3 小节起 @120：每拍 0.5 秒
    expect(e.startQ).toBe(8)
    expect(e.t0Sec).toEqual(closeTo(8 * (60 / 90)))
    expect(e.t1Sec).toEqual(closeTo(8 * (60 / 90) + 4 * 0.5))
    expect(tl.endSec).toEqual(closeTo(8 * (60 / 90) + 4 * 0.5))
    expect(tl.warnings).toHaveLength(0)
  })

  it('sound tempo 属性与 metronome per-minute 都识别', () => {
    const byAttr = parseDeterministicTimeline(
      scoreXml([measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], soundTempo: 120 })]),
    )
    expect(byAttr.tempoSegments).toEqual([{ startQ: 0, bpm: 120 }])
    expect(byAttr.notes[0].t1Sec).toEqual(closeTo(2))
    const byMetronome = parseDeterministicTimeline(
      scoreXml([measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60 })]),
    )
    expect(byMetronome.tempoSegments).toEqual([{ startQ: 0, bpm: 60 }])
  })

  it('无任何 tempo 标记时默认 90', () => {
    const xml = scoreXml([measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4] })])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.tempoSegments).toEqual([{ startQ: 0, bpm: 90 }])
    expect(tl.notes[0].t1Sec).toEqual(closeTo(4 * (60 / 90)))
  })

  it('divisions 可中途变化，逐小节跟踪', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60 }),
      measureXml(noteXml('D', 4, { dur: 4 }) + noteXml('E', 4, { dur: 4 }), { number: '2', divisions: 2 }),
    ])
    const tl = parseDeterministicTimeline(xml)
    const [c, d, e] = tl.notes
    expect(c.durQ).toBe(4)
    expect(d.startQ).toBe(4)
    expect(d.durQ).toBe(2) // dur 4 @ divisions 2 = 2 Q
    expect(e.startQ).toBe(6)
    expect(tl.totalQ).toBe(8)
    expect(tl.warnings).toHaveLength(0)
  })

  it('简单反复：1 次重复展开为演奏序', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60, forward: true }),
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2', backward: true }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes.map((n) => n.measure)).toEqual([1, 2, 1, 2])
    expect(tl.notes.map((n) => n.playIndex)).toEqual([0, 1, 2, 3])
    expect(tl.notes.map((n) => n.startQ)).toEqual([0, 4, 8, 12])
    expect(tl.totalQ).toBe(16)
    expect(tl.warnings).toHaveLength(0)
  })

  it('volta 1/2 房子：二遍跳一房子奏二房子', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60, forward: true }),
      measureXml(noteXml('D', 4, { dur: 4 }), {
        number: '2',
        endingStart: '1',
        endingStop: '1',
        backward: true,
      }),
      measureXml(noteXml('E', 4, { dur: 4 }), { number: '3', endingStart: '2', endingStop: '2' }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'C4', 'E4'])
    expect(tl.notes.map((n) => n.measure)).toEqual([1, 2, 1, 3])
    expect(tl.notes.map((n) => n.startQ)).toEqual([0, 4, 8, 12])
    expect(tl.totalQ).toBe(16)
    expect(tl.warnings).toHaveLength(0)
  })

  it('D.C. al Fine：跳回头部奏到 Fine 为止', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60 }),
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2', words: 'Fine' }),
      measureXml(noteXml('E', 4, { dur: 4 }), { number: '3', words: 'D.C. al Fine' }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'E4', 'C4', 'D4'])
    expect(tl.notes.map((n) => n.startQ)).toEqual([0, 4, 8, 12, 16])
    expect(tl.totalQ).toBe(20)
    expect(tl.warnings).toHaveLength(0)
  })

  it('D.S. al Coda：segno 跳回 + To Coda 跳 coda', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60, segno: true }),
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2', words: 'To Coda' }),
      measureXml(noteXml('E', 4, { dur: 4 }), { number: '3', words: 'D.S. al Coda' }),
      measureXml(noteXml('F', 4, { dur: 4 }), { number: '4', coda: true }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'E4', 'C4', 'D4', 'F4'])
    expect(tl.notes.map((n) => n.startQ)).toEqual([0, 4, 8, 12, 16, 20])
    expect(tl.totalQ).toBe(24)
    expect(tl.warnings).toHaveLength(0)
  })

  it('backward repeat 单独占一小节：不误跳、2 房子正常奏', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 4 }), { divisions: 1, time: [4, 4], tempo: 60, forward: true }),
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2', endingStart: '1', endingStop: '1' }),
      measureXml('', { number: '3', backward: true }), // 反复线与 1 房子分离的空小节
      measureXml(noteXml('E', 4, { dur: 4 }), { number: '4', endingStart: '2', endingStop: '2' }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'C4', 'E4'])
    expect(tl.notes.map((n) => n.measure)).toEqual([1, 2, 1, 4])
    // 空反复小节按拍号全长推进游标
    expect(tl.notes.map((n) => n.startQ)).toEqual([0, 4, 12, 20])
    expect(tl.totalQ).toBe(24)
    expect(tl.warnings).toHaveLength(0)
  })

  it('小节时值与拍号不符：收集 warnings 不抛异常', () => {
    const xml = scoreXml([
      measureXml(noteXml('C', 4, { dur: 2 }), { divisions: 1, time: [4, 4], tempo: 60 }), // 2 ≠ 4
      measureXml(noteXml('D', 4, { dur: 4 }), { number: '2' }),
    ])
    const tl = parseDeterministicTimeline(xml)
    expect(tl.warnings.length).toBe(1)
    expect(tl.warnings[0]).toContain('小节 1')
    expect(tl.notes).toHaveLength(2)
    expect(tl.totalQ).toBe(6)
  })
})

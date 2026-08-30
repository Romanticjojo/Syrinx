import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expandRepeats, parseMusicXml } from './musicxml'

/** 构造最小 MusicXML：divisions=2（八分音符=1）、3/4 拍、tempo=60 */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`

/** 多声部 + backup/forward 的最小样例：divisions=1（四分音符=1）、tempo=60 */
const VOICES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>
      <note><rest/><duration>2</duration><voice>1</voice><type>half</type></note>
      <backup><duration>4</duration></backup>
      <note><rest/><duration>1</duration><voice>2</voice><type>quarter</type></note>
      <forward><duration>1</duration><voice>2</voice></forward>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`

describe('parseMusicXml 多声部（backup/forward）', () => {
  const tl = parseMusicXml(VOICES_XML)

  it('backup 回退游标：voice2 的音落在正确时间', () => {
    // voice1: C5 @0s(2拍) + rest 2拍；backup 回到 0；voice2: rest 1拍 + forward 1拍 + E4 @2s(2拍)
    const c5 = tl.notes.find((n) => n.midi === 72)
    const e4 = tl.notes.find((n) => n.midi === 64)
    expect(c5).toMatchObject({ time: 0, measure: 1 })
    expect(e4).toMatchObject({ time: 2, duration: 2, measure: 1 })
  })

  it('backup 不推进小节总时长：measureTimes[1] 不存在，durationSec=4s', () => {
    // 单小节 4 拍 @60bpm = 4s；backup/forward 不应使游标溢出到 8 拍
    expect(tl.measureTimes).toEqual([{ measure: 1, time: 0 }])
    expect(tl.durationSec).toBe(4)
  })
})

describe('parseMusicXml', () => {
  const tl = parseMusicXml(XML)

  it('解析 tempo 与 secPerQuarter', () => {
    expect(tl.tempo).toBe(60)
    expect(tl.secPerQuarter).toBeCloseTo(1, 5)
  })

  it('按 divisions 换算时间：quarter=1s，half=2s', () => {
    expect(tl.notes[0]).toMatchObject({ time: 0, duration: 1, midi: 60, measure: 1 })
    expect(tl.notes[1]).toMatchObject({ time: 1, duration: 2, midi: 62 })
  })

  it('休止符占时值但不进 notes；小节时间累积正确', () => {
    // 第 2 小节从 3s 开始：休止 1s + bA3(56，含 alter=-1) 1s + B4(71) 1s
    expect(tl.measureTimes).toEqual([
      { measure: 1, time: 0 },
      { measure: 2, time: 3 },
    ])
    expect(tl.notes[2]).toMatchObject({ time: 4, midi: 56, measure: 2 })
    expect(tl.notes[3]).toMatchObject({ time: 5, midi: 71 })
  })

  it('durationSec 为末音结束时间', () => {
    expect(tl.durationSec).toBe(6)
  })

  it('解析真实 lumiere 曲谱（3/4、84bpm、16 小节、divisions=16）', () => {
    const xml = readFileSync('public/songs/lumiere/score.musicxml', 'utf-8')
    const t = parseMusicXml(xml)
    expect(t.tempo).toBe(84)
    expect(t.measureTimes).toHaveLength(16)
    expect(t.measureTimes[1]).toMatchObject({ measure: 2, time: 3 * (60 / 84) })
    expect(t.notes.length).toBeGreaterThan(20)
    expect(t.durationSec).toBeGreaterThan(30)
  })

  it('解析 luv-letter Song Pack 曲谱（正式曲目接入格式）', () => {
    const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')
    const t = parseMusicXml(xml)
    expect(t.notes.length).toBeGreaterThan(0)
    expect(t.measureTimes.length).toBeGreaterThan(0)
    expect(t.durationSec).toBeGreaterThan(0)
  })
})

describe('expandRepeats 反复展开', () => {
  /** 两小节段落带 forward@1 / backward@2 反复（每段演奏两遍） */
  const REPEAT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <barline location="right"><repeat direction="forward"/></barline>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`

  it('forward→backward 段展开成实体小节并顺序重编号', () => {
    const expanded = expandRepeats(REPEAT_XML)
    const tl = parseMusicXml(expanded)
    // C D C D E：演奏序 5 小节
    expect(tl.measureTimes.map((m) => m.measure)).toEqual([1, 2, 3, 4, 5])
    expect(tl.notes.map((n) => n.midi)).toEqual([72, 74, 72, 74, 76])
    expect(tl.durationSec).toBe(20)
  })

  it('展开后不含 repeat 标记（语义已物化，OSMD 渲染线性谱）', () => {
    const expanded = expandRepeats(REPEAT_XML)
    expect(expanded).not.toContain('<repeat')
  })

  it('无反复的谱原样返回（luv-letter 清洗谱 no-op）', () => {
    const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')
    expect(expandRepeats(xml)).toBe(xml)
  })

  it('含 D.C. 的谱不支持展开，原样返回', () => {
    const dcXml = REPEAT_XML.replace(
      '<note><pitch><step>E</step>',
      '<direction><direction-type><words>D.C. al Fine</words></direction-type></direction><note><pitch><step>E</step>',
    )
    expect(expandRepeats(dcXml)).toBe(dcXml)
  })
})

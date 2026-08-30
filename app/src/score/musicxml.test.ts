import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMusicXml } from './musicxml'

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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyBeats, type BeatsFile } from './anchors'
import { parseMusicXml } from './musicxml'

/** 最小时间轴替身：3 小节 4/4，假 tempo=50（m2 起换 100 模拟假变速） */
const FAKE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>50</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>100</per-minute></metronome></direction-type></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`

describe('applyBeats 伴奏锚点重写', () => {
  const tl = parseMusicXml(FAKE_XML)

  it('全部小节有锚点：measureTimes/notes/tempo 全部重映射', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 1,
      bpm: 90,
      anchors: [
        { m: 1, t: 0 },
        { m: 2, t: 2.6667 },
        { m: 3, t: 5.3333 },
      ],
    }
    const out = applyBeats(tl, beats)
    expect(out.tempo).toBe(90)
    expect(out.secPerQuarter).toBeCloseTo(60 / 90, 5)
    // 小节时间 = 锚点值
    expect(out.measureTimes[0].time).toBe(0)
    expect(out.measureTimes[1].time).toBeCloseTo(2.6667, 3)
    expect(out.measureTimes[2].time).toBeCloseTo(5.3333, 3)
    // 终点标记：末小节起点 + 4 拍 @90bpm
    expect(out.measureTimes[3].time).toBeCloseTo(5.3333 + 4 * (60 / 90), 3)
    // 音符跟随小节起点（假 tempo 50→100 的拉伸被锚点抹平）
    expect(out.notes[0].time).toBe(0)
    expect(out.notes[1].time).toBeCloseTo(2.6667, 3)
    expect(out.notes[2].time).toBeCloseTo(5.3333, 3)
    // 音符时长换算到锚定速率：4 拍 @90bpm = 2.6667s
    expect(out.notes[0].duration).toBeCloseTo(4 * (60 / 90), 3)
  })

  it('缺锚点的小节按四分音符位置在相邻锚点间插值', () => {
    const beats: BeatsFile = {
      songId: 'x',
      version: 1,
      bpm: 90,
      anchors: [
        { m: 1, t: 0 },
        { m: 3, t: 6 },
      ],
    }
    const out = applyBeats(tl, beats)
    // m2 = 中点（四分音符位置 4 在 0 与 8 的正中）
    expect(out.measureTimes[1].time).toBeCloseTo(3, 3)
    expect(out.notes[1].time).toBeCloseTo(3, 3)
  })

  it('锚点与曲谱小节对不上号：原样返回（回退恒速）', () => {
    const beats: BeatsFile = { songId: 'x', version: 1, bpm: 90, anchors: [{ m: 99, t: 5 }] }
    expect(applyBeats(tl, beats)).toBe(tl)
  })

  it('luv-letter 真实数据：62 小节锚点落地，m1≈0.2s、m62≈261.75s（t_3b9cfc25）', () => {
    const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')
    const beats = JSON.parse(
      readFileSync('public/songs/luv-letter/beats.json', 'utf-8'),
    ) as BeatsFile
    expect(beats.anchors).toHaveLength(62)
    const out = applyBeats(parseMusicXml(xml), beats)
    expect(out.tempo).toBe(90)
    expect(out.measureTimes[0].time).toBeCloseTo(beats.anchors[0].t, 2)
    expect(out.measureTimes[61].time).toBeCloseTo(beats.anchors[61].t, 2)
    // 逐拍错位修复的直接体现：m20 锚点 ≈70s 量级（假 tempo 时间轴是 87.7s，差 17s）
    expect(out.measureTimes[19].time).toBeLessThan(75)
    // 音符重映射后不早于其小节锚点
    const m20 = out.notes.filter((n) => n.measure === 20)
    expect(m20.length).toBeGreaterThan(0)
    expect(Math.min(...m20.map((n) => n.time))).toBeGreaterThanOrEqual(out.measureTimes[19].time - 0.01)
  })
})

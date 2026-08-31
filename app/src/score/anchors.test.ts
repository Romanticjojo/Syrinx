import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyBeats, type BeatsFile } from './anchors'
import { expandRepeats, parseMusicXml } from './musicxml'

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

  it('luv-letter 真实数据：Soundslice 精校谱 + v3 锚点（97 播放序）落地（t_76c0cbff）', () => {
    // 新谱带反复记号：与应用 loadSong 一致，先 expandRepeats 再 parse → applyBeats
    const raw = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8').replace(
      /^<\?xml[^>]*\?>/,
      (m) => m.replace(/'/g, '"'),
    )
    const beats = JSON.parse(
      readFileSync('public/songs/luv-letter/beats.json', 'utf-8'),
    ) as BeatsFile
    // v3：锚点按展开后播放序 1..97 标定，严格递增、无负值
    expect(beats.version).toBe(3)
    expect(beats.anchors).toHaveLength(97)
    const ts = beats.anchors.map((a) => a.t)
    expect(ts[0]).toBeGreaterThanOrEqual(0)
    for (const [i, t] of ts.entries()) {
      if (i === 0) continue
      expect(t, `anchor#${i + 1}`).toBeGreaterThan(ts[i - 1])
    }
    const out = applyBeats(parseMusicXml(expandRepeats(raw)), beats)
    expect(out.tempo).toBe(90)
    expect(out.measureTimes).toHaveLength(98) // 97 播放小节 + 终点标记
    expect(out.measureTimes[0].time).toBeCloseTo(beats.anchors[0].t, 2)
    expect(out.measureTimes[96].time).toBeCloseTo(beats.anchors[96].t, 2)
    // 终点标记：末锚点 + 4 拍 @90bpm 外推
    expect(out.measureTimes[97].time).toBeCloseTo(beats.anchors[96].t + 4 * (60 / 90), 2)
    // durationSec 同步重映射到锚定系（否则恒速网格旧值会让主循环提前结束）
    expect(out.durationSec).toBeGreaterThanOrEqual(beats.anchors[96].t)
    // 抽查印谱 m36（播放序 46）与 m70 首遍（播放序 92）：锚点值原样落地
    expect(out.measureTimes[45].time).toBeCloseTo(beats.anchors[45].t, 2)
    expect(out.measureTimes[91].time).toBeCloseTo(beats.anchors[91].t, 2)
    // 音符重映射后不早于其小节锚点（抽查 m36 / m70 / 末小节 m72 播放序 97）
    for (const mno of [46, 92, 97]) {
      const ns = out.notes.filter((n) => n.measure === mno)
      expect(ns.length, `m${mno}`).toBeGreaterThan(0)
      expect(Math.min(...ns.map((n) => n.time))).toBeGreaterThanOrEqual(
        out.measureTimes[mno - 1].time - 0.01,
      )
    }
  })
})

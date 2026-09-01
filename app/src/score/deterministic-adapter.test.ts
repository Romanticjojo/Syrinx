import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildScoreTimeline,
  deterministicToTimeline,
  pitchToMidi,
} from './deterministic-adapter'
import { parseDeterministicTimeline } from './deterministic-timeline'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from './musicxml'
import { loadSong } from '../songs'
import type { SongManifest } from '../types'
import { applyAnchorOffset, applyBeats, type BeatsFile } from './anchors'

/**
 * 转换器最小样例：divisions=2（八分音符=1）、3/4 拍、tempo=60。
 * m1：装饰音 C5（剔除）+ C4 + 休止 + A4；m2：纯休止半小节 + D4（休止小节仍有 rest 条目）。
 */
const CONV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><grace/><pitch><step>C</step><octave>5</octave></pitch><voice>1</voice></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>4</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`

describe('pitchToMidi 科学音高 → MIDI', () => {
  it('C4=60、A4=69', () => {
    expect(pitchToMidi('C4')).toBe(60)
    expect(pitchToMidi('A4')).toBe(69)
  })
  it('升号/降号/多升号/低八度', () => {
    expect(pitchToMidi('F#4')).toBe(66)
    expect(pitchToMidi('Bb3')).toBe(58)
    expect(pitchToMidi('C#5')).toBe(73)
    expect(pitchToMidi('C1')).toBe(24)
  })
})

describe('deterministicToTimeline 转换器', () => {
  const dt = parseDeterministicTimeline(CONV_XML)
  const tl = deterministicToTimeline(dt)

  it('剔除 rest 与 grace，midi 换算正确', () => {
    // grace C5 与两个休止都不进 notes；只留 C4 / A4 / D4
    expect(tl.notes.map((n) => n.midi)).toEqual([60, 69, 62])
  })

  it('time/duration 由 t0Sec/t1Sec 换算，measure 用谱面小节号', () => {
    expect(tl.notes[0]).toEqual({ time: 0, duration: 1, midi: 60, measure: 1 })
    expect(tl.notes[1]).toEqual({ time: 2, duration: 1, midi: 69, measure: 1 })
    expect(tl.notes[2]).toEqual({ time: 5, duration: 1, midi: 62, measure: 2 })
  })

  it('measureTimes 按演奏序每小节一项（含纯休止小节），末项 end 标记', () => {
    expect(tl.measureTimes).toEqual([
      { measure: 1, time: 0, quarters: 0 },
      { measure: 2, time: 3, quarters: 3 },
      { measure: 3, time: 6, quarters: 6, end: true },
    ])
  })

  it('durationSec = endSec；tempo/secPerQuarter 取首段 BPM', () => {
    expect(tl.durationSec).toBe(6)
    expect(tl.tempo).toBe(60)
    expect(tl.secPerQuarter).toBe(1)
  })

  it('未物化反复：同号小节按演奏序形成多个 measureTimes 游程', () => {
    // |: C :| D E 的原始谱（反复记号未物化），确定性解析器内部展开为 C C D C D E
    const repeatXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <barline location="right"><repeat direction="forward"/></barline>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`
    const rt = deterministicToTimeline(parseDeterministicTimeline(repeatXml))
    // 段落反复 C D C D E：演奏序 5 小节，同号 m1/m2 各出现两次（游程）
    expect(rt.notes.map((n) => n.midi)).toEqual([60, 62, 60, 62, 64])
    expect(rt.measureTimes.map((e) => e.measure)).toEqual([1, 2, 1, 2, 3, 4])
    expect(rt.measureTimes.map((e) => e.quarters)).toEqual([0, 4, 8, 12, 16, 20])
    expect(rt.measureTimes[5]).toMatchObject({ end: true })
  })

  it('buildScoreTimeline 端到端 = deterministicToTimeline ∘ parseDeterministicTimeline', () => {
    expect(buildScoreTimeline(CONV_XML)).toEqual(tl)
  })
})

describe('loadSong 双数据源切换（PlanB T2）', () => {
  /** loadSong 用最小谱：divisions=1、tempo=60，两小节 */
  const SIMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`

  const BEATS: BeatsFile = {
    songId: 't',
    version: 6,
    bpm: 60,
    anchors: [
      { m: 1, t: 0 },
      { m: 2, t: 3 },
    ],
  }

  const manifest = (): SongManifest => ({
    id: 't',
    title: 'T',
    composer: 'C',
    difficulty: 1,
    durationLabel: '0:04',
    keyLabel: 'C 大调',
    description: 'test',
    tags: [],
    scoreUrl: '/songs/t/score.musicxml',
    accent: '#ffffff',
    backgroundTheme: 'aurora',
    bpm: 60,
  })

  const stubFetch = (beats?: BeatsFile): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (beats && path.endsWith('beats.json')) {
        return { ok: true, status: 200, text: async () => '', json: async () => beats }
      }
      return { ok: true, status: 200, text: async () => SIMPLE_XML, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('缺省（anchors）：无 beatsUrl 时与恒速 parseMusicXml 链路逐字段一致（回归保护）', async () => {
    stubFetch()
    const { timeline } = await loadSong(manifest())
    const expected = parseMusicXml(expandRepeats(stripForcedBreaks(SIMPLE_XML)))
    expect(timeline).toEqual(expected)
  })

  it('anchors：beatsUrl + anchorOffsetMs 照常生效（与改造前链路一致）', async () => {
    stubFetch(BEATS)
    const m = { ...manifest(), beatsUrl: '/songs/t/beats.json', anchorOffsetMs: 1000 }
    const { timeline } = await loadSong(m)
    const expected = applyAnchorOffset(
      applyBeats(parseMusicXml(expandRepeats(stripForcedBreaks(SIMPLE_XML))), BEATS),
      1,
    )
    expect(timeline).toEqual(expected)
  })

  it('score：manifest.cursorMode = "score" 时走确定性 adapter', async () => {
    const fetchMock = stubFetch()
    const { timeline, cursorMode } = await loadSong({ ...manifest(), cursorMode: 'score' })
    expect(cursorMode).toBe('score')
    expect(timeline).toEqual(
      deterministicToTimeline(parseDeterministicTimeline(expandRepeats(stripForcedBreaks(SIMPLE_XML)))),
    )
    // score 路径不依赖伴奏锚点：只应拉取曲谱一次
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('score：manifest 带 beatsUrl/anchorOffsetMs 也忽略（确定性路线零锚点依赖）', async () => {
    const fetchMock = stubFetch(BEATS)
    const m = { ...manifest(), cursorMode: 'score' as const, beatsUrl: '/songs/t/beats.json', anchorOffsetMs: 1000 }
    const { timeline } = await loadSong(m)
    expect(timeline).toEqual(
      deterministicToTimeline(parseDeterministicTimeline(expandRepeats(stripForcedBreaks(SIMPLE_XML)))),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('运行时覆盖：第二参数优先于 manifest.cursorMode（T3 A/B 切换用）', async () => {
    stubFetch()
    const { cursorMode, timeline } = await loadSong(
      { ...manifest(), cursorMode: 'anchors' },
      { cursorMode: 'score' },
    )
    expect(cursorMode).toBe('score')
    expect(timeline).toEqual(buildScoreTimeline(expandRepeats(stripForcedBreaks(SIMPLE_XML))))

    const back = await loadSong({ ...manifest(), cursorMode: 'score' }, { cursorMode: 'anchors' })
    expect(back.cursorMode).toBe('anchors')
    expect(back.timeline).toEqual(parseMusicXml(expandRepeats(stripForcedBreaks(SIMPLE_XML))))
  })
})

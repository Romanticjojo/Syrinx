import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SONGS } from './index'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'

/**
 * interstellar 接入（2026-09-05 Soundslice 官方 MusicXML 重交付）：
 * 长笛独奏谱 393 小节 / 1514 发音音符，3/4 拍 C 大调，无反复记号（已展开），
 * 显式 metronome 120qpm → 全曲 1179q ≈ 589.5s，与钢琴伴奏音频（592.6s，尾静音 ~3s）一致。
 */
describe('interstellar 接入', () => {
  const raw = readFileSync('public/songs/interstellar/score.musicxml', 'utf-8').replace(
    /^<\?xml[^>]*\?>/,
    (m) => m.replace(/'/g, '"'),
  )
  const xml = expandRepeats(stripForcedBreaks(raw))
  const timeline = parseMusicXml(xml)

  it('已登记进 SONGS 且声明伴奏与 beats', () => {
    const s = SONGS.find((x) => x.id === 'interstellar')
    expect(s).toBeTruthy()
    expect(s!.accompanimentUrl).toBe('/songs/interstellar/accompaniment.mp3')
    expect(s!.beatsUrl).toBe('/songs/interstellar/beats.json')
  })

  it('谱面解析：393 小节（末项 end 标记除外）/ 1514 发音音符 / 恒速 120qpm', () => {
    expect(timeline.measureTimes.filter((m) => !m.end).length).toBe(393)
    expect(timeline.notes.length).toBe(1514)
    expect(timeline.tempo).toBe(120)
  })

  it('曲式：长笛奏至 m262（≈393s）后休止，终章为钢琴独奏；时间轴覆盖全曲 589.5s', () => {
    // 长笛最后一个音符在 m262 结束（393s）——m263-393 为 131 小节全小节休止
    expect(timeline.durationSec).toBeGreaterThan(390)
    expect(timeline.durationSec).toBeLessThan(396)
    // 小节时间轴（光标插值用）必须覆盖到全曲末（end 标记 = 1179q × 0.5s = 589.5s）
    const end = timeline.measureTimes[timeline.measureTimes.length - 1]
    expect(end.end).toBe(true)
    expect(end.quarters).toBe(1179)
    expect(end.time).toBeCloseTo(589.5, 1)
  })
})

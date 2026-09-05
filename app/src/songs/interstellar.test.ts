import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SONGS } from './index'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'

/**
 * interstellar 接入（2026-09-05 拼谱修复）：Soundslice 交付谱实为
 * 完整谱(m1-131) + 长笛分谱(m132-262) + 钢琴分谱(m263-393) 的三段拼接，
 * 伴奏音频同构（伴奏 + 195s 纯静音 + 同伴奏重播）。修复后：
 * 长笛谱 = 131 小节 / 731 发音音符，3/4 拍 C 大调，恒速 120qpm ≈ 196.5s；
 * 钢琴谱 = piano.musicxml 大谱表（staves=2），同 131 小节时间轴。
 * 详见 resources/interstellar/score/omr-work/franken_backup_0905/。
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

  it('谱面解析：131 小节（末项 end 标记除外）/ 757 发音音符（app 口径含 grace）/ 恒速 120qpm', () => {
    expect(timeline.measureTimes.filter((m) => !m.end).length).toBe(131)
    expect(timeline.notes.length).toBe(757)
    expect(timeline.tempo).toBe(120)
  })

  it('时间轴 ≈196.5s 与裁剪后伴奏（199.5s）一致；end 标记覆盖曲末', () => {
    expect(timeline.durationSec).toBeGreaterThan(195)
    expect(timeline.durationSec).toBeLessThan(199)
    // 小节时间轴（光标插值用）必须覆盖到曲末（end 标记 = 393q × 0.5s = 196.5s）
    const end = timeline.measureTimes[timeline.measureTimes.length - 1]
    expect(end.end).toBe(true)
    expect(end.quarters).toBe(393)
    expect(end.time).toBeCloseTo(196.5, 1)
  })

  it('钢琴伴奏谱 piano.musicxml：同 131 小节大谱表，可被同一解析器读取', () => {
    const praw = readFileSync('public/songs/interstellar/piano.musicxml', 'utf-8').replace(
      /^<\?xml[^>]*\?>/,
      (m) => m.replace(/'/g, '"'),
    )
    const pxml = expandRepeats(stripForcedBreaks(praw))
    const ptl = parseMusicXml(pxml)
    expect(ptl.measureTimes.filter((m) => !m.end).length).toBe(131)
    // parseMusicXml 只取主声部（voice1）= 右手旋律 533 音符，时间轴与长笛谱一致
    expect(ptl.notes.length).toBe(533)
    expect(ptl.tempo).toBe(120)
    expect(ptl.durationSec).toBeCloseTo(196.5, 1)
  })
})

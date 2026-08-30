import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMusicXml } from './musicxml'

/**
 * Luv Letter OMR 产物（任务 t_54968084）+ 73 小节补全（任务 t_d02450b9）回归测试：
 * 图片谱 OMR → 73 小节完整单声部长笛谱；假 tempo（50/56.5/50）已废弃，
 * 改为诚实恒速 90bpm（= beats.json bpm），逐小节真实时刻由伴奏锚点重写（见 anchors.test.ts）。
 * 注：OSMD 真实渲染验证用浏览器 e2e（happy-dom 无 canvas，OSMD 文字测量会崩）。
 */
const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')

describe('luv-letter OMR 谱 timeline', () => {
  it('parseMusicXml：73 小节（+终点标记）、恒速 90bpm', () => {
    const tl = parseMusicXml(xml)
    expect(tl.tempo).toBe(90)
    expect(tl.measureTimes).toHaveLength(74)
    expect(tl.measureTimes[73]).toMatchObject({ measure: 74, end: true })
    expect(tl.notes.length).toBeGreaterThan(700)
    // 4/4，第 2 小节从 4 拍后开始（60/90≈0.667s per quarter）
    expect(tl.measureTimes[1]).toMatchObject({ measure: 2, time: 4 * (60 / 90) })
  })

  it('单声部清洗到位：仅 voice 1，无 backup/chord/repeat 残留', () => {
    expect(xml).not.toContain('<backup')
    expect(xml).not.toContain('<chord/>')
    expect(xml).not.toContain('<repeat')
    // 长笛谱单音单声部：voice 标签只出现 voice 1
    const voices = new Set(xml.match(/<voice>[^<]*<\/voice>/g) ?? [])
    expect(voices).toEqual(new Set(['<voice>1</voice>']))
  })

  it('每小节严格 4 拍 @90bpm（73 小节时值守恒）', () => {
    const tl = parseMusicXml(xml)
    const expected = 4 * (60 / 90)
    for (let i = 0; i < 73; i++) {
      const delta = tl.measureTimes[i + 1].time - tl.measureTimes[i].time
      expect(Math.abs(delta - expected)).toBeLessThan(0.01)
    }
    // 网格终点 = 73×4 拍 @90bpm ≈ 194.7s；伴奏 270.4s 含反复段，逐小节由锚点对齐
    expect(Math.abs(tl.measureTimes[73].time - 73 * expected)).toBeLessThan(0.01)
    expect(tl.durationSec).toBeGreaterThan(190)
    expect(tl.durationSec).toBeLessThan(196)
  })
})

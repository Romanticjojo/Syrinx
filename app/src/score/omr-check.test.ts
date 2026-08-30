import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMusicXml } from './musicxml'

/**
 * Luv Letter OMR 产物（任务 t_54968084）+ 单声部清洗（任务 t_a857b79e）回归测试：
 * 图片谱 OMR → 单声部长笛谱的 timeline 必须与 4:29（270.4s）伴奏对齐。
 * 注：OSMD 真实渲染验证用浏览器 e2e（happy-dom 无 canvas，OSMD 文字测量会崩）。
 */
const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')

describe('luv-letter OMR 谱 timeline', () => {
  it('parseMusicXml：62 小节（+终点标记）、durationSec≈4:29（270.4s 伴奏）', () => {
    const tl = parseMusicXml(xml)
    expect(tl.tempo).toBe(50)
    expect(tl.measureTimes).toHaveLength(63)
    expect(tl.measureTimes[62]).toMatchObject({ measure: 63, end: true })
    expect(tl.notes.length).toBeGreaterThan(500)
    // 4/4，第 2 小节从 4 拍后开始（60/50=1.2s per quarter）
    expect(tl.measureTimes[1]).toMatchObject({ measure: 2, time: 4 * (60 / 50) })
    // m6 换速 56.5：m6 起 = 5*4*(60/50)=24s
    expect(Math.abs(tl.measureTimes[5].time - 24)).toBeLessThan(0.01)
    // m57 恢复 50
    expect(Math.abs(tl.measureTimes[56].time - (24 + 51 * 4 * (60 / 56.5)))).toBeLessThan(0.01)
    // 总时长与伴奏 270.4s 对齐（±2s）
    expect(tl.durationSec).toBeGreaterThan(268)
    expect(tl.durationSec).toBeLessThan(272)
  })

  it('单声部清洗到位：仅 voice 1，无 backup/chord/repeat 残留', () => {
    expect(xml).not.toContain('<backup')
    expect(xml).not.toContain('<chord/>')
    expect(xml).not.toContain('<repeat')
    // 长笛谱单音单声部：voice 标签只出现 voice 1
    const voices = new Set(xml.match(/<voice>[^<]*<\/voice>/g) ?? [])
    expect(voices).toEqual(new Set(['<voice>1</voice>']))
  })

  it('每小节严格 4 拍（OMR 超拍噪声已截齐）', () => {
    const tl = parseMusicXml(xml)
    // 62 小节全部 4/4：任意小节时长 = 4 拍 × 该小节生效的秒/拍
    // tempo 分段（direction 在小节首生效）：m1-5→50，m6-56→56.5，m57-62→50；
    // 终点标记（measureTimes[62]）给出网格终点
    const gridEnd = tl.measureTimes[62].time
    for (let i = 0; i < 62; i++) {
      const measureNo = i + 1
      const tempo = measureNo >= 6 && measureNo <= 56 ? 56.5 : 50
      const expected = 4 * (60 / tempo)
      const delta = tl.measureTimes[i + 1].time - tl.measureTimes[i].time
      expect(Math.abs(delta - expected)).toBeLessThan(0.01)
    }
    // 网格终点 ≈ 伴奏 270.4s（durationSec 末音口径同点）
    expect(Math.abs(gridEnd - 269.44)).toBeLessThan(0.1)
  })
})

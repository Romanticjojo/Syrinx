import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMusicXml } from './musicxml'

/**
 * Luv Letter OMR 产物（任务 t_54968084）回归测试：
 * 图片谱 OMR → MusicXML 的 timeline 必须与 4:29（269.4s）伴奏对齐。
 * 注：OSMD 真实渲染验证用浏览器 e2e（happy-dom 无 canvas，OSMD 文字测量会崩）。
 */
const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')

describe('luv-letter OMR 谱 timeline', () => {
  it('parseMusicXml：62 小节、durationSec≈4:29（269.4s）', () => {
    const tl = parseMusicXml(xml)
    expect(tl.tempo).toBe(50)
    expect(tl.measureTimes).toHaveLength(62)
    expect(tl.notes.length).toBeGreaterThan(500)
    // 4/4，第 2 小节从 4 拍后开始（60/50=1.2s per quarter）
    expect(tl.measureTimes[1]).toMatchObject({ measure: 2, time: 4 * (60 / 50) })
    // m6 换速 56.5：m6 起 = 5*4*(60/50)=24s
    expect(Math.abs(tl.measureTimes[5].time - 24)).toBeLessThan(0.01)
    // m57 恢复 50
    expect(Math.abs(tl.measureTimes[56].time - (24 + 51 * 4 * (60 / 56.5)))).toBeLessThan(0.01)
    // 总时长与伴奏 269.4s 对齐（±1s）
    expect(tl.durationSec).toBeGreaterThan(268)
    expect(tl.durationSec).toBeLessThan(271)
  })

  it('多声部 backup/forward 已正确处理（不产生游标溢出）', () => {
    const tl = parseMusicXml(xml)
    // 每小节 4/4：若 backup 被误当前进，62 小节会溢出到 >290s
    expect(tl.durationSec / tl.measureTimes.length).toBeLessThan(4.8)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { parseMusicXml } from './musicxml'

/**
 * OMR 产物验证：真实 OSMD 加载渲染 + timeline 统计。
 * 仅本地验证用，验证通过后删除。
 */
const xml = readFileSync(
  'D:/Syrinx/resources/luv-letter/score/omr-work/luv-letter-final.musicxml',
  'utf-8',
)

describe('luv-letter OMR 产物', () => {
  it('parseMusicXml 时间轴：62 小节、durationSec≈4:29', () => {
    const tl = parseMusicXml(xml)
    expect(tl.tempo).toBe(50)
    expect(tl.measureTimes).toHaveLength(62)
    expect(tl.notes.length).toBeGreaterThan(500)
    // 4/4，第 2 小节从 4 拍后开始（60/50=1.2s per quarter）
    expect(tl.measureTimes[1]).toMatchObject({ measure: 2, time: 4 * (60 / 50) })
    // m6 换速 56.5：m6 起 = 5*4*(60/50)=24s
    expect(Math.abs(tl.measureTimes[5].time - 24)).toBeLessThan(0.01)
    // 总时长与伴奏 269.4s 对齐（±1s）
    expect(tl.durationSec).toBeGreaterThan(268)
    expect(tl.durationSec).toBeLessThan(271)
  })

  it('OSMD 真实加载渲染无异常', async () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const osmd = new OpenSheetMusicDisplay(div, { autoResize: false })
    await osmd.load(xml)
    osmd.render()
    expect(div.querySelectorAll('svg').length).toBeGreaterThan(0)
  })
})

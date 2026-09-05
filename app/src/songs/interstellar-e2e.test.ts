import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expandRepeats, stripForcedBreaks } from '../score/musicxml'
import { buildScoreTimeline } from '../score/deterministic-adapter'

/**
 * interstellar score 确定性光标路径（anchors 路径由 interstellar.test.ts 覆盖）。
 * 2026-09-05 Soundslice 官方谱重交付后：显式 120qpm，589.5s，1514 发音音符。
 */
describe('interstellar score 确定性路径', () => {
  const raw = readFileSync('public/songs/interstellar/score.musicxml', 'utf-8').replace(
    /^<\?xml[^>]*\?>/,
    (m) => m.replace(/'/g, '"'),
  )
  const xml = expandRepeats(stripForcedBreaks(raw))
  const tl = buildScoreTimeline(xml)

  it('tempo 显式 120qpm，时长约 589.5s（与伴奏音频一致）', () => {
    expect(tl.tempo).toBe(120)
    expect(tl.durationSec).toBeGreaterThan(580)
    expect(tl.durationSec).toBeLessThan(600)
  })
  it('光标停靠音符数（剔除 rest/grace）> 1400', () => {
    expect(tl.notes.length).toBeGreaterThan(1400)
  })
})

import { describe, expect, it } from 'vitest'
import { IN_TUNE_CENTS, noteKind, segSpec } from './PitchChart'

/** 音高图三态着色决策（t_2264e5ba）：
 *  命中高亮 / 偏音红 / 漏音斜纹 的分类与轨迹线规格纯函数。 */
describe('noteKind：目标音符三态分类', () => {
  it('无实测 → miss（漏音，斜纹警示）', () => {
    expect(noteKind({ measuredHz: null, inTune: false })).toBe('miss')
  })

  it('实测且 inTune → hit（命中高亮）', () => {
    expect(noteKind({ measuredHz: 440, inTune: true })).toBe('hit')
  })

  it('实测且偏 → off（偏音）', () => {
    expect(noteKind({ measuredHz: 466.16, inTune: false })).toBe('off')
  })
})

describe('segSpec：实测轨迹段规格', () => {
  it(`±${IN_TUNE_CENTS} 音分内（含端点）：accent 高亮加粗`, () => {
    expect(segSpec(0)).toEqual({ color: 'accent', width: 2.6 })
    expect(segSpec(IN_TUNE_CENTS)).toEqual({ color: 'accent', width: 2.6 })
    expect(segSpec(-IN_TUNE_CENTS)).toEqual({ color: 'accent', width: 2.6 })
  })

  it('超 ±50 音分：偏音红细线', () => {
    expect(segSpec(IN_TUNE_CENTS + 1)).toEqual({ color: 'off', width: 1.4 })
    expect(segSpec(-IN_TUNE_CENTS - 1)).toEqual({ color: 'off', width: 1.4 })
    expect(segSpec(120)).toEqual({ color: 'off', width: 1.4 })
  })
})

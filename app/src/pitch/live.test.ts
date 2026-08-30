import { describe, expect, it } from 'vitest'
import type { NoteEvent } from '../types'
import { LivePitchTracker, midiToHz, midiToNoteName } from './live'

const note = (time: number, duration: number, midi: number): NoteEvent => ({
  time,
  duration,
  midi,
  measure: 1,
})

describe('midiToHz / midiToNoteName', () => {
  it('A4 = 440Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6)
  })

  it('音名与八度', () => {
    expect(midiToNoteName(69)).toBe('A4')
    expect(midiToNoteName(60)).toBe('C4')
    expect(midiToNoteName(70)).toBe('A♯4')
  })
})

describe('LivePitchTracker', () => {
  it('无检测帧：hz 为 null，反馈透传期望音', () => {
    const t = new LivePitchTracker()
    const fb = t.update(null, note(0, 1, 69))
    expect(fb.hz).toBeNull()
    expect(fb.midi).toBe(69)
    expect(fb.cents).toBeNull()
    expect(fb.inTune).toBeNull()
  })

  it('休止段：midi 为 null', () => {
    const t = new LivePitchTracker()
    const fb = t.update(440, null)
    expect(fb.midi).toBeNull()
    expect(fb.cents).toBeNull()
    expect(fb.hz).toBe(440)
  })

  it('440Hz 对 A4：偏差 ≈ 0，判准', () => {
    const t = new LivePitchTracker()
    const fb = t.update(440, note(0, 1, 69))
    expect(fb.cents).not.toBeNull()
    expect(Math.abs(fb.cents!)).toBeLessThan(0.1)
    expect(fb.inTune).toBe(true)
  })

  it('±50 音分边界：+49 准、+60 偏', () => {
    const t = new LivePitchTracker()
    // A4 +50 音分 ≈ 452.9Hz；取 +49 音分
    const sharp49 = 440 * Math.pow(2, 49 / 1200)
    expect(t.update(sharp49, note(0, 1, 69)).inTune).toBe(true)
    t.reset()
    const sharp60 = 440 * Math.pow(2, 60 / 1200)
    expect(t.update(sharp60, note(0, 1, 69)).inTune).toBe(false)
  })

  it('中位数平滑：窗口内一次离群帧不甩指针', () => {
    const t = new LivePitchTracker()
    t.update(440, note(0, 1, 69))
    t.update(440, note(0, 1, 69))
    const fb = t.update(880, note(0, 1, 69)) // 单帧跳八度
    expect(fb.hz).toBe(440)
  })

  it('窗口只留最近 3 帧：连续偏高后跟随新值', () => {
    const t = new LivePitchTracker()
    t.update(440, note(0, 1, 69))
    t.update(440, note(0, 1, 69))
    t.update(460, note(0, 1, 69))
    const fb = t.update(470, note(0, 1, 69))
    expect(fb.hz).toBe(460) // 中位数取中间值
  })

  it('reset 清空平滑窗', () => {
    const t = new LivePitchTracker()
    t.update(440, note(0, 1, 69))
    t.reset()
    const fb = t.update(null, note(0, 1, 69))
    expect(fb.hz).toBeNull()
  })
})

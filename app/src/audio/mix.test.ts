import { describe, expect, it } from 'vitest'
import { mixRateOf, planMix } from './mix'

/** 换算关系铁律（ResultPage 对照播放 seek 公式）：录音局部 t ↔ 伴奏 startSec + t·takeRate */
describe('planMix 混音时间轴映射', () => {
  // 表值全部选二进制精确浮点（1.25 / 0.5 / 0.875），断言无需近似
  const table: Array<{
    name: string
    take: { startSec: number; stopSec: number; playbackRate?: number }
    recDurationSec: number
    accDurationSec: number | null
    expected: { recDuration: number; accStart: number; accRate: number; accDur: number } | null
  }> = [
    {
      name: '原速·起奏即录：窗口 = 录音时长',
      take: { startSec: 0, stopSec: 10 },
      recDurationSec: 10,
      accDurationSec: 30,
      expected: { recDuration: 10, accStart: 0, accRate: 1, accDur: 10 },
    },
    {
      name: '原速·中途开录：窗口从 startSec 起',
      take: { startSec: 4, stopSec: 6 },
      recDurationSec: 2,
      accDurationSec: 20,
      expected: { recDuration: 2, accStart: 4, accRate: 1, accDur: 2 },
    },
    {
      name: '加速录音（1.25）：伴奏窗口 = 录音时长 × rate',
      take: { startSec: 0, stopSec: 10, playbackRate: 1.25 },
      recDurationSec: 8,
      accDurationSec: 30,
      expected: { recDuration: 8, accStart: 0, accRate: 1.25, accDur: 10 },
    },
    {
      name: '减速录音（0.5）·中途开录：窗口压缩且起点平移',
      take: { startSec: 4, stopSec: 6, playbackRate: 0.5 },
      recDurationSec: 4,
      accDurationSec: 20,
      expected: { recDuration: 4, accStart: 4, accRate: 0.5, accDur: 2 },
    },
    {
      name: '伴奏短于录音映射：窗口收敛到伴奏实长，录音不被截断',
      take: { startSec: 0, stopSec: 10 },
      recDurationSec: 10,
      accDurationSec: 5,
      expected: { recDuration: 10, accStart: 0, accRate: 1, accDur: 5 },
    },
    {
      name: 'startSec 超出伴奏末尾：窗口为 0（混音退化为仅录音轨）',
      take: { startSec: 4, stopSec: 6 },
      recDurationSec: 2,
      accDurationSec: 3,
      expected: { recDuration: 2, accStart: 4, accRate: 1, accDur: 0 },
    },
  ]

  it.each(table)('$name', ({ take, recDurationSec, accDurationSec, expected }) => {
    expect(planMix(take, recDurationSec, accDurationSec)).toEqual(expected)
  })

  it('伴奏缺失返回 null（调用方据此禁用混音）', () => {
    expect(planMix({ startSec: 0, stopSec: 2 }, 2, null)).toBeNull()
  })

  it('playbackRate 越界/非法按原速处理（与回放页 takeRate 同口径）', () => {
    for (const bad of [2, 0.1, 0, Number.NaN]) {
      expect(mixRateOf(bad)).toBe(1)
      expect(planMix({ startSec: 0, stopSec: 2, playbackRate: bad }, 2, 10))
        .toEqual({ recDuration: 2, accStart: 0, accRate: 1, accDur: 2 })
    }
  })

  it('录音实长非法时回退 take 元数据时长换算', () => {
    expect(planMix({ startSec: 4, stopSec: 6 }, 0, 20))
      .toEqual({ recDuration: 2, accStart: 4, accRate: 1, accDur: 2 })
    expect(planMix({ startSec: 0, stopSec: 5, playbackRate: 0.5 }, Number.NaN, 20))
      .toEqual({ recDuration: 10, accStart: 0, accRate: 0.5, accDur: 5 })
  })
})

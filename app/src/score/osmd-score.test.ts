import { describe, expect, it } from 'vitest'
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { OSMDScore } from './OSMDScore'
import type { Timeline } from '../types'

/**
 * 光标音值感知推进测试（2026-08-31 光标拍子修复）。
 *
 * 迷你谱：m1 全音符 C5（四分音符位 0–4）+ m2 四分音符 D5（4–5），@90bpm。
 * 通过构造器注入口替换 OSMD 为脚本化 fake cursor（happy-dom 下不真渲染），
 * 走真实 load → 预扫 → syncToTime 全路径断言推进语义。
 */
class FakeCursor {
  /** 每个停靠点的 iterator.currentTimeStamp.RealValue（全音符单位） */
  stops: number[]
  /** 当前停靠点下标；>= stops.length 即 EndReached */
  pos = 0
  nextCount = 0
  resetCount = 0
  colorLog: string[] = []

  constructor(stops: number[]) {
    this.stops = stops
  }

  next(): void {
    this.pos++
    this.nextCount++
  }

  reset(): void {
    this.pos = 0
    this.resetCount++
  }

  show(): void {}

  get iterator(): {
    EndReached: boolean
    currentTimeStamp: { RealValue: number }
  } {
    const self = this
    return {
      get EndReached(): boolean {
        return self.pos >= self.stops.length
      },
      get currentTimeStamp(): { RealValue: number } {
        return { RealValue: self.stops[Math.min(self.pos, self.stops.length - 1)] }
      },
    }
  }

  GNotesUnderCursor(): { setColor: (c: string) => void; sourceNote: { isRest: () => boolean } }[] {
    return [{ setColor: (c) => this.colorLog.push(c), sourceNote: { isRest: () => false } }]
  }
}

function makeFakeOsmd(cursor: FakeCursor): OpenSheetMusicDisplay {
  return { load: async () => {}, render: () => {}, cursor } as unknown as OpenSheetMusicDisplay
}

/** @90bpm：全音符 8/3s，四分音符 2/3s */
const SPQ = 2 / 3
const MINI_TIMELINE: Timeline = {
  durationSec: 10 / 3,
  secPerQuarter: SPQ,
  tempo: 90,
  notes: [
    { time: 0, duration: 4 * SPQ, midi: 72, measure: 1 },
    { time: 4 * SPQ, duration: SPQ, midi: 74, measure: 2 },
  ],
  measureTimes: [
    { measure: 1, time: 0, quarters: 0 },
    { measure: 2, time: 4 * SPQ, quarters: 4 },
    { measure: 3, time: 5 * SPQ, quarters: 5, end: true },
  ],
}

async function makeScore(stops: number[]): Promise<{ score: OSMDScore; cursor: FakeCursor }> {
  const cursor = new FakeCursor(stops)
  const score = new OSMDScore(document.createElement('div'), '#3ddfae', makeFakeOsmd(cursor))
  await score.load('<score/>', MINI_TIMELINE)
  // load() 内的预扫会真实走一遍全谱：清空计数器，让断言只反映后续 syncToTime 的行为
  cursor.nextCount = 0
  cursor.resetCount = 0
  return { score, cursor }
}

describe('OSMDScore 音值感知光标推进', () => {
  it('load 后预扫缓存全部停靠点并回到起点', async () => {
    const { score, cursor } = await makeScore([0, 1])
    expect((score as unknown as { stopQuarters: number[] }).stopQuarters).toEqual([0, 1])
    expect((score as unknown as { useStopTable: boolean }).useStopTable).toBe(true)
    expect(cursor.pos).toBe(0) // 预扫后 reset
  })

  it('长音停留：全音符响到一半光标不动（旧逻辑此处会瞬间掠过）', async () => {
    const { score, cursor } = await makeScore([0, 1])
    score.syncToTime(1.0) // 全音符 [0, 8/3)s 的中段
    expect(cursor.pos).toBe(0)
    expect(cursor.nextCount).toBe(0)
  })

  it('只有下一停靠点开始（t >= 全音符结束 8/3s）才推进到四分音符', async () => {
    const { score, cursor } = await makeScore([0, 1])
    score.syncToTime(1.0)
    score.syncToTime(4 * SPQ - 0.01) // 全音符结束前一瞬
    expect(cursor.pos).toBe(0)
    score.syncToTime(4 * SPQ) // 边界：四分音符开始即推进
    expect(cursor.pos).toBe(1)
  })

  it('曲末不再推进：EndReached 不被驱动越过最后一个停靠点', async () => {
    const { score, cursor } = await makeScore([0, 1])
    score.syncToTime(99)
    expect(cursor.pos).toBe(1)
    expect(cursor.nextCount).toBe(1)
  })

  it('seek 语义：resetCursor 后可一次快进到目标停靠点（只前进）', async () => {
    const { score, cursor } = await makeScore([0, 1])
    score.syncToTime(1.0)
    score.resetCursor()
    expect(cursor.pos).toBe(0)
    score.syncToTime(3.2)
    expect(cursor.pos).toBe(1)
    expect(cursor.nextCount).toBe(1)
  })

  it('高亮跟随当前音：长音期间不重复染色，推进时染 accent', async () => {
    const { score, cursor } = await makeScore([0, 1])
    score.syncToTime(1.0)
    expect(cursor.colorLog).toEqual([]) // 未推进不动高亮
    score.syncToTime(4 * SPQ)
    expect(cursor.colorLog.at(-1)).toBe('#3ddfae')
  })

  it('onMeasureChange 行为不变：按 measureTimes 反查小节', async () => {
    const { score } = await makeScore([0, 1])
    const fired: [number, number][] = []
    score.onMeasureChange = (m, total) => fired.push([m, total])
    score.syncToTime(1.0)
    score.syncToTime(4 * SPQ)
    expect(fired).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('预扫结果为空：回退旧推进逻辑，不崩溃', async () => {
    const { score, cursor } = await makeScore([])
    expect((score as unknown as { useStopTable: boolean }).useStopTable).toBe(false)
    const fired: number[] = []
    score.onMeasureChange = (m) => fired.push(m)
    score.syncToTime(1.0)
    expect(cursor.nextCount).toBe(0) // EndReached 立即为真，无停靠点可走
    expect(fired).toEqual([1])
  })

  // —— sync-tune 调试页可选扩展（noteAtPoint/setMarkers）：fake OSMD（无 GraphicSheet/
  //    无 svg）下降级不崩溃，演奏页路径不受影响 ——
  it('noteAtPoint：无渲染谱面时返回 null，不抛异常', async () => {
    const { score } = await makeScore([0, 1])
    expect(score.noteAtPoint(10, 10)).toBeNull()
  })

  it('setMarkers：空数组清除整层；无 svg 时不建层', async () => {
    const container = document.createElement('div')
    const cursor = new FakeCursor([0, 1])
    const s2 = new OSMDScore(container, '#3ddfae', makeFakeOsmd(cursor))
    await s2.load('<score/>', MINI_TIMELINE)
    expect(container.querySelector('.sync-marker-layer')).toBeNull() // 未调用不建层
    s2.setMarkers([{ measure: 1, rvInMeasure: 0.5, color: '#fff' }])
    expect(container.querySelector('.sync-marker-layer')).toBeNull() // 无 svg：忽略
    s2.setMarkers([])
    expect(container.querySelector('.sync-marker-layer')).toBeNull()
    s2.dispose()
  })
})

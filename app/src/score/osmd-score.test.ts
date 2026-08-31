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
  /** 可注入：当前光标下音符（T3 高亮共存测试用），缺省返回内置单音符（每次新建） */
  notesUnder: { setColor: (c: string) => void; sourceNote: { isRest: () => boolean } }[] | null = null

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
    return (
      this.notesUnder ?? [
        { setColor: (c) => this.colorLog.push(c), sourceNote: { isRest: () => false } },
      ]
    )
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

// -- T3：选中染色 / 小节聚焦 / 命中距离（fake MeasureList 几何，happy-dom 不真渲染 OSMD）--
/** 可断言染色历史的 GraphicalNote 替身 */
type FakeGNote = {
  colors: string[]
  setColor: (c: string) => void
  sourceNote: { isRest: () => boolean }
}
function mkGNote(): FakeGNote {
  const colors: string[] = []
  return { colors, setColor: (c) => colors.push(c), sourceNote: { isRest: () => false } }
}
/** 单小节假几何：staffEntry 相对 x = rv*4（OSMD 单位），y/w/h 与真实谱面同量级 */
function fakeMeasure(num: number, entries: { rv: number; note: FakeGNote }[]) {
  return {
    MeasureNumber: num,
    PositionAndShape: {
      AbsolutePosition: { x: num * 10, y: 20 },
      Size: { width: 8, height: 6 },
    },
    staffEntries: entries.map((e) => ({
      PositionAndShape: { AbsolutePosition: { x: e.rv * 4 } },
      sourceStaffEntry: { Timestamp: { RealValue: e.rv } },
      graphicalVoiceEntries: [{ notes: [e.note] }],
    })),
  }
}
/** 带假 MeasureList 与容器内 svg 的 OSMDScore（不 load，几何方法直接可用） */
function makeGeomScore(ml: unknown[][]): {
  score: OSMDScore
  cursor: FakeCursor
  container: HTMLElement
} {
  const cursor = new FakeCursor([0, 1])
  const container = document.createElement('div')
  container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  const score = new OSMDScore(
    container,
    '#3ddfae',
    {
      load: async () => {},
      render: () => {},
      cursor,
      GraphicSheet: { MeasureList: ml },
    } as unknown as OpenSheetMusicDisplay,
  )
  return { score, cursor, container }
}

describe('OSMDScore T3 选中染色与小节聚焦', () => {
  // m1 两个 staffEntry（rv 0 / 0.25 -> 音符 A / B），m2 一个（rv 0 -> C）
  const A = mkGNote()
  const B = mkGNote()
  const C = mkGNote()
  const ml = [
    [fakeMeasure(1, [
      { rv: 0, note: A },
      { rv: 0.25, note: B },
    ]), fakeMeasure(2, [{ rv: 0, note: C }])],
  ]
  const BASE = '#e8e8e2'

  it('highlightNoteAt：选中 notehead 染 accent，切换时旧选中恢复白', () => {
    const { score } = makeGeomScore(ml)
    score.highlightNoteAt(1, 0.25)
    expect(B.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(2, 0)
    expect(B.colors.at(-1)).toBe(BASE) // 旧选中恢复 baseNoteColor
    expect(C.colors.at(-1)).toBe('#3ddfae')
  })

  it('highlightNoteAt(null)：清除选中恢复白，未选中的不动', () => {
    const { score } = makeGeomScore(ml)
    score.highlightNoteAt(1, 0.25)
    score.highlightNoteAt(null)
    expect(B.colors.at(-1)).toBe(BASE)
    expect(A.colors).toEqual([]) // 从未被染色
  })

  it('与光标高亮共存：光标离开选中音不褪色，清除选中不影响光标音', () => {
    const { score, cursor } = makeGeomScore(ml)
    cursor.stops = [0, 1, 2] // 需要第二个可推进停靠点（stop2 时间 = 8*SPQ）
    cursor.notesUnder = [A]
    score.syncToTime(4 * SPQ) // 光标推进 -> A 染 accent
    expect(A.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(1, 0) // 选中同为 A
    cursor.notesUnder = [C]
    score.syncToTime(8 * SPQ) // 光标移走：A 仍是选中持有者，保持 accent
    expect(A.colors.at(-1)).toBe('#3ddfae')
    expect(C.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(null) // 清除选中：A 恢复白，光标音 C 不动
    expect(A.colors.at(-1)).toBe(BASE)
    expect(C.colors.at(-1)).toBe('#3ddfae')
  })

  it('noteAtPoint：返回与最近音符的欧氏距离', () => {
    const { score } = makeGeomScore(ml)
    // svgRect 全零（happy-dom）：行 y=200..260px，点击 (150,230) 在行内（dy=0）；
    // m1 x=100px，staffEntry rv0/rv0.25 -> x=100/110px，最近为 rv0.25（dx=40）
    const hit = score.noteAtPoint(150, 230)
    expect(hit?.measure).toBe(1)
    expect(hit?.rvInMeasure).toBe(0.25)
    expect(hit?.dist).toBeCloseTo(40, 5)
    // 行外点击：dy 叠入距离（y=80 -> dy=120，dist=hypot(40,120)）
    const far = score.noteAtPoint(150, 80)
    expect(far?.dist).toBeCloseTo(Math.hypot(40, 120), 5)
  })

  it('scrollToMeasure：滚动祖先 scrollTop 定位到小节行中部；未知小节 no-op', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const cursor = new FakeCursor([0, 1])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    scroller.appendChild(container)
    document.body.appendChild(scroller)
    const score = new OSMDScore(
      container,
      '#3ddfae',
      {
        load: async () => {},
        render: () => {},
        cursor,
        GraphicSheet: { MeasureList: ml },
      } as unknown as OpenSheetMusicDisplay,
    )
    // m2：y=20 单位 * unitPx10 = 200px，h=60px -> 行中心 200+30
    score.scrollToMeasure(2)
    const expected = 230 - scroller.clientHeight / 2
    expect(scroller.scrollTop).toBe(expected)
    score.scrollToMeasure(99) // 未知小节：不抛、不动
    expect(scroller.scrollTop).toBe(expected)
    document.body.removeChild(scroller)
  })
})

describe('OSMDScore zoom（谱面缩窄，t_53aa8b7a）', () => {
  it('构造时写入 OSMD 实例（渲染前设置安全）', () => {
    const fake = makeFakeOsmd(new FakeCursor([0, 1]))
    new OSMDScore(document.createElement('div'), '#3ddfae', fake, 1.15)
    expect((fake as unknown as { Zoom: number }).Zoom).toBe(1.15)
  })

  it('缺省 zoom=1：不改变现有几何口径（unitPx=10×Zoom）', () => {
    const fake = makeFakeOsmd(new FakeCursor([0, 1]))
    new OSMDScore(document.createElement('div'), '#3ddfae', fake)
    expect((fake as unknown as { Zoom: number }).Zoom).toBe(1)
  })
})

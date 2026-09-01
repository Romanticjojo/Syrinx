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

  /** [T3c] 光标元素替身（updateCursorSpan 覆写宽度用；happy-dom 下无真实 img） */
  cursorElement = { width: 0 }

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
/** 单小节假几何：staffEntry x 为行内绝对坐标（真实 OSMD 语义，T3c 诊断实测
 *  se.PositionAndShape.AbsolutePosition.x 与小节同空间），y/w/h 与真实谱面同量级 */
function fakeMeasure(num: number, entries: { rv: number; note: FakeGNote }[]) {
  return {
    MeasureNumber: num,
    PositionAndShape: {
      AbsolutePosition: { x: num * 10, y: 20 },
      Size: { width: 8, height: 6 },
    },
    staffEntries: entries.map((e) => ({
      PositionAndShape: { AbsolutePosition: { x: num * 10 + e.rv * 4 } },
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
  // m1 两个 staffEntry（rv 0 / 0.25 -> 音符 A / B），m2 一个（rv 0 -> C）；
  // MeasureList 外层=小节（T3c 诊断实测 [小节][staff]），m1/m2 同系统行
  const A = mkGNote()
  const B = mkGNote()
  const C = mkGNote()
  const ml = [
    [fakeMeasure(1, [
      { rv: 0, note: A },
      { rv: 0.25, note: B },
    ])],
    [fakeMeasure(2, [{ rv: 0, note: C }])],
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
    // 行内偏移点击：dy 叠入距离（y=190 -> 行顶 200，dy=10，dist=hypot(40,10)）
    const near = score.noteAtPoint(150, 190)
    expect(near?.dist).toBeCloseTo(Math.hypot(40, 10), 5)
    // 行外超半行高：无效点击返回 null（T3b 行判定收紧，不再跨行乱选）
    expect(score.noteAtPoint(150, 80)).toBeNull()
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

// -- T3b：选中色分离（播放光标 accent vs 鼠标选中橙，fake 几何不真渲染 OSMD）--
describe('OSMDScore T3b 选中色分离（selectionColor）', () => {
  const ORANGE = '#ff9f43'
  const BASE = '#e8e8e2'
  const A2 = mkGNote()
  const mlSel = [[fakeMeasure(1, [{ rv: 0, note: A2 }])]]

  function makeSelScore(selectionColor?: string) {
    const cursor = new FakeCursor([0, 1, 2])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const score = new OSMDScore(
      container,
      '#3ddfae',
      {
        load: async () => {},
        render: () => {},
        cursor,
        GraphicSheet: { MeasureList: mlSel },
      } as unknown as OpenSheetMusicDisplay,
      1,
      selectionColor,
    )
    return { score, cursor }
  }

  it('传 selectionColor：选中染橙，清除恢复白', () => {
    const { score } = makeSelScore(ORANGE)
    score.highlightNoteAt(1, 0)
    expect(A2.colors.at(-1)).toBe(ORANGE)
    score.highlightNoteAt(null)
    expect(A2.colors.at(-1)).toBe(BASE)
  })

  it('缺省不传 selectionColor：选中仍染 accent（演奏页兼容红线）', () => {
    const { score } = makeSelScore()
    score.highlightNoteAt(1, 0)
    expect(A2.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(null)
    expect(A2.colors.at(-1)).toBe(BASE)
  })

  it('双方持有同一音符显示橙：光标移走保持橙（意图优先），光标新音染 accent', () => {
    const { score, cursor } = makeSelScore(ORANGE)
    cursor.notesUnder = [A2]
    score.syncToTime(4 * SPQ) // 光标推进 -> A2 染 accent
    expect(A2.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(1, 0) // 选中同一音符 -> 橙（鼠标意图优先）
    expect(A2.colors.at(-1)).toBe(ORANGE)
    const C2 = mkGNote()
    cursor.notesUnder = [C2]
    score.syncToTime(8 * SPQ) // 光标移走：A2 仍被选中持有 -> 保持橙；C2 染 accent
    expect(A2.colors.at(-1)).toBe(ORANGE)
    expect(C2.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(null) // 清除选中：A2 已无持有 -> 白；光标音 C2 不动
    expect(A2.colors.at(-1)).toBe(BASE)
    expect(C2.colors.at(-1)).toBe('#3ddfae')
  })

  it('清除选中时音符仍被光标持有：恢复 accent 而非白', () => {
    const { score, cursor } = makeSelScore(ORANGE)
    cursor.notesUnder = [A2]
    score.syncToTime(4 * SPQ) // A2 染 accent
    score.highlightNoteAt(1, 0) // A2 选中 -> 橙
    expect(A2.colors.at(-1)).toBe(ORANGE)
    score.highlightNoteAt(null) // 清除选中：A2 仍被光标持有 -> accent
    expect(A2.colors.at(-1)).toBe('#3ddfae')
  })

  it('光标推进到选中音符上：不把橙色覆盖成 accent', () => {
    const { score, cursor } = makeSelScore(ORANGE)
    score.highlightNoteAt(1, 0) // 先选中 -> 橙
    cursor.notesUnder = [A2]
    score.syncToTime(4 * SPQ) // 光标推进到该音符：updateHighlight 跳过 selNote 染色
    expect(A2.colors.at(-1)).toBe(ORANGE)
  })
})

// -- T3b：noteAtPoint 命中精度强化（音符头绘制 x 对齐，假 SVG 元素 rect 注入）--
/** 可注入音符头绘制几何的 GraphicalNote 替身：headBoxes 为各 notehead 的
 *  {left,top,width,height}（client px，happy-dom 下 svg 全零 rect，即绝对坐标）；
 *  modBoxes 为修饰符（升/降号）box——只并入 x 包络，不贡献中心 y/半宽 */
function mkGNoteGeom(
  headBoxes: { left: number; top: number; width: number; height: number }[],
  modBoxes: { left: number; top: number; width: number; height: number }[] = [],
) {
  const colors: string[] = []
  const mkEl = (b: { left: number; top: number; width: number; height: number }) => ({
    getBoundingClientRect: () => ({
      left: b.left,
      top: b.top,
      right: b.left + b.width,
      bottom: b.top + b.height,
      width: b.width,
      height: b.height,
    }),
  })
  return {
    colors,
    setColor: (c: string) => colors.push(c),
    sourceNote: { isRest: () => false },
    getNoteheadSVGs: () => headBoxes.map(mkEl),
    getModifierSVGs: () => modBoxes.map(mkEl),
  }
}

describe('OSMDScore T3b 命中精度强化（音符头绘制 x 对齐）', () => {
  /** m1（绝对 x=100px，行 y=200..260px）：rv0 锚点 x=100、rv0.25 锚点 x=110；
   *  rv0 音符头绘制在 [112,124] 且带 accidental [104,112] -> 包络中心 114；
   *  rv0.25 音符头绘制在 [130,142] -> 中心 136 */
  const N0 = mkGNoteGeom([{ left: 112, top: 218, width: 12, height: 8 }], [
    { left: 104, top: 218, width: 8, height: 8 },
  ])
  const N1 = mkGNoteGeom([{ left: 130, top: 218, width: 12, height: 8 }])
  const mlHit = [
    [
      fakeMeasure(1, [
        { rv: 0, note: N0 },
        { rv: 0.25, note: N1 },
      ]),
    ],
  ]
  function makeHitScore(
    ml: unknown[][] = mlHit,
  ): { score: OSMDScore; cursor: FakeCursor } {
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
    return { score, cursor }
  }

  it('偏移修正：点击落在带 accidental 音符头上时选它而非锚点更近的邻音', () => {
    // 旧逻辑（staffEntry 锚点 x）：|118-100|=18 > |118-110|=8 -> 误选 rv0.25；
    // 新逻辑（绘制包络中心）：|118-114|=4 < |118-136|=18 -> 选中 rv0
    const h = makeHitScore().score.noteAtPoint(118, 222)
    expect(h?.measure).toBe(1)
    expect(h?.rvInMeasure).toBe(0)
    expect(h?.precise).toBe(true)
  })

  it('无偏移音符：正常按绘制 x 最近邻命中', () => {
    const h = makeHitScore().score.noteAtPoint(138, 222)
    expect(h?.rvInMeasure).toBe(0.25) // |138-136|=2 < |138-114|=24
    expect(h?.precise).toBe(true)
  })

  it('precise=false：命中但在半个音符头宽度之外（供页面三档提示）', () => {
    const h = makeHitScore().score.noteAtPoint(150, 222)
    expect(h?.rvInMeasure).toBe(0.25) // 距最近绘制中心 14px > 半宽 6px
    expect(h?.precise).toBe(false)
  })

  it('行判定收紧：点击处与行 y 距离超行高一半返回 null（不跨行乱选）', () => {
    expect(makeHitScore().score.noteAtPoint(118, 160)).toBeNull() // dy=40 > 半行高 30
    const near = makeHitScore().score.noteAtPoint(118, 180) // dy=20 <= 30：仍命中
    expect(near?.rvInMeasure).toBe(0)
    expect(near?.dist).toBeCloseTo(Math.hypot(4, 20), 5)
  })

  it('同 x 并列（多声部）：优先 y 更接近点击处的音符', () => {
    const Hi = mkGNoteGeom([{ left: 100, top: 208, width: 12, height: 8 }]) // 上声部
    const Lo = mkGNoteGeom([{ left: 100, top: 248, width: 12, height: 8 }]) // 下声部
    const ml2 = [
      [
        fakeMeasure(1, [
          { rv: 0, note: Hi },
          { rv: 0.5, note: Lo },
        ]),
      ],
    ]
    expect(makeHitScore(ml2).score.noteAtPoint(106, 252)?.rvInMeasure).toBe(0.5) // 点下声部
    expect(makeHitScore(ml2).score.noteAtPoint(106, 212)?.rvInMeasure).toBe(0) // 点上声部
  })
})

// -- T3c：hitRows 行归并（MeasureList 实为 [小节][staff]）+ 坐标系修正 --
describe('OSMDScore T3c 行归并与坐标系修正', () => {
  // 同一系统行的两个小节：m1（rv0 A / rv0.25 B，行内绝对 x 100/110px）、
  // m2（rv0 C，x 200px），同 y 带 200..260px
  const A3 = mkGNote()
  const B3 = mkGNote()
  const C3 = mkGNote()
  const mlRow = [
    [fakeMeasure(1, [
      { rv: 0, note: A3 },
      { rv: 0.25, note: B3 },
    ])],
    [fakeMeasure(2, [{ rv: 0, note: C3 }])],
  ]

  it('行内第二小节的音符可选中（不再恒选行首小节，bug 复现用例）', () => {
    const { score } = makeGeomScore(mlRow)
    expect(score.noteAtPoint(205, 230)?.measure).toBe(2)
    expect(score.noteAtPoint(205, 230)?.rvInMeasure).toBe(0)
    // 行首小节仍可选
    expect(score.noteAtPoint(105, 230)?.measure).toBe(1)
    expect(score.noteAtPoint(105, 230)?.rvInMeasure).toBe(0)
  })

  it('跨行：不同 y 带的小节归入各自行，不串行', () => {
    const D3 = mkGNote()
    const m3 = fakeMeasure(3, [{ rv: 0, note: D3 }])
    m3.PositionAndShape = {
      AbsolutePosition: { x: 30, y: 50 },
      Size: { width: 8, height: 6 },
    }
    const { score } = makeGeomScore([...mlRow, [m3]])
    expect(score.noteAtPoint(305, 500)?.measure).toBe(3)
    expect(score.noteAtPoint(305, 500)?.rvInMeasure).toBe(0)
  })

  it('setMarkers：标记按行内绝对锚点定位（不叠加小节 x，修复双重计数错位）', () => {
    const { score, container } = makeGeomScore(mlRow)
    score.setMarkers([{ measure: 2, rvInMeasure: 0, color: '#fff' }])
    const el = container.querySelector<HTMLElement>('.sync-marker')
    expect(el).not.toBeNull()
    // happy-dom 下 svgRect/容器 rect 全零 -> offX=0；m2 rv0 锚点行内绝对 x=20 单位
    // -> 200px（旧代码叠加小节 x 会给 400px）
    expect(el!.style.left).toBe('200px')
    expect(el!.style.top).toBe('200px') // g.y = 20 单位
    expect(el!.style.height).toBe('60px')
    score.setMarkers([])
    expect(container.querySelector('.sync-marker')).toBeNull()
  })
})

// -- T3c：光标跨时值高亮（cursorSpan 可选参数，缺省兼容红线）--
describe('OSMDScore T3c 光标跨时值高亮（cursorSpan）', () => {
  // m1 三个 staffEntry：rv 0/0.5/1 -> 行内绝对 x 10/12/14 单位（100/120/140px）
  const mlSpan = [[fakeMeasure(1, [
    { rv: 0, note: mkGNote() },
    { rv: 0.5, note: mkGNote() },
    { rv: 1, note: mkGNote() },
  ])]]

  async function makeSpanScore(cursorSpan?: boolean) {
    const cursor = new FakeCursor([0, 0.5, 1])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const score = new OSMDScore(
      container,
      '#3ddfae',
      {
        load: async () => {},
        render: () => {},
        cursor,
        GraphicSheet: { MeasureList: mlSpan },
      } as unknown as OpenSheetMusicDisplay,
      1,
      undefined,
      cursorSpan,
    )
    await score.load('<score/>', MINI_TIMELINE)
    return { score, cursor }
  }

  it('推进后光标元素宽度覆盖当前音到下一停靠点的跨度（(12-10)单位×10px=20px）', async () => {
    const { score, cursor } = await makeSpanScore(true)
    score.syncToTime(2 * SPQ) // rv0.5 停靠点开始（4/3s）-> 推进到中间停靠点
    expect(cursor.pos).toBe(1)
    expect(cursor.cursorElement.width).toBe(20)
  })

  it('末站无下一停靠点：宽度不覆写（保持 OSMD 缺省窄条）', async () => {
    const { score, cursor } = await makeSpanScore(true)
    score.syncToTime(99)
    expect(cursor.pos).toBe(2)
    expect(cursor.cursorElement.width).toBe(0)
  })

  it('缺省不传：光标宽度不被改写（演奏页兼容红线）', async () => {
    const { score, cursor } = await makeSpanScore()
    score.syncToTime(2 * SPQ)
    expect(cursor.pos).toBe(1)
    expect(cursor.cursorElement.width).toBe(0)
  })
})

// -- T3c：setTimeline 就地换时间轴（保存修改后播放即新节奏）--
describe('OSMDScore T3c setTimeline', () => {
  it('换时间轴后 syncToTime 按新 measureTimes 推进（quarters 不变）', async () => {
    const { score, cursor } = await makeScore([0, 1])
    // 新时间轴：m1 0s、m2 10s（同 quarters 0/4）——90bpm 下原 m2 在 8/3s
    const slow: Timeline = {
      ...MINI_TIMELINE,
      secPerQuarter: 2.5,
      measureTimes: [
        { measure: 1, time: 0, quarters: 0 },
        { measure: 2, time: 10, quarters: 4 },
        { measure: 3, time: 12.5, quarters: 5, end: true },
      ],
    }
    score.setTimeline(slow)
    score.syncToTime(5) // 旧轴会推进（5 > 8/3），新轴不应（5 < 10）
    expect(cursor.pos).toBe(0)
    score.syncToTime(10)
    expect(cursor.pos).toBe(1)
  })

  it('onMeasureChange 也按新轴反查小节', async () => {
    const { score } = await makeScore([0, 1])
    const slow: Timeline = {
      ...MINI_TIMELINE,
      secPerQuarter: 2.5,
      measureTimes: [
        { measure: 1, time: 0, quarters: 0 },
        { measure: 2, time: 10, quarters: 4 },
        { measure: 3, time: 12.5, quarters: 5, end: true },
      ],
    }
    score.setTimeline(slow)
    const fired: number[] = []
    score.onMeasureChange = (m) => fired.push(m)
    score.syncToTime(5)
    score.syncToTime(10)
    expect(fired).toEqual([1, 2])
  })
})

describe('OSMDScore zoom（谱面缩窄，t_53aa8b7a）', () => {
  it('load 时写入 OSMD 实例（load 后 render 前设置才真正生效——构造期设置被 OSMD 忽略）', async () => {
    const fake = makeFakeOsmd(new FakeCursor([0, 1]))
    const score = new OSMDScore(document.createElement('div'), '#3ddfae', fake, 1.15)
    await score.load('<score/>', MINI_TIMELINE)
    expect((fake as unknown as { Zoom: number }).Zoom).toBe(1.15)
  })

  it('缺省 zoom=1：不改变现有几何口径（unitPx=10×Zoom）', async () => {
    const fake = makeFakeOsmd(new FakeCursor([0, 1]))
    const score = new OSMDScore(document.createElement('div'), '#3ddfae', fake)
    await score.load('<score/>', MINI_TIMELINE)
    expect((fake as unknown as { Zoom: number }).Zoom).toBe(1)
  })
})

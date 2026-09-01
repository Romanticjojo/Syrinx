import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncNote } from './logic'
import { useSyncTuneStore, selectedNoteView, tunedCount, visibleNotes, workingQ2T } from './store'

/** 3 小节替身：notes 播放序 q 0/5/8（m2 变速段换算已在 logic.test.ts 钉死） */
const NOTES = [
  { idx: 0, measure: 1, midi: 72, q: 0 },
  { idx: 1, measure: 2, midi: 74, q: 5 },
  { idx: 2, measure: 3, midi: 76, q: 8 },
]
const BASELINE = [
  { q: 0, t: 0 },
  { q: 4, t: 2 },
  { q: 5, t: 2.5 },
  { q: 8, t: 3.5 },
]

const S = () => useSyncTuneStore.getState()

beforeEach(() => {
  useSyncTuneStore.getState().load('test', NOTES.map((n) => ({ ...n })), BASELINE.map((p) => ({ ...p })))
})

describe('载入：工作副本与基线隔离', () => {
  it('load 后 working 是基线拷贝；改动 working 不污染 baseline', () => {
    expect(S().working).toEqual(BASELINE)
    S().select(1)
    S().adjust(50)
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.55, 6)
    expect(S().baseline.find((p) => p.q === 5)!.t).toBe(2.5)
    expect(S().dirty).toBe(true)
  })
})

describe('三向选中同步', () => {
  it('select：列表/谱面入口按下标选中', () => {
    S().select(2)
    expect(S().selectedIdx).toBe(2)
  })

  it('selectByQ：精确命中优先，无精确项取 q 最近邻', () => {
    S().selectByQ(5)
    expect(S().selectedIdx).toBe(1) // 精确命中 q=5
    S().selectByQ(4.2)
    expect(S().selectedIdx).toBe(1) // |5-4.2|=0.8 < |8-4.2|
  })
})

describe('±ms 微调：有则改、无则插', () => {
  it('已有控制点的音符：平移 t 并记日志', () => {
    S().select(1)
    S().adjust(-50)
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.45, 6)
    expect(S().log).toHaveLength(1)
    expect(S().log[0]).toMatchObject({ q: 5, deltaMs: -50 })
  })

  it('无控制点的音符（q=6）：按基线插值插入新点', () => {
    S().select(1)
    // 构造一个 q=6 的音符场景：直接对 q=6 微调（经 selectByQ 最近邻到 q=5 不符）
    // ——改用第 3 音（q=8）移除其控制点模拟「无点」：
    const stripped = S().working.filter((p) => p.q !== 8)
    useSyncTuneStore.setState({ working: stripped, notes: [...NOTES, { idx: 3, measure: 3, midi: 77, q: 6 }] })
    S().select(3)
    S().adjust(100)
    const cp = S().working.find((p) => p.q === 6)
    expect(cp).toBeDefined()
    // 基线插值 q=6：q5→q8 段 (3.5-2.5)/3=1/3 s/拍 → 2.5 + 1/3 ≈ 2.8333，+0.1
    expect(cp!.t).toBeCloseTo(2.5 + 1 / 3 + 0.1, 4)
    expect(S().working.map((p) => p.q)).toEqual([0, 4, 5, 6])
  })

  it('deltaMs=0 与未选中：no-op 不产生快照', () => {
    S().adjust(50) // 未选中
    expect(S().undoStack).toHaveLength(0)
    S().select(0)
    S().adjust(0)
    expect(S().undoStack).toHaveLength(0)
  })
})

describe('撤销栈回滚内存 diff', () => {
  it('undo 恢复上一次快照；栈空 no-op；连续两次回滚两步', () => {
    S().select(1)
    S().adjust(50)
    S().adjust(50)
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.6, 6)
    S().undo()
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.55, 6)
    S().undo()
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.5, 6)
    S().undo() // 栈空：不再变化
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.5, 6)
  })

  it('resetSelected：基线既有点恢复原 t；插入的新点被移除', () => {
    S().select(1)
    S().adjust(80)
    S().resetSelected()
    expect(S().working.find((p) => p.q === 5)!.t).toBe(2.5)
    // 模拟「基线也没有 q=8」的真插入点场景：working 与 baseline 一并剔除
    // （只剔 working 的话 q=8 仍是基线既有点，reset 会恢复原 t 而非移除）
    useSyncTuneStore.setState({
      working: S().working.filter((p) => p.q !== 8),
      baseline: S().baseline.filter((p) => p.q !== 8),
    })
    S().select(2)
    S().adjust(30) // 插入 q=8
    expect(S().working.find((p) => p.q === 8)).toBeDefined()
    S().resetSelected()
    expect(S().working.find((p) => p.q === 8)).toBeUndefined()
  })
})

describe('已调/未调过滤 + 统计', () => {
  it('visibleNotes：全量返回 + tuned/untuned 过滤（T3d 去小节窗口）', () => {
    S().select(1)
    S().adjust(50) // q=5 已调
    // 全量：不再按小节窗口裁剪，播放序原样返回
    expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 1, 2])
    S().setFilter('tuned')
    expect(visibleNotes(S()).map((n) => n.idx)).toEqual([1])
    S().setFilter('untuned')
    expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 2])
    S().setFilter('all')
    expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 1, 2])
  })

  it('visibleNotes：601 音符 + 601 控制点全量过滤性能护栏', () => {
    const notes: SyncNote[] = []
    for (let i = 0; i < 601; i++) {
      notes.push({ idx: i, measure: 1 + Math.floor(i / 6), midi: 72, q: (i * 4) / 6 })
    }
    const baseline = notes.map((n) => ({ q: n.q, t: n.q * 0.5 }))
    useSyncTuneStore.getState().load('big', notes, baseline)
    // 前 300 个控制点平移 -> 已调；其余未调
    useSyncTuneStore.setState({
      working: baseline.map((p, i) => (i < 300 ? { q: p.q, t: p.t + 0.01 } : { ...p })),
    })
    const t0 = performance.now()
    expect(visibleNotes(S()).length).toBe(601) // all：全量
    S().setFilter('tuned')
    const tunedList = visibleNotes(S())
    expect(tunedList.length).toBe(300)
    expect(tunedList[0].idx).toBe(0)
    expect(tunedList[299].idx).toBe(299)
    S().setFilter('untuned')
    const untunedList = visibleNotes(S())
    expect(untunedList.length).toBe(301)
    expect(untunedList[0].idx).toBe(300)
    // 护栏：三档全量过滤在 601 规模下毫秒级（tunedSetOf 单次构建）；
    // 若退化成逐音符 O(N²) 判定（~36 万次比较×3）会显著超时
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('tunedCount：只统计偏离基线的音符', () => {
    expect(tunedCount(S())).toBe(0)
    S().select(0)
    S().adjust(10)
    S().select(2)
    S().adjust(200)
    expect(tunedCount(S())).toBe(2)
  })
})

describe('属性面板视图数据（selectedNoteView）', () => {
  it('当前 t / 修正 t / 偏差 / 控制点状态一次取全', () => {
    S().select(1)
    S().adjust(100)
    const v = selectedNoteView(S())
    expect(v.note?.q).toBe(5)
    expect(v.baselineT).toBeCloseTo(2.5, 6)
    expect(v.currentT).toBeCloseTo(2.6, 6)
    expect(v.deltaMs).toBeCloseTo(100, 3)
    expect(v.hasCp).toBe(true)
    expect(v.tuned).toBe(true)
  })

  it('未选中：空视图', () => {
    expect(selectedNoteView(S()).note).toBeNull()
  })
})

describe('saveBaseline 保存修改（working 应用为新基线）', () => {
  it('dirty 时保存：baseline=working 拷贝、dirty 清零、undoStack 保留', () => {
    S().select(1)
    S().adjust(50)
    expect(S().dirty).toBe(true)
    const before = S().working
    S().saveBaseline()
    expect(S().baseline).toEqual(before)
    expect(S().baseline).not.toBe(before) // 拷贝，非同引用
    expect(S().dirty).toBe(false)
    expect(S().undoStack).toHaveLength(1) // 撤销栈不清：撤销仍是「撤销最近一次微调」
  })

  it('保存后再微调：偏差相对新基线计算；未 dirty 时保存 no-op', () => {
    S().select(1)
    S().adjust(50) // q=5 t: 2.5 -> 2.55
    S().saveBaseline()
    expect(S().log).toHaveLength(1) // 日志保留
    const b0 = S().baseline
    S().saveBaseline() // 无 diff：no-op
    expect(S().baseline).toBe(b0)
    S().adjust(-50) // 相对新基线 -50ms
    expect(S().dirty).toBe(true)
    expect(selectedNoteView(S()).deltaMs).toBeCloseTo(-50, 3)
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.5, 6)
  })
})

it('workingQ2T：工作网格可插值（波形期望线共用）', () => {
  const q2t = workingQ2T(S())
  expect(q2t(4.5).t).toBeCloseTo(2.25, 6)
})

import { create } from 'zustand'
import {
  adjustPoint,
  appendManualOffset,
  baselineTAt,
  cpIndexAt,
  deltaMsAt,
  isTuned,
  makeQ2T,
  resetPoint,
  type CtrlPoint,
  type ManualOffset,
  type SyncNote,
} from './logic'

/**
 * 同步调试页本地 store（独立于全局演奏态 store.ts）：微调 diff 只活在
 * /sync-tune 会话里，保存导出后由用户覆盖 beats.json 才影响演奏页。
 *
 * 选中以「音符下标（notes 数组，播放序）」为唯一锚：谱面点音符 / 列表点行 /
 * 波形点刻度三向入口最终都收敛到 selectedIdx（三向选中同步）。
 */
interface SyncTuneState {
  songId: string | null
  notes: SyncNote[]
  /** 基线控制点（载入的 beats.json beatAnchors，微调前） */
  baseline: CtrlPoint[]
  /** 工作副本：微调 diff（保存导出的主体） */
  working: CtrlPoint[]
  selectedIdx: number | null
  filter: 'all' | 'tuned' | 'untuned'
  undoStack: CtrlPoint[][]
  /** 人工修正日志（追加式，随 manual_offsets.json 导出） */
  log: ManualOffset[]
  dirty: boolean

  load(songId: string, notes: SyncNote[], baseline: CtrlPoint[]): void
  select(idx: number | null): void
  /** 波形/谱面入口：按 q 找含此四分音符位的音符（精确命中，否则最近邻） */
  selectByQ(q: number): void
  setFilter(f: SyncTuneState['filter']): void
  /** ±ms 微调选中音（无控制点的 q 自动插入新点）；deltaMs=0 时 no-op */
  adjust(deltaMs: number): void
  resetSelected(): void
  undo(): void
}

export const useSyncTuneStore = create<SyncTuneState>((set, get) => ({
  songId: null,
  notes: [],
  baseline: [],
  working: [],
  selectedIdx: null,
  filter: 'all',
  undoStack: [],
  log: [],
  dirty: false,

  load: (songId, notes, baseline) =>
    set({ songId, notes, baseline, working: baseline.map((p) => ({ ...p })), selectedIdx: null, filter: 'all', undoStack: [], log: [], dirty: false }),

  select: (idx) => set({ selectedIdx: idx }),

  selectByQ: (q) => {
    const { notes } = get()
    if (notes.length === 0) return
    // 精确命中优先（v6 控制点按音符 onset 建点），否则 q 最近邻
    let best = notes[0]
    let bestD = Math.abs(notes[0].q - q)
    for (const n of notes) {
      if (n.q === q) {
        set({ selectedIdx: n.idx })
        return
      }
      const d = Math.abs(n.q - q)
      if (d < bestD) {
        best = n
        bestD = d
      }
    }
    set({ selectedIdx: best.idx })
  },

  setFilter: (filter) => set({ filter }),

  adjust: (deltaMs) => {
    const { selectedIdx, notes, working, baseline, log } = get()
    if (selectedIdx === null || !deltaMs) return
    const note = notes.find((n) => n.idx === selectedIdx)
    if (!note) return
    const next = adjustPoint(working, note.q, baseline, deltaMs)
    set({
      working: next,
      undoStack: [...get().undoStack.slice(-199), working],
      log: appendManualOffset(log, note.q, next, baseline, `m${note.measure}`),
      dirty: true,
    })
  },

  resetSelected: () => {
    const { selectedIdx, notes, working, baseline, log } = get()
    if (selectedIdx === null) return
    const note = notes.find((n) => n.idx === selectedIdx)
    if (!note) return
    const next = resetPoint(working, note.q, baseline)
    if (next === working) return
    set({
      working: next,
      undoStack: [...get().undoStack.slice(-199), working],
      log: appendManualOffset(log, note.q, next, baseline, `m${note.measure} 重置`),
      dirty: true,
    })
  },

  undo: () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return
    set({ working: undoStack[undoStack.length - 1], undoStack: undoStack.slice(0, -1), dirty: true })
  },
}))

/** 选中音视图数据（属性面板一次性取全） */
export function selectedNoteView(state: SyncTuneState): {
  note: SyncNote | null
  baselineT: number
  currentT: number
  deltaMs: number
  hasCp: boolean
  tuned: boolean
} {
  const note = state.selectedIdx === null ? null : (state.notes.find((n) => n.idx === state.selectedIdx) ?? null)
  if (!note) return { note: null, baselineT: 0, currentT: 0, deltaMs: 0, hasCp: false, tuned: false }
  const wi = cpIndexAt(state.working, note.q)
  return {
    note,
    baselineT: baselineTAt(state.baseline, note.q),
    currentT: wi >= 0 ? state.working[wi].t : baselineTAt(state.baseline, note.q),
    deltaMs: deltaMsAt(state.working, state.baseline, note.q),
    hasCp: wi >= 0,
    tuned: isTuned(note, state.working, state.baseline),
  }
}

/** 已微调音符数（顶栏统计 + 导出记录） */
export function tunedCount(state: SyncTuneState): number {
  return state.notes.filter((n) => isTuned(n, state.working, state.baseline)).length
}

/** 过滤后的音符列表（当前小节 ±2 窗口由调用方的小节游标再裁一次） */
export function visibleNotes(state: SyncTuneState, curMeasure: number, window = 2): SyncNote[] {
  const inWindow = state.notes.filter(
    (n) => n.measure >= curMeasure - window && n.measure <= curMeasure + window,
  )
  if (state.filter === 'all') return inWindow
  return inWindow.filter((n) => isTuned(n, state.working, state.baseline) === (state.filter === 'tuned'))
}

/** 工作网格 q→t（波形期望线/试听 B 窗共用） */
export function workingQ2T(state: SyncTuneState): (q: number) => { t: number; rate: number } {
  return makeQ2T(state.working)
}

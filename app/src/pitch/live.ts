/**
 * 实时音准反馈状态机（纯逻辑，可离线测试）。
 * 输入：YIN 单帧检测结果 + 当前谱面期望音；
 * 输出：本轮反馈快照（实测/期望/音分偏差/是否在 ±50 音分内），
 * 供演奏页 rAF 直写 PitchMeter DOM。
 * 短窗中位数平滑抗抖：长笛稳定音上 YIN 偶发跳帧会让指针乱甩。
 */

import type { NoteEvent } from '../types'

export interface LiveFeedback {
  /** 实测频率（平滑后）；本帧未检出为 null */
  hz: number | null
  /** 期望音 MIDI；该时刻休止/无谱面期望为 null */
  midi: number | null
  /** 实测相对期望的音分偏差；任一侧缺失为 null */
  cents: number | null
  /** |cents| ≤ 50；任一侧缺失为 null */
  inTune: boolean | null
}

/** 与回放页评分一致：±50 音分内算准 */
const IN_TUNE_CENTS = 50

/** 平滑窗口：最近 N 次有效检测取中位数 */
const SMOOTH_N = 3
/** 连续无检测达到平滑窗长度后，旧值不再可信。 */
const STALE_AFTER_MISSES = SMOOTH_N

export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/** MIDI → 音名（如 69 → A4），实时反馈与调音参考共用 */
export function midiToNoteName(midi: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export class LivePitchTracker {
  /** 最近有效检测频率（新进前出），取中位数做显示平滑 */
  private recent: number[] = []
  private consecutiveMisses = 0

  /** 每帧更新：hz=null（静音/检测失败）与 note=null（休止）都如实透传 */
  update(hz: number | null, note: NoteEvent | null): LiveFeedback {
    if (hz !== null) {
      this.consecutiveMisses = 0
      this.recent.unshift(hz)
      if (this.recent.length > SMOOTH_N) this.recent.length = SMOOTH_N
    } else {
      this.consecutiveMisses += 1
      if (this.consecutiveMisses >= STALE_AFTER_MISSES) this.recent = []
    }
    const smoothHz = this.median()
    if (note === null || smoothHz === null) {
      return { hz: smoothHz, midi: note?.midi ?? null, cents: null, inTune: null }
    }
    const cents = 1200 * Math.log2(smoothHz / midiToHz(note.midi))
    return { hz: smoothHz, midi: note.midi, cents, inTune: Math.abs(cents) <= IN_TUNE_CENTS }
  }

  /** 换段（回开头重录）时清空平滑窗，避免跨段污染 */
  reset(): void {
    this.recent = []
    this.consecutiveMisses = 0
  }

  private median(): number | null {
    if (!this.recent.length) return null
    const sorted = [...this.recent].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }
}

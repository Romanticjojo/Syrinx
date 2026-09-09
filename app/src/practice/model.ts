import type { Timeline } from '../types'
import { timelineInRange, type ScoreResult } from '../pitch/compare'
import type { StoredPractice } from './history'

export interface PracticeRange { startMeasure: number; endMeasure: number; startSec: number; stopSec: number }
export interface PracticeConfig { songId: string; range: PracticeRange; rounds: number }
export interface PracticeMetadata { songVersion: string; scoringVersion: string; range: PracticeRange | null; groupId: string; round: number; rounds: number; scoredNotesKey?: string }
export const SCORING_VERSION = 'pitch-v2-captured-notes'

/** Labels are playback ordinals, independent of repeated printed measure numbers.
 * Reject malformed sequences as a whole rather than silently spanning a gap. */
export function practiceMeasures(timeline: Timeline): PracticeRange[] {
  const ranges: PracticeRange[] = []
  const entries = timeline.measureTimes
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.end) {
      if (i !== entries.length - 1) return []
      break
    }
    const stopSec = entries[i + 1]?.time ?? timeline.durationSec
    if (!Number.isFinite(entry.time) || entry.time < 0 || !Number.isFinite(stopSec) || stopSec <= entry.time) return []
    ranges.push({ startMeasure: i + 1, endMeasure: i + 1, startSec: entry.time, stopSec })
  }
  return ranges
}

export function practiceRange(timeline: Timeline, start: number, end: number): PracticeRange | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
  const measures = practiceMeasures(timeline)
  if (end > measures.length) return null
  return { startMeasure: start, endMeasure: end, startSec: measures[start - 1].startSec, stopSec: measures[end - 1].stopSec }
}

// Stable, synchronous content fingerprint, not a security or authentication hash.
function fingerprint(content: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < content.length; i++) {
    a = Math.imul(a ^ content.charCodeAt(i), 0x01000193)
    b = Math.imul(b ^ content.charCodeAt(i), 0x85ebca6b)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

const noteContent = (timeline: Timeline) => timeline.notes.map(n => [n.time, n.duration, n.midi, n.measure])

export function songVersion(xml: string, timeline: Timeline): string {
  // Fixed field ordering makes equivalent copied objects independent of key order.
  return `song-v1-${fingerprint(JSON.stringify([
    xml, timeline.durationSec, timeline.secPerQuarter, timeline.tempo, noteContent(timeline),
    timeline.measureTimes.map(m => [m.measure, m.time, m.quarters, Boolean(m.end)]),
  ]))}`
}

/** Millisecond capture jitter is comparable only if complete scored notes agree. */
export function scoredNotesKey(timeline: Timeline, startSec: number, stopSec: number): string {
  return `notes-v1-${fingerprint(JSON.stringify(noteContent(timelineInRange(timeline, startSec, stopSec))))}`
}

export function weakMeasures(result: ScoreResult, timeline: Timeline): Array<{range: PracticeRange; missed: number; total: number; avgAbsCents: number | null}> {
  return practiceMeasures(timeline).map(range => {
    // Use score result membership, never manufacture misses outside the capture.
    // Notes crossing a barline belong to their onset bar, as on the score.
    const notes = result.notes.filter(n => n.note.time >= range.startSec && n.note.time < range.stopSec)
    const measured = notes.filter(n => n.measuredHz !== null && n.cents !== null && Number.isFinite(n.cents))
    return {
      range, missed: notes.length - measured.length, total: notes.length,
      avgAbsCents: measured.length ? measured.reduce((sum, n) => sum + Math.abs(n.cents!), 0) / measured.length : null,
    }
  }).filter(bar => bar.total > 0)
    .sort((a, b) => b.missed / b.total - a.missed / a.total || (b.avgAbsCents ?? 0) - (a.avgAbsCents ?? 0) || a.range.startMeasure - b.range.startMeasure)
    .slice(0, 3)
}

export function comparisonReason(a: StoredPractice, b: StoredPractice): string | null {
  if (a.songId !== b.songId) return '曲目不同，无法比较。'
  if (a.practice.songVersion !== b.practice.songVersion) return '曲谱或时间轴版本不同，无法比较。'
  if (a.practice.scoringVersion !== b.practice.scoringVersion) return '评分版本不同，无法比较。'
  const x = a.practice.range
  const y = b.practice.range
  if (x === null ? y !== null : y === null || x.startMeasure !== y.startMeasure || x.endMeasure !== y.endMeasure || x.startSec !== y.startSec || x.stopSec !== y.stopSec) return '选择的练习区间不同，无法比较。'
  const keyA = a.practice.scoredNotesKey
  const keyB = b.practice.scoredNotesKey
  if (keyA && keyB) return keyA === keyB ? null : '实际采集区间内的评分音符不同，无法比较。'
  if (a.startSec !== b.startSec || a.stopSec !== b.stopSec) return '实际采集区间不同，无法比较。'
  return null
}

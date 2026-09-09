import { describe, expect, it } from 'vitest'
import type { Timeline } from '../types'
import { scoreAgainst } from '../pitch/compare'
import { comparisonReason, practiceMeasures, practiceRange, scoredNotesKey, songVersion, weakMeasures } from './model'
import type { StoredPractice } from './history'

const timeline: Timeline = {
  durationSec: 6, secPerQuarter: 0.5, tempo: 120,
  measureTimes: [
    { measure: 1, time: 0, quarters: 0 },
    { measure: 2, time: 2, quarters: 4 },
    { measure: 1, time: 4, quarters: 8 },
    { measure: 2, time: 6, quarters: 12, end: true },
  ],
  notes: [0, 2, 4].map(time => ({ time, duration: 1, midi: 69, measure: time === 2 ? 2 : 1 })),
}

describe('practice ranges', () => {
  it('labels repeated printed bars by playback ordinal and excludes endpoint', () => {
    expect(practiceMeasures(timeline)).toEqual([
      { startMeasure: 1, endMeasure: 1, startSec: 0, stopSec: 2 },
      { startMeasure: 2, endMeasure: 2, startSec: 2, stopSec: 4 },
      { startMeasure: 3, endMeasure: 3, startSec: 4, stopSec: 6 },
    ])
    expect(practiceRange(timeline, 2, 2)).toMatchObject({ startSec: 2, stopSec: 4 })
    expect(practiceRange(timeline, 2, 3)).toEqual({ startMeasure: 2, endMeasure: 3, startSec: 2, stopSec: 6 })
  })
  it.each([[0, 1], [2, 1], [1, 4], [1.5, 2], [1, NaN], [1, Infinity]])('rejects invalid bounds %s..%s', (a, b) => {
    expect(practiceRange(timeline, a, b)).toBeNull()
  })
  it('uses the actual endpoint even when longer than the last note; falls back to duration without marker', () => {
    expect(practiceRange({ ...timeline, durationSec: 5 }, 3, 3)?.stopSec).toBe(6)
    expect(practiceRange({ ...timeline, measureTimes: timeline.measureTimes.slice(0, 3) }, 3, 3)?.stopSec).toBe(6)
  })
  it('rejects a non-monotone or malformed timeline instead of joining across its bad interval', () => {
    const broken = structuredClone(timeline)
    broken.measureTimes[2].time = 1
    expect(practiceRange(broken, 1, 3)).toBeNull()
    expect(practiceRange({ ...timeline, measureTimes: [] }, 1, 1)).toBeNull()
  })
})

describe('song version', () => {
  it('is stable across copied content and changes with XML or any actual timeline content', () => {
    const version = songVersion('<score>A</score>', timeline)
    expect(songVersion('<score>A</score>', structuredClone(timeline))).toBe(version)
    expect(songVersion('<score>B</score>', timeline)).not.toBe(version)
    const changed = structuredClone(timeline)
    changed.measureTimes[1].time += 0.1
    expect(songVersion('<score>A</score>', changed)).not.toBe(version)
    changed.measureTimes[1].time -= 0.1
    changed.notes[0].midi = 70
    expect(songVersion('<score>A</score>', changed)).not.toBe(version)
  })
})

describe('weak measures', () => {
  it('keeps repeated bars separate, ranks misses first, and represents absent precision as null', () => {
    const scored = scoreAgainst([{ time: 0.5, hz: 450, cents: 0 }, { time: 4.5, hz: 470, cents: 0 }], timeline)
    const weak = weakMeasures(scored, timeline)
    expect(weak.map(w => w.range.startMeasure)).toEqual([2, 3, 1])
    expect(weak[0]).toMatchObject({ missed: 1, total: 1, avgAbsCents: null })
    expect(weak[1].avgAbsCents).toBeGreaterThan(100)
  })
  it('omits empty bars and only aggregates supplied captured note scores, capped at three', () => {
    const empty = scoreAgainst([], { ...timeline, notes: [] })
    expect(weakMeasures(empty, timeline)).toEqual([])
    const longer = { ...timeline, durationSec: 10,
      measureTimes: [0, 2, 4, 6, 8].map((time, i) => ({ time, measure: i + 1, quarters: i * 4 })),
      notes: [0, 2, 4, 6, 8].map(time => ({ time, duration: 1, midi: 69, measure: 1 })),
    }
    expect(weakMeasures(scoreAgainst([], longer), longer)).toHaveLength(3)
    const captured = scoreAgainst([], { ...timeline, notes: [timeline.notes[2]] })
    expect(weakMeasures(captured, timeline).map(w => w.range.startMeasure)).toEqual([3])
  })
})

describe('comparison eligibility', () => {
  const a = {
    songId: 'song', startSec: 0, stopSec: 2,
    practice: { songVersion: 'v1', scoringVersion: 'score1', range: { startMeasure: 1, endMeasure: 1, startSec: 0, stopSec: 2 }, groupId: 'group', round: 1, rounds: 3 },
  } as StoredPractice
  it('allows independent rounds with identical musical and capture context', () => {
    expect(comparisonReason(a, { ...a, practice: { ...a.practice, groupId: 'other', round: 2 } })).toBeNull()
  })
  it('accepts capture jitter only when the exact complete scored note set matches', () => {
    const key = scoredNotesKey(timeline, 0, 2)
    expect(scoredNotesKey(timeline, 0, 1.9)).toBe(key)
    expect(scoredNotesKey(timeline, 0.1, 2)).not.toBe(key)
    const keyed = { ...a, practice: { ...a.practice, scoredNotesKey: key } }
    expect(comparisonReason(keyed, { ...keyed, stopSec: 1.9 })).toBeNull()
    expect(comparisonReason(keyed, { ...a, startSec: 0.1, practice: { ...a.practice, scoredNotesKey: scoredNotesKey(timeline, 0.1, 2) } })).toEqual(expect.any(String))
    expect(comparisonReason(keyed, { ...a, stopSec: 1.9 })).toEqual(expect.any(String))
  })
  it.each([
    { songId: 'other' }, { startSec: 0.1 }, { stopSec: 1.9 },
    { practice: { ...a.practice, songVersion: 'v2' } },
    { practice: { ...a.practice, scoringVersion: 'score2' } },
    { practice: { ...a.practice, range: null } },
    { practice: { ...a.practice, range: { ...a.practice.range!, endMeasure: 2 } } },
  ])('explains incompatible context %#', patch => {
    expect(comparisonReason(a, { ...a, ...patch })).toEqual(expect.any(String))
  })
})

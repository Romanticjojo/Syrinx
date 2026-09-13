import { describe, expect, it } from 'vitest'
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { OSMDScore } from './OSMDScore'
import type { Timeline } from '../types'

function setup(numberOffset = 0) {
  const host = document.createElement('div')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  host.append(svg)
  let matrix = { a: .4, b: 0, c: 0, d: .4, e: 30, f: -20 }
  Object.defineProperty(svg, 'getScreenCTM', { value: () => matrix })
  // Model coordinates deliberately disagree with the actual renderer. Measures 2
  // and 3 contain rests only; measure 4 is the timeline's end sentinel.
  const stave = (measure: number, x: number, y: number) => ({
    MeasureNumber: measure + numberOffset,
    PositionAndShape: { AbsolutePosition: { x: 999, y: 999 } },
    staffEntries: [],
    getVFStave: () => ({ getX: () => x, getWidth: () => 100,
      getYForLine: (line: number) => y + line * 10, getNumLines: () => 5,
      getContext: () => ({ svg }) }),
  })
  const fake = { cursor: { iterator: { EndReached: true }, next: () => {} }, GraphicSheet: { MeasureList: [
    [stave(1, 50, 100)], [stave(2, 150, 100)],
    [stave(3, 50, 300), stave(3, 50, 380)], [stave(4, 150, 300)],
  ] } } as unknown as OpenSheetMusicDisplay
  const score = new OSMDScore(host, '#3ddfae', fake)
  const timeline: Timeline = { notes: [], tempo: 60, secPerQuarter: 1, durationSec: 9,
    measureTimes: [ { measure: 1, quarters: 0, time: 0 },
      { measure: 2, quarters: 4, time: 3 }, { measure: 3, quarters: 8, time: 5.5 },
      { measure: 4, quarters: 12, time: 9, end: true } ] }
  score.setTimeline(timeline)
  return { score, svg, setMatrix: (next: typeof matrix) => { matrix = next } }
}

describe('rendered measure selection', () => {
  it('keeps the start box through its measure, then clears it at the next accompaniment anchor', () => {
    const { score, svg } = setup()
    score.selectMeasure(2)
    score.syncToTime(5.49, true)
    expect(svg.querySelector('[data-selected-measure="2"]')).not.toBeNull()
    score.syncToTime(5.5, true)
    expect(svg.querySelector('[data-selected-measure]')).toBeNull()
    expect(score.getSelectedMeasure()).toBeNull()
    score.dispose()
  })

  it('keeps a paused selection and clears a last-measure selection at the end sentinel', () => {
    const { score, svg } = setup()
    score.selectMeasure(3)
    score.syncToTime(9)
    expect(svg.querySelector('[data-selected-measure="3"]')).not.toBeNull()
    score.syncToTime(8.99, true)
    expect(score.getSelectedMeasure()).toBe(3)
    score.syncToTime(9, true)
    expect(svg.querySelector('[data-selected-measure]')).toBeNull()
    score.dispose()
  })

  it.each([-1, 20])('maps source order when OSMD numbers differ by %i (pickup or excerpt)', (offset) => {
    const { score } = setup(offset)
    expect(score.measureAtPoint(70, 28)).toEqual({ measure: 1, time: 0 })
    expect(score.measureAtPoint(110, 28)).toEqual({ measure: 2, time: 3 })
    expect(score.measureAtPoint(70, 132)).toEqual({ measure: 3, time: 5.5 })
  })
  it('selects rest measures by rendered bounds and returns the exact accompaniment anchor', () => {
    const { score } = setup()
    expect(score.measureAtPoint(110, 28)).toEqual({ measure: 2, time: 3 })
    expect(score.measureAtPoint(70, 132)).toEqual({ measure: 3, time: 5.5 })
  })
  it('uses the current SVG transform after zoom, scrolling, and responsive scaling', () => {
    const { score, setMatrix } = setup()
    expect(score.measureAtPoint(110, 28)?.measure).toBe(2)
    setMatrix({ a: .8, b: 0, c: 0, d: .8, e: -10, f: -200 })
    expect(score.measureAtPoint(150, -104)).toEqual({ measure: 2, time: 3 })
    expect(score.measureAtPoint(70, 88)?.measure).toBe(3)
  })
  it('does not snap margins, gaps between systems, or the end sentinel to a nearby measure', () => {
    const { score } = setup()
    expect(score.measureAtPoint(40, 28)).toBeNull()
    expect(score.measureAtPoint(70, 68)).toBeNull()
    expect(score.measureAtPoint(110, 108)).toBeNull()
  })
  it('shows a persistent selected-measure highlight without starting the playback cursor', () => {
    const { score, svg } = setup()
    expect(score.selectMeasureAtPoint(110, 28)).toEqual({ measure: 2, time: 3 })
    const highlight = svg.querySelector('[data-selected-measure="2"]')!
    expect(highlight).not.toBeNull()
    expect(highlight.getAttribute('x')).toBe('150')
    expect(highlight.getAttribute('width')).toBe('100')
    expect(highlight.getAttribute('pointer-events')).toBe('none')
    score.selectMeasure(3)
    expect(svg.querySelector('[data-selected-measure="2"]')).toBeNull()
    expect(svg.querySelector('[data-selected-measure="3"]')).not.toBeNull()
    score.dispose()
    expect(svg.querySelector('[data-selected-measure]')).toBeNull()
  })

  it('restores the paused selection when OSMD redraws, and stops restoring after clearing', async () => {
    const { score, svg } = setup()
    score.selectMeasure(2)
    svg.replaceChildren()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(svg.querySelector('[data-selected-measure="2"]')).not.toBeNull()
    score.selectMeasure(null)
    svg.append(document.createElementNS(svg.namespaceURI, 'g'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(svg.querySelector('[data-selected-measure]')).toBeNull()
    score.dispose()
  })
})

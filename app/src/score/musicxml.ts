import type { NoteEvent, Timeline } from '../types'

/** step → 半音偏移（相对 C） */
const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * MusicXML → 统一时间轴（纯函数）。
 * 约定：取第一个 part 的第一个 voice；全曲恒速（首个 tempo）；
 * 支持中途 direction 变速累计；休止符/和弦备选音占时值但不产生音符事件。
 */
export function parseMusicXml(xml: string): Timeline {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('MusicXML 解析失败：格式错误')

  const part = doc.querySelector('part')
  if (!part) throw new Error('MusicXML 解析失败：缺少 part')

  // 全局速度（MVP 假定恒速；遍历时若遇新 tempo 则更新局部换算）
  const metronome = doc.querySelector('metronome per-minute')
  const tempo = metronome ? Number(metronome.textContent) : 120
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error('MusicXML 解析失败：tempo 无效')

  let divisions = 1
  const firstDiv = doc.querySelector('attributes divisions')
  if (firstDiv) divisions = Number(firstDiv.textContent) || 1

  const notes: NoteEvent[] = []
  const measureTimes: { measure: number; time: number }[] = []

  // 以"四分音符数"为游标，最后统一乘 secPerQuarter
  let cursorQuarters = 0
  let secPerQuarterNow = 60 / tempo
  let secCursor = 0 // 秒游标（支持变速累计）
  let measureNo = 0

  const measures = part.querySelectorAll('measure')
  measures.forEach((measure) => {
    measureNo = Number(measure.getAttribute('number')) || measureNo + 1
    measureTimes.push({ measure: measureNo, time: secCursor })
    let measureStartQuarters = cursorQuarters

    // 小节内备份/恢复：秒游标按当前 tempo 换算
    measure.querySelectorAll('note, direction, attributes, backup, forward').forEach((el) => {
      if (el.tagName === 'attributes') {
        const d = el.querySelector('divisions')
        if (d) divisions = Number(d.textContent) || divisions
        return
      }
      if (el.tagName === 'direction') {
        const pm = el.querySelector('per-minute')
        if (pm) {
          const nt = Number(pm.textContent)
          // 先把已走的四分音符数按旧 tempo 折算进秒游标
          secCursor += (cursorQuarters - measureStartQuarters) * secPerQuarterNow
          measureStartQuarters = cursorQuarters
          if (Number.isFinite(nt) && nt > 0) secPerQuarterNow = 60 / nt
        }
        return
      }
      if (el.tagName === 'backup') {
        // 多声部：回退游标（重写当前小节的时间位置）
        const durEl = el.querySelector('duration')
        if (durEl) cursorQuarters -= Number(durEl.textContent) / divisions
        return
      }
      if (el.tagName === 'forward') {
        // 多声部：前移游标
        const durEl = el.querySelector('duration')
        if (durEl) cursorQuarters += Number(durEl.textContent) / divisions
        return
      }
      // note 元素
      const durEl = el.querySelector('duration')
      const durQuarters = durEl ? Number(durEl.textContent) / divisions : 0
      const isRest = !!el.querySelector('rest')
      const isChordExtra = !!el.querySelector('chord')
      const pitch = el.querySelector('pitch')
      if (pitch && !isRest) {
        const step = pitch.querySelector('step')?.textContent ?? 'C'
        const alter = Number(pitch.querySelector('alter')?.textContent ?? '0') || 0
        const octave = Number(pitch.querySelector('octave')?.textContent ?? '4')
        const midi = (octave + 1) * 12 + STEP_SEMITONE[step] + alter
        const time = secCursor + (cursorQuarters - measureStartQuarters) * secPerQuarterNow
        if (!isChordExtra) {
          // 首个和弦音占时值，其余和弦音同时值
          notes.push({
            time,
            duration: durQuarters * secPerQuarterNow,
            midi,
            measure: measureNo,
          })
        } else {
          // 和弦备选音：同起点、不推进游标（长笛独奏曲极少出现，保守处理）
          notes.push({ time, duration: durQuarters * secPerQuarterNow, midi, measure: measureNo })
        }
      }
      if (!isChordExtra) cursorQuarters += durQuarters
    })
    // 小节结束：把游标折算为秒
    secCursor += (cursorQuarters - measureStartQuarters) * secPerQuarterNow
  })

  const secPerQuarter = 60 / tempo
  const durationSec = notes.reduce((end, n) => Math.max(end, n.time + n.duration), 0)

  return { durationSec, secPerQuarter, tempo, notes, measureTimes }
}

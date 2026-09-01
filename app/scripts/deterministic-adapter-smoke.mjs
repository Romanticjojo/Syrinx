/**
 * PlanB · T2 冒烟：Luv Letter 真谱分别以 anchors / score 两种模式构建 Timeline，
 * 打印前 10 音符 time 对照表（供 T3 客观对比用）。
 * 用法：node scripts/deterministic-adapter-smoke.mjs（Node ≥22.6 原生 TS 类型剥离）
 *
 * 复刻 loadSong 两条链路（node 无 fetch/window，素材直接读文件）：
 * - anchors：expandRepeats(stripForcedBreaks) → parseMusicXml → applyBeats(beats.json) → applyAnchorOffset
 * - score：同一份展开谱 → parseDeterministicTimeline → deterministicToTimeline
 * musicxml.ts 依赖 DOMParser/XMLSerializer，先注入 happy-dom 全局再调用。
 */
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win
globalThis.DOMParser = win.DOMParser
globalThis.XMLSerializer = win.XMLSerializer

import { readFileSync } from 'node:fs'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../src/score/musicxml.ts'
import { parseDeterministicTimeline } from '../src/score/deterministic-timeline.ts'
import { deterministicToTimeline } from '../src/score/deterministic-adapter.ts'
import { applyAnchorOffset, applyBeats } from '../src/score/anchors.ts'

const read = (p) => readFileSync(new URL(`../public/songs/luv-letter/${p}`, import.meta.url), 'utf8')
// happy-dom 不支持单引号属性（浏览器/Electron 原生 DOMParser 无此问题），读取时归一化
const raw = read('score.musicxml').replace(/^<\?xml[^>]*\?>/, (m) => m.replace(/'/g, '"'))
const manifest = JSON.parse(read('manifest.json'))

// 展开链路对两种模式严格同源：同一份 xml 喂 OSMD 与 timeline
const xml = expandRepeats(stripForcedBreaks(raw))

console.time('build-anchors')
let anchorsTl = parseMusicXml(xml)
if (manifest.beatsUrl) anchorsTl = applyBeats(anchorsTl, JSON.parse(read('beats.json')))
if (manifest.anchorOffsetMs) anchorsTl = applyAnchorOffset(anchorsTl, manifest.anchorOffsetMs / 1000)
console.timeEnd('build-anchors')

console.time('build-score')
const dt = parseDeterministicTimeline(xml)
const scoreTl = deterministicToTimeline(dt)
console.timeEnd('build-score')

const num = (v) => v.toFixed(3).padStart(8)
console.log('--- 前 10 音符 time 对照（anchors vs score）---')
console.log('  #  | midi | measure |  anchors.time |  anchors.dur |    score.time |     score.dur |   Δtime')
const n = Math.min(10, anchorsTl.notes.length, scoreTl.notes.length)
for (let i = 0; i < n; i++) {
  const a = anchorsTl.notes[i]
  const s = scoreTl.notes[i]
  const samePitch = a.midi === s.midi ? '' : '  ⚠ midi 不一致'
  console.log(
    `  ${String(i).padStart(2)} | ${String(a.midi).padStart(4)} | ${String(a.measure).padStart(7)} | ${num(a.time)} | ${num(a.duration)} | ${num(s.time)} | ${num(s.duration)} | ${num(s.time - a.time)}${samePitch}`,
  )
}
console.log('--- 汇总 ---')
console.log(`anchors: notes=${anchorsTl.notes.length} tempo=${anchorsTl.tempo} durationSec=${anchorsTl.durationSec.toFixed(3)} measureTimes=${anchorsTl.measureTimes.length}`)
console.log(`score:   notes=${scoreTl.notes.length} tempo=${scoreTl.tempo} durationSec=${scoreTl.durationSec.toFixed(3)} measureTimes=${scoreTl.measureTimes.length} warnings=${dt.warnings.length}`)
for (const w of dt.warnings.slice(0, 5)) console.log('  ⚠', w)

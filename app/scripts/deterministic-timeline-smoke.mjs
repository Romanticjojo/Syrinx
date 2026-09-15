/**
 * PlanB · T1 冒烟：Luv Letter 真谱跑确定性时间轴解析器。
 * 用法：node scripts/deterministic-timeline-smoke.mjs（Node ≥22.6 原生 TS 类型剥离）
 */
import { readFileSync } from 'node:fs'
import { parseDeterministicTimeline } from '../src/score/deterministic-timeline.ts'

const xml = readFileSync(new URL('../public/songs/luv-letter/score.musicxml', import.meta.url), 'utf8')
console.time('parse-deterministic-timeline')
const tl = parseDeterministicTimeline(xml)
console.timeEnd('parse-deterministic-timeline')

console.log('--- 前 10 个音符 ---')
for (const n of tl.notes.slice(0, 10)) {
  console.log(
    `#${String(n.playIndex).padStart(3)} pitch=${String(n.pitch).padEnd(5)} measure=${String(n.measure).padStart(3)} startQ=${n.startQ.toFixed(3)} durQ=${n.durQ.toFixed(3)} t0=${n.t0Sec.toFixed(3)}s t1=${n.t1Sec.toFixed(3)}s${n.isGrace ? ' grace' : ''}${n.isTieStart ? ' tieStart' : ''}${n.isTieStop ? ' tieStop' : ''}`,
  )
}
console.log('--- 汇总 ---')
console.log('totalQ =', tl.totalQ)
console.log('endSec =', tl.endSec.toFixed(3))
console.log('tempoSegments =', JSON.stringify(tl.tempoSegments))
console.log('warnings 数量 =', tl.warnings.length)
for (const w of tl.warnings.slice(0, 10)) console.log('  ⚠', w)
console.log(
  `notes = ${tl.notes.length}（含 rest ${tl.notes.filter((n) => n.pitch === null).length}、grace ${tl.notes.filter((n) => n.isGrace).length}）`,
)

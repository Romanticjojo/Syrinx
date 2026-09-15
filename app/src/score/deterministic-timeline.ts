/**
 * PlanB · T1 确定性时间轴解析器。
 *
 * 与 musicxml.ts（v6 锚点方案的数据源）并行的纯确定性路线：解析 MusicXML 的
 * divisions + duration + tempo，生成「音符 → 起始秒 + 持续秒」时间表驱动光标，
 * 不依赖音频对齐（MuseScore/OSMD 播放器的标准做法）。
 *
 * 约定（任务书定死）：
 * - duration 是唯一真值，<type> 只影响符头样式不参与计算；t = (duration/divisions) * 60/bpm
 * - tempo：per-minute 与 sound tempo 都识别，分段换算（段内线性），无标记默认 90
 * - backup/forward 推游标；chord 成员不累加时间只记一次；grace 不占时值
 * - tie 只透传标记不合并时值；tuplet/附点以 duration 为准自动正确
 * - 反复展开手写状态机：遍数延续、forward 重置、2 房子奏完才重置；
 *   支持 volta / D.C. al Fine / D.S. al Coda / coda / segno，guard 防死循环
 * - 小节各 voice 时值与拍号不符时不抛异常，收集进 warnings
 *
 * 本文件为 T1 范围：只提供解析与时间表生成，不接线 UI/播放器（T2）。
 */
import { XMLParser } from 'fast-xml-parser'

export interface DeterministicTimelineNote {
  /** 科学音高记法如 "A4"，rest 为 null */
  pitch: string | null
  /** 谱面小节号 */
  measure: number
  /** 展开反复后的演奏序位置（notes 数组下标） */
  playIndex: number
  /** 演奏序四分音符位置（含反复展开） */
  startQ: number
  /** 时值（四分音符单位） */
  durQ: number
  /** 起始秒（按谱面 tempo 分段换算） */
  t0Sec: number
  /** 结束秒 */
  t1Sec: number
  isGrace: boolean
  isTieStart: boolean
  isTieStop: boolean
  voice: number
}

export interface TempoSegment {
  startQ: number
  bpm: number
}

export interface DeterministicTimeline {
  notes: DeterministicTimelineNote[]
  /** 全曲演奏序总四分音符数 */
  totalQ: number
  /** 全曲末尾秒 */
  endSec: number
  /** 速度分段表（段内线性） */
  tempoSegments: TempoSegment[]
  /** 小节时值校验等非致命问题（供 T3 对比报告用） */
  warnings: string[]
}

/** fast-xml-parser preserveOrder 模式节点：{ TagName: [子节点], ':@': { 属性 } }，文本为 { '#text': value } */
type PNode = Record<string, unknown>

const ATTR = ':@'
const TEXT = '#text'

function tagOf(node: PNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ATTR && key !== TEXT) return key
  }
  return ''
}

function childrenOf(node: PNode): PNode[] {
  const tag = tagOf(node)
  if (!tag) return []
  const value = node[tag]
  return Array.isArray(value) ? (value as PNode[]) : []
}

function attrsOf(node: PNode): Record<string, string> {
  const raw = node[ATTR]
  const out: Record<string, string> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key.replace(/^@_/, '')] = value === null || value === undefined ? '' : String(value)
    }
  }
  return out
}

function textOf(node: PNode): string {
  return childrenOf(node)
    .filter((c) => typeof c[TEXT] === 'string')
    .map((c) => String(c[TEXT]))
    .join('')
    .trim()
}

/** 直接子节点中第一个指定标签的元素 */
function kid(node: PNode, tag: string): PNode | null {
  for (const c of childrenOf(node)) {
    if (tagOf(c) === tag) return c
  }
  return null
}

/** 直接子节点中指定标签的全部元素 */
function kids(node: PNode, tag: string): PNode[] {
  return childrenOf(node).filter((c) => tagOf(c) === tag)
}

function numText(node: PNode | null): number | null {
  if (!node) return null
  const n = Number(textOf(node))
  return Number.isFinite(n) ? n : null
}

/** pitch → 科学音高记法（"A4" / "F#1" / "Bb3"） */
function pitchName(pitchNode: PNode): string | null {
  const stepEl = kid(pitchNode, 'step')
  const octaveEl = kid(pitchNode, 'octave')
  if (!stepEl || !octaveEl) return null
  const step = textOf(stepEl).toUpperCase()
  const octave = Math.round(Number(textOf(octaveEl)))
  if (!/^[A-G]$/.test(step) || !Number.isFinite(octave)) return null
  const alterEl = kid(pitchNode, 'alter')
  const alter = alterEl ? Math.round(Number(textOf(alterEl)) || 0) : 0
  let accidental = ''
  if (alter > 0) accidental = '#'.repeat(alter)
  else if (alter < 0) accidental = 'b'.repeat(-alter)
  return `${step}${accidental}${octave}`
}

/** measure number 属性 → 谱面小节号（缺失时用序号兜底） */
function measureNumberOf(measure: PNode, idx: number): number {
  const raw = attrsOf(measure)['number']
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : idx + 1
}

/** 收集小节内全部 repeat 记号的 direction */
function repeatDirections(measure: PNode): string[] {
  const out: string[] = []
  const walk = (node: PNode): void => {
    for (const c of childrenOf(node)) {
      if (tagOf(c) === 'repeat') out.push(attrsOf(c)['direction'] ?? '')
      else walk(c)
    }
  }
  walk(measure)
  return out
}

/** 收集小节内全部 ending（volta）标记 */
function endingMarks(measure: PNode): Array<{ type: string; number: string }> {
  const out: Array<{ type: string; number: string }> = []
  const walk = (node: PNode): void => {
    for (const c of childrenOf(node)) {
      if (tagOf(c) === 'ending') {
        const a = attrsOf(c)
        out.push({ type: a['type'] ?? '', number: a['number'] ?? '' })
      } else walk(c)
    }
  }
  walk(measure)
  return out
}

interface NavigationMarks {
  dc: boolean
  ds: boolean
  fine: boolean
  toCoda: boolean
  coda: boolean
  segno: boolean
}

/** 识别 D.C. / D.S. / Fine / To Coda / Coda / Segno（words 文本 + sound 属性 + coda/segno 符号） */
function navigationMarks(measure: PNode): NavigationMarks {
  const marks: NavigationMarks = { dc: false, ds: false, fine: false, toCoda: false, coda: false, segno: false }
  const applySound = (sound: PNode): void => {
    const a = attrsOf(sound)
    if (a['dacapo'] === 'yes') marks.dc = true
    if (a['dalsegno']) marks.ds = true
    if (a['fine']) marks.fine = true
    if (a['coda']) marks.coda = true
    if (a['segno']) marks.segno = true
  }
  const applyWords = (text: string): void => {
    if (/D\.C\.|da capo/i.test(text)) marks.dc = true
    if (/D\.S\.|dal segno/i.test(text)) marks.ds = true
    if (/\bFine\b/i.test(text)) marks.fine = true
    if (/To\s+Coda/i.test(text)) marks.toCoda = true
    if (/^\s*Coda\s*$/.test(text)) marks.coda = true
  }
  const walk = (node: PNode): void => {
    for (const c of childrenOf(node)) {
      const tag = tagOf(c)
      if (tag === 'words') applyWords(textOf(c))
      else if (tag === 'segno') marks.segno = true
      else if (tag === 'coda') marks.coda = true
      else if (tag === 'sound') applySound(c)
      else walk(c)
    }
  }
  walk(measure)
  return marks
}

/**
 * 反复展开状态机：输出线性演奏序小节下标列表。
 * 遍数语义（任务书铁律）：跳回重复段时遍数延续；顺次走到 forward repeat 才重置为第 1 遍；
 * 2 房子奏完后（段落出栈）遍数才回落。guard：同一 backward repeat 最多跳 8 次 + 总步数上限。
 */
function expandPerformanceOrder(measures: PNode[]): number[] {
  const hasForward = measures.map((m) => repeatDirections(m).includes('forward'))
  const hasBackward = measures.map((m) => repeatDirections(m).includes('backward'))
  const endingStart = measures.map((m) => {
    const start = endingMarks(m).find((e) => e.type === 'start')
    if (!start) return null
    return start.number.split(',').map((s) => s.trim()).filter(Boolean)
  })
  // ending stop 所在小节 → 与之配对的 start 所在小节
  const endingStopOf = new Map<number, number>()
  measures.forEach((m, idx) => {
    const stop = endingMarks(m).find((e) => e.type === 'stop')
    if (!stop) return
    const num = stop.number.trim()
    for (let k = idx; k >= 0; k--) {
      if (endingStart[k] === null || endingStopOf.has(k)) continue
      if (num === '' || endingStart[k]!.includes(num)) {
        endingStopOf.set(k, idx)
        break
      }
    }
  })
  const nav = measures.map((m) => navigationMarks(m))
  const segnoIndex = nav.findIndex((n) => n.segno)
  const codaIndex = nav.findIndex((n) => n.coda && !n.toCoda)

  const order: number[] = []
  // 活跃重复段栈：{ start: forward 小节下标, pass: 当前遍数 }
  const stack: Array<{ start: number; pass: number }> = []
  const backwardJumps = new Map<number, number>()
  let pass = 1 // 无 forward 记号段落的兜底遍数
  let seq = true // 是否顺次到达当前小节（跳转到达时不重置遍数）
  let usedDc = false
  let usedDs = false
  let codaJumped = false
  const maxSteps = measures.length * 12 + 128
  let steps = 0
  let i = 0
  while (i < measures.length && steps++ < maxSteps) {
    let cur = stack.length > 0 ? stack[stack.length - 1] : null
    const curPass = cur ? cur.pass : pass
    // volta：遍数不匹配的 ending 块整块跳过（跳到 stop 之后继续）
    if (endingStart[i] !== null && !endingStart[i]!.includes(String(curPass))) {
      const stopAt = endingStopOf.get(i)
      if (stopAt !== undefined) {
        i = stopAt + 1
        seq = true
        continue
      }
    }
    order.push(i)
    // 顺次走到 forward repeat 才重置遍数（跳转到达不重置）
    if (hasForward[i] && seq) {
      stack.push({ start: i, pass: 1 })
      cur = stack[stack.length - 1]
    }
    // To Coda：D.S./D.C. 跳回后的第二遍经过才生效，奏完即跳 coda
    if ((usedDs || usedDc) && nav[i].toCoda && codaIndex >= 0 && !codaJumped) {
      codaJumped = true
      i = codaIndex
      seq = false
      continue
    }
    if (nav[i].ds && !usedDs) {
      usedDs = true
      i = segnoIndex >= 0 ? segnoIndex : 0
      seq = false
      continue
    }
    if (nav[i].dc && !usedDc) {
      usedDc = true
      i = 0
      seq = false
      continue
    }
    // Fine：D.C./D.S. 跳回后顺次奏到 Fine 小节为止
    if ((usedDc || usedDs) && nav[i].fine && seq) break
    if (hasBackward[i]) {
      const jumps = backwardJumps.get(i) ?? 0
      if (jumps < 8 && cur && cur.pass < 2) {
        backwardJumps.set(i, jumps + 1)
        cur.pass += 1
        i = cur.start
        seq = false
        continue
      }
      if (jumps < 8 && !cur && pass < 2) {
        backwardJumps.set(i, jumps + 1)
        pass += 1
        i = 0
        seq = false
        continue
      }
      if (cur) {
        // 段落遍数已满：出栈，遍数回落供后续 ending 判定
        pass = cur.pass
        stack.pop()
      }
    }
    i++
    seq = true
  }
  return order
}

export function parseDeterministicTimeline(xml: string): DeterministicTimeline {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  })
  const tree = parser.parse(xml) as PNode[]
  const scoreNode = tree.find((n) => tagOf(n) === 'score-partwise')
  if (!scoreNode) throw new Error('MusicXML 解析失败：缺少 score-partwise（仅支持 partwise）')
  const part = kids(scoreNode, 'part')[0]
  if (!part) throw new Error('MusicXML 解析失败：缺少 part')
  const measures = kids(part, 'measure')
  if (measures.length === 0) throw new Error('MusicXML 解析失败：part 内无小节')

  const notes: DeterministicTimelineNote[] = []
  const tempoSegments: TempoSegment[] = []
  const warnings: string[] = []

  const setBpm = (bpm: number, atQ: number): void => {
    if (!Number.isFinite(bpm) || bpm <= 0) return
    if (tempoSegments.length === 0) {
      tempoSegments.push({ startQ: 0, bpm })
      return
    }
    const last = tempoSegments[tempoSegments.length - 1]
    if (bpm === last.bpm) return
    // 同一位置重复标记：后者覆盖前者
    if (atQ <= last.startQ) tempoSegments[tempoSegments.length - 1] = { startQ: last.startQ, bpm }
    else tempoSegments.push({ startQ: atQ, bpm })
  }
  setBpm(90, 0) // 无任何 tempo 标记时默认 90；首个标记与之同位时会被覆盖

  /** 秒 ← 四分音符位置：逐 tempo 段内线性累加 */
  const timeAt = (q: number): number => {
    let t = 0
    for (let k = 0; k < tempoSegments.length; k++) {
      const seg = tempoSegments[k]
      const segEnd = k + 1 < tempoSegments.length ? tempoSegments[k + 1].startQ : Infinity
      if (q <= segEnd) return t + (q - seg.startQ) * (60 / seg.bpm)
      t += (segEnd - seg.startQ) * (60 / seg.bpm)
    }
    const last = tempoSegments[tempoSegments.length - 1]
    return t + (q - last.startQ) * (60 / last.bpm)
  }

  let divisions: number | null = null
  let beats = 4
  let beatType = 4
  let globalQ = 0
  let lastMain: DeterministicTimelineNote | null = null // 最近的发声主音（grace t0 锚点）
  let warnedDivisions = false
  const validatedMeasures = new Set<number>()

  for (const idx of expandPerformanceOrder(measures)) {
    const measure = measures[idx]
    const measureNo = measureNumberOf(measure, idx)
    let q = 0 // 小节内四分音符游标
    let maxQ = 0 // 小节内游标曾到达的最远位置（backup 不能缩短小节）
    let events = 0
    const voiceSums = new Map<number, number>()

    for (const child of childrenOf(measure)) {
      const tag = tagOf(child)
      if (tag === 'attributes') {
        const div = numText(kid(child, 'divisions'))
        if (div !== null && div > 0) divisions = div
        const time = kid(child, 'time')
        if (time) {
          const b = numText(kid(time, 'beats'))
          const bt = numText(kid(time, 'beat-type'))
          if (b !== null && bt !== null && b > 0 && bt > 0) {
            beats = b
            beatType = bt
          }
        }
        continue
      }
      if (tag === 'direction') {
        for (const dt of kids(child, 'direction-type')) {
          const metronome = kid(dt, 'metronome')
          const bpm = metronome ? numText(kid(metronome, 'per-minute')) : null
          if (bpm !== null) setBpm(bpm, globalQ + q)
        }
        const snd = kid(child, 'sound')
        if (snd) {
          const t = Number(attrsOf(snd)['tempo'])
          if (Number.isFinite(t) && t > 0) setBpm(t, globalQ + q)
        }
        continue
      }
      if (tag === 'sound') {
        const t = Number(attrsOf(child)['tempo'])
        if (Number.isFinite(t) && t > 0) setBpm(t, globalQ + q)
        continue
      }
      if (tag === 'backup') {
        const d = numText(kid(child, 'duration'))
        if (d !== null) q -= d / (divisions ?? 1)
        continue
      }
      if (tag === 'forward') {
        const d = numText(kid(child, 'duration'))
        if (d !== null) {
          if (divisions === null && !warnedDivisions) {
            warnedDivisions = true
            divisions = 1
            warnings.push('缺少 divisions，按 1 处理')
          }
          const durQ = d / divisions!
          events++
          q += durQ
          if (q > maxQ) maxQ = q
          const v = numText(kid(child, 'voice'))
          if (v !== null) voiceSums.set(v, (voiceSums.get(v) ?? 0) + durQ)
        }
        continue
      }
      if (tag !== 'note') continue

      const grace = !!kid(child, 'grace')
      const chord = !!kid(child, 'chord')
      const rest = !!kid(child, 'rest')
      const durRaw = numText(kid(child, 'duration'))
      if (durRaw !== null && divisions === null && !warnedDivisions) {
        warnedDivisions = true
        divisions = 1
        warnings.push('缺少 divisions，按 1 处理')
      }
      const durQ = durRaw !== null && divisions !== null ? durRaw / divisions : 0
      const voice = numText(kid(child, 'voice')) ?? 1
      const pitchNode = kid(child, 'pitch')
      const pitch = pitchNode && !rest ? pitchName(pitchNode) : null
      let isTieStart = false
      let isTieStop = false
      for (const tie of kids(child, 'tie')) {
        const t = attrsOf(tie)['type']
        if (t === 'start') isTieStart = true
        if (t === 'stop') isTieStop = true
      }

      if (grace) {
        // 装饰音：不占时值，t0 锚在前一主音的起始秒
        const startQ = globalQ + q
        const t0 = lastMain ? lastMain.t0Sec : timeAt(startQ)
        notes.push({
          pitch,
          measure: measureNo,
          playIndex: notes.length,
          startQ,
          durQ: 0,
          t0Sec: t0,
          t1Sec: t0,
          isGrace: true,
          isTieStart,
          isTieStop,
          voice,
        })
        continue
      }
      if (chord) continue // 和弦成员与前一音同时发声：不累加时间、只记一次
      events++
      const startQ = globalQ + q
      const t0 = timeAt(startQ)
      const entry: DeterministicTimelineNote = {
        pitch,
        measure: measureNo,
        playIndex: notes.length,
        startQ,
        durQ,
        t0Sec: t0,
        t1Sec: timeAt(startQ + durQ),
        isGrace: false,
        isTieStart,
        isTieStop,
        voice,
      }
      notes.push(entry)
      if (pitch !== null) lastMain = entry
      q += durQ
      if (q > maxQ) maxQ = q
      voiceSums.set(voice, (voiceSums.get(voice) ?? 0) + durQ)
    }

    // 小节校验：各 voice 时值之和 == 拍号拍数；不符收集 warning，不抛异常
    if (!validatedMeasures.has(idx)) {
      validatedMeasures.add(idx)
      if (events > 0 && voiceSums.size > 0) {
        const expected = (beats * 4) / beatType
        for (const [v, sum] of voiceSums) {
          if (Math.abs(sum - expected) > 1e-3) {
            warnings.push(
              `小节 ${measureNo} voice ${v} 时值 ${Math.round(sum * 1000) / 1000} ≠ 拍号 ${beats}/${beatType}（${expected} 四分音符）`,
            )
          }
        }
      }
    }

    // 空小节（无任何 note/forward 事件）按拍号全长推进；其余按最远游标
    globalQ += maxQ > 0 ? maxQ : events > 0 ? 0 : (beats * 4) / beatType
  }

  const totalQ = globalQ
  const endSec = timeAt(totalQ)
  return { notes, totalQ, endSec, tempoSegments, warnings }
}

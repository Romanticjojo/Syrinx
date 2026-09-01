import type { NoteEvent, Timeline } from '../types'

/** step → 半音偏移（相对 C） */
const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * 反复记号展开：把 forward→backward 之间的段落复制成实体小节，光标/高亮即可线性走谱。
 * 为什么展开而不是让光标跳：OSMD cursor iterator 默认不跳 repeat，跳段需要自定义路径，
 * 且展开后 timeline 小节序与谱面渲染序一一对应，音符变色（accent 高亮）顺序天然一致。
 * 约定：单层反复、每段演奏两遍（标准写法）；支持 volta（ending 一房/二房，第二遍
 * 跳过一房子整块）；检测到 D.C./D.S./Coda 不支持，原样返回。
 * luv-letter Soundslice 精校谱（t_76c0cbff）带 7 对反复记号 + volta，由本函数物化成
 * 播放序线性谱；beats.json v3 锚点按展开后小节序标定（离线 DTW，omr-work/t_76c0cbff/）。
 */
/**
 * 强制换行剥离（t_c10d648d）：删掉 <print> 上的 new-system/new-page 属性。
 * 曲谱源文件（如 luv-letter OMR 转换谱）按 A4 打印版式硬编码换行，OSMD 会照办，
 * 导致容器限宽/A4 缩窄完全失效；剥掉后换行交还 OSMD 按容器宽度自适应重排。
 * 只动属性不动谱面内容；无 <print> 时原样返回引用（零开销）。
 */
export function stripForcedBreaks(xml: string): string {
  if (!xml.includes('<print')) return xml
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return xml
  const prints = doc.querySelectorAll('print')
  if (prints.length === 0) return xml
  let removed = false
  for (const print of Array.from(prints)) {
    for (const attr of ['new-system', 'new-page']) {
      if (print.hasAttribute(attr)) {
        print.removeAttribute(attr)
        removed = true
      }
    }
  }
  if (!removed) return xml
  return new XMLSerializer().serializeToString(doc)
}

export function expandRepeats(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return xml

  // D.C./D.S./Coda 一律不展开（展开语义需要 coda 跳转表，超出本需求）
  for (const words of doc.querySelectorAll('words')) {
    if (/D\.C\.|D\.S\.|Coda|To Coda|da capo|dal segno/i.test(words.textContent ?? '')) return xml
  }

  const parts = Array.from(doc.querySelectorAll('part'))
  let expandedAny = false
  for (const part of parts) {
    const measures = Array.from(part.querySelectorAll('measure'))
    // 每小节标记：右 barline 上的 forward / backward repeat + volta（ending）起止
    const hasForward = measures.map(
      (m) => !!Array.from(m.querySelectorAll('barline repeat')).find((r) => r.getAttribute('direction') === 'forward'),
    )
    const hasBackward = measures.map(
      (m) => !!Array.from(m.querySelectorAll('barline repeat')).find((r) => r.getAttribute('direction') === 'backward'),
    )
    if (!hasBackward.some(Boolean)) continue
    // volta：小节左 barline 的 ending start（number 可为 "1" / "1, 2"）与其 stop 所在小节
    const endingStart = measures.map((m) => {
      const el = Array.from(m.querySelectorAll('barline ending')).find((e) => e.getAttribute('type') === 'start')
      if (!el) return null
      return (el.getAttribute('number') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    })
    const endingStopOf = new Map<number, number>() // ending start 小节 → stop 所在小节
    measures.forEach((m, idx) => {
      const stop = Array.from(m.querySelectorAll('barline ending')).find((e) => e.getAttribute('type') === 'stop')
      if (!stop) return
      // 向前找最近的、尚未配对的同号 start
      const num = stop.getAttribute('number') ?? ''
      for (let k = idx; k >= 0; k--) {
        if (endingStart[k]?.includes(num) && !endingStopOf.has(k)) {
          endingStopOf.set(k, idx)
          break
        }
      }
    })

    // 模拟演奏序：遇到未跳过的 backward 回退到最近的 forward（没有则回开头），每处最多跳一次；
    // volta（ending）：第二遍起，遍数不在 bracket number 列表内的小节块整块跳过（一房子只奏一遍）
    const order: number[] = []
    const jumped = new Set<number>()
    const forwardStack: number[] = []
    const passOf = new Map<number, number>() // 段落起点小节 → 当前遍数（1 起）
    let pass = 1 // 当前所在段落的遍数（无 forward 记号时兜底）
    let i = 0
    let guard = 0
    while (i < measures.length && guard < measures.length * 4) {
      guard++
      // 遍数不匹配的 volta 块：跳到 stop 之后继续
      if (endingStart[i] && !endingStart[i]!.includes(String(pass))) {
        const stopAt = endingStopOf.get(i)
        if (stopAt !== undefined) {
          i = stopAt + 1
          continue
        }
      }
      order.push(i)
      if (hasForward[i]) {
        if (forwardStack.length === 0 || forwardStack[forwardStack.length - 1] !== i) forwardStack.push(i)
        if (!passOf.has(i)) passOf.set(i, 1)
        pass = passOf.get(i)!
      }
      if (hasBackward[i] && !jumped.has(i)) {
        jumped.add(i)
        const f = forwardStack.length > 0 ? (forwardStack.pop() as number) : 0
        const next = (passOf.get(f) ?? 1) + 1
        passOf.set(f, next)
        pass = next
        i = f
        continue
      }
      i++
    }

    // 无实际反复（backward 都没生效）则不动
    if (order.length === measures.length) continue

    // 按演奏序重建小节：克隆 + 顺序重编号 + 摘除 repeat/ending 标记（volta 语义已物化，
    // 展开 OSMD 渲染线性谱；ending 不摘会在展开谱上残留volta括号）。
    // 演奏序第 1 小节直接复用原始 m1 节点而非克隆：全曲唯一的 <attributes>（clef/key/
    // time/divisions）随它保留——克隆体一律摘除 attributes，否则 OSMD 在展开谱中间行内
    // 重画小谱号 + 拍号（用户可见的多余符号），且 divisions 丢失会破坏时间轴换算
    const frag = doc.createDocumentFragment()
    order.forEach((idx, seq) => {
      if (seq === 0 && idx === 0) {
        const head = measures[0]
        head.setAttribute('number', '1')
        head.querySelectorAll('repeat, ending').forEach((r) => r.remove())
        frag.appendChild(head)
        return
      }
      const clone = measures[idx].cloneNode(true) as Element
      clone.setAttribute('number', String(seq + 1))
      clone.querySelectorAll('repeat, ending').forEach((r) => r.remove())
      clone.querySelectorAll('attributes').forEach((a) => a.remove())
      frag.appendChild(clone)
    })
    measures.forEach((m, i) => {
      if (i > 0) m.remove() // m1 已移入 frag，再 remove 会把它从 frag 摘掉
    })
    part.appendChild(frag)
    expandedAny = true
  }

  if (!expandedAny) return xml
  return new XMLSerializer().serializeToString(doc)
}

/**
 * MusicXML → 统一时间轴（纯函数）。
 * 约定：取第一个 part 的首个 voice（长笛独奏谱 = voice 1）；全曲恒速（首个 tempo）；
 * 支持中途 direction 变速累计；休止符/和弦备选音占时值但不产生音符事件。
 * 单声部保险（t_d02450b9）：OMR 假声部（voice 2/3）不再产生音符事件——
 * 游标仍按全部音符推进（backup/forward 数学不变），只过滤发声，双保险防假音污染。
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
  const measureTimes: { measure: number; time: number; quarters: number; end?: true }[] = []
  // 首个出现的 voice 为主声部；其后其他 voice 的音符只占时不发声
  let mainVoice: string | null = null

  // 以"四分音符数"为游标，最后统一乘 secPerQuarter
  let cursorQuarters = 0
  let secPerQuarterNow = 60 / tempo
  let secCursor = 0 // 秒游标（支持变速累计）
  let measureNo = 0

  const measures = part.querySelectorAll('measure')
  measures.forEach((measure) => {
    measureNo = Number(measure.getAttribute('number')) || measureNo + 1
    // 小节起点（含四分音符位置：光标按小节锚点插值要用，t_3b9cfc25）
    const measureStartQuartersAbs = cursorQuarters
    measureTimes.push({ measure: measureNo, time: secCursor, quarters: measureStartQuartersAbs })
    let measureStartQuarters = cursorQuarters
    // 小节内游标曾到达的最远位置：小节时长按最远位置算（backup 回退不能缩短小节）
    let measureMaxQuarters = cursorQuarters

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
      const voiceEl = el.querySelector('voice')
      const voice = voiceEl?.textContent ?? null
      if (mainVoice === null && voice !== null && !isRest) mainVoice = voice
      const isMainVoice = voice === null || mainVoice === null || voice === mainVoice
      if (pitch && !isRest && isMainVoice) {
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
      if (cursorQuarters > measureMaxQuarters) measureMaxQuarters = cursorQuarters
    })
    // 小节结束：按本小节最远游标位置折算为秒（多声部 backup 后游标停在半途，不能按停点算小节长）
    secCursor += (measureMaxQuarters - measureStartQuarters) * secPerQuarterNow
  })
  // 终点标记：measureTimes 末项不是真实小节，供 quarters→时间 插值覆盖到最后一个音符
  measureTimes.push({ measure: measureNo + 1, time: secCursor, quarters: cursorQuarters, end: true })

  const secPerQuarter = 60 / tempo
  const durationSec = notes.reduce((end, n) => Math.max(end, n.time + n.duration), 0)

  return { durationSec, secPerQuarter, tempo, notes, measureTimes }
}

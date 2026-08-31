import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { Timeline } from '../types'

/**
 * OSMD 曲谱渲染封装：
 * - 暗色谱面（白色音符、透明背景，融入暗色界面）
 * - 主题色光标（每曲 accent）
 * - 音符高亮：光标所在音符染成 accent 色（演奏主视觉），离开恢复白色——
 *   「吹到哪个音，哪个音符变色」（任务 t_a857b79e Bug 4）
 * - syncToTime(t)：由伴奏音频时钟每帧驱动，光标推进到时间 t
 *   （音值感知：光标停在正在响的音上，直到该音时值结束、下一停靠点开始）
 * - followCursor 自动滚动；小节变化通过 onMeasureChange 回调（不进响应式 store）
 */
export class OSMDScore {
  private osmd: OpenSheetMusicDisplay
  private containerEl: HTMLElement
  private secPerQuarter = 0.5
  private measureTimes: { measure: number; time: number; quarters: number; end?: true }[] = []
  private lastMeasure = 0
  private totalMeasures = 0
  private accent: string
  private baseNoteColor: string
  /** dispose 后作废在途 load：StrictMode 双挂载下防僵尸渲染（容器里出现两份谱面） */
  private disposed = false
  /** 上一帧被染色的 GraphicalNote：一帧至多一个当前音，离开时恢复 */
  private highlighted: { setColor: (c: string, o?: unknown) => void } | null = null
  /**
   * 预扫缓存的光标停靠点（voiceEntry 级，全音符 RealValue 单位）。
   * syncToTime 用「下一停靠点的开始时刻已到才前进」实现音值感知推进：
   * 旧逻辑是「当前停靠点已开始即前进」，光标高亮永远趴在下一个还没响的音上，
   * 长音（二分/全音符）被瞬间掠过（2026-08-31 光标拍子修复）。
   */
  private stopQuarters: number[] = []
  /** 下一可跨越的停靠点下标：光标停在 stopQuarters[nextIdx-1] 上，随 reset 归 1 */
  private nextIdx = 0
  /** 预扫结果为空时回退旧的推进逻辑（防御：OSMD 行为异常不致命） */
  private useStopTable = false
  /** 小节变化回调（rAF 中触发，直接操作 DOM，勿 setState） */
  onMeasureChange?: (measure: number, total: number) => void

  constructor(container: HTMLElement, accent = '#3ddfae', osmdInstance?: OpenSheetMusicDisplay) {
    this.containerEl = container
    this.accent = accent
    this.baseNoteColor = '#e8e8e2' // 暗底下降一档对比：纯白刺眼（t_3b9cfc25）
    // osmdInstance：测试注入口（happy-dom 下不真正渲染 OSMD），缺省构造真实实例
    this.osmd = osmdInstance ?? new OpenSheetMusicDisplay(container, {
      autoResize: true,
      backend: 'svg',
      followCursor: true,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawMetronomeMarks: false,
      drawMeasureNumbers: true,
      drawTimeSignatures: true,
      defaultColorMusic: '#dedbd3', // 谱线/符杆同步降对比（t_3b9cfc25）
      defaultColorNotehead: this.baseNoteColor,
      defaultColorRest: '#9a9a90',
      defaultColorLabel: '#b3b3b3',
      cursorsOptions: [
        { type: 1, color: accent, follow: true, alpha: 0.35 }, // ThinLeft 细竖线（辅助）
      ],
    })
    this.osmd.FollowCursor = true
  }

  async load(xml: string, timeline: Timeline): Promise<void> {
    await this.osmd.load(xml)
    if (this.disposed) return
    this.osmd.render()
    this.secPerQuarter = timeline.secPerQuarter
    this.measureTimes = timeline.measureTimes
    // 终点标记不是真实小节
    this.totalMeasures = timeline.measureTimes.filter((e) => !e.end).length
    this.lastMeasure = 0
    this.highlighted = null
    this.prescanCursorStops()
  }

  /**
   * 预扫光标停靠点：load 完成后用 cursor iterator 走一遍（记录后 reset），
   * 缓存每个停靠点的全音符位置。OSMD cursor 在 voiceEntry 级停靠，
   * 预扫即可拿到全部停靠点，无需改 OSMD 源码。结果为空则回退旧推进逻辑。
   */
  private prescanCursorStops(): void {
    const cursor = this.osmd.cursor
    cursor.reset()
    const it = cursor.iterator
    const stops: number[] = []
    let guard = 0
    while (!it.EndReached && guard < 8192) {
      stops.push(it.currentTimeStamp.RealValue)
      cursor.next()
      guard++
    }
    cursor.reset()
    this.useStopTable = stops.length > 0
    this.stopQuarters = stops
    this.nextIdx = 1
  }

  /** 显示光标并置于起点 */
  showCursor(): void {
    this.osmd.cursor.reset()
    this.osmd.cursor.show()
    this.lastMeasure = 0
    this.nextIdx = 1
  }

  /** 重置光标到起点（seek 用） */
  resetCursor(): void {
    this.osmd.cursor.reset()
    this.lastMeasure = 0
    this.nextIdx = 1
  }

  /** 把当前光标下的音符染成 accent 色，上一帧的恢复原色 */
  private updateHighlight(): void {
    const gnotes = this.osmd.cursor.GNotesUnderCursor()
    const next = (gnotes.find((g) => !g.sourceNote?.isRest?.()) ?? null) as
      | { setColor: (c: string, o?: unknown) => void; sourceNote?: unknown }
      | null
    if (next === this.highlighted) return
    if (this.highlighted) {
      try {
        this.highlighted.setColor(this.baseNoteColor)
      } catch {
        /* 渲染层可能已重排，忽略单帧恢复失败 */
      }
    }
    this.highlighted = null
    if (next) {
      try {
        next.setColor(this.accent)
        this.highlighted = next
      } catch {
        /* 同上 */
      }
    }
  }

  /** 四分音符位置 → 曲目时间（秒）：按 measureTimes（含伴奏锚点，t_3b9cfc25）分段线性插值。
   *  注意 OSMD iterator 的 RealValue 单位是全音符（实测 62 小节 4/4 全谱 0→61.75，
   *  t_b22f5467 项 5 联调定位），×4 换算成四分音符数后再对锚点表插值 */
  private timeAtQuarters(rvWhole: number): number {
    const rv = rvWhole * 4
    const mt = this.measureTimes
    if (mt.length === 0) return rv * this.secPerQuarter
    let k = 0
    while (k + 1 < mt.length && mt[k + 1].quarters <= rv) k++
    if (k + 1 >= mt.length) return mt[k].time + (rv - mt[k].quarters) * this.secPerQuarter
    const dq = mt[k + 1].quarters - mt[k].quarters
    if (dq <= 0) return mt[k].time
    return mt[k].time + ((rv - mt[k].quarters) * (mt[k + 1].time - mt[k].time)) / dq
  }

  /** 每帧调用：把光标推进到曲目时间 t（秒）。由 rAF 驱动，只前进不后退。
   *  音值感知推进（任务 A）：下一个停靠点的开始时刻已到才前进——光标/高亮
   *  停在正在响的音上，直到该音实际时值结束；只前进语义与 seek 快进机制不变 */
  syncToTime(t: number): void {
    const cursor = this.osmd.cursor
    const it = cursor.iterator
    let advanced = false
    if (this.useStopTable) {
      while (
        this.nextIdx < this.stopQuarters.length &&
        this.timeAtQuarters(this.stopQuarters[this.nextIdx]) <= t
      ) {
        cursor.next()
        this.nextIdx++
        advanced = true
      }
    } else {
      // 回退：预扫结果为空时沿用旧「当前停靠点已开始即前进」（防御）
      let guard = 0
      while (
        !it.EndReached &&
        this.timeAtQuarters(it.currentTimeStamp.RealValue) <= t &&
        guard < 2048
      ) {
        cursor.next()
        advanced = true
        guard++
      }
    }
    if (advanced) this.updateHighlight()
    // 当前小节：由 measureTimes 反查（iterator.currentMeasure 是私有成员）；终点标记不计
    let m = 1
    for (let i = 0; i < this.measureTimes.length; i++) {
      const e = this.measureTimes[i]
      if (!e.end && e.time <= t) m = e.measure
      else if (e.end) break
    }
    if (m !== this.lastMeasure) {
      this.lastMeasure = m
      this.onMeasureChange?.(m, this.totalMeasures)
    }
  }

  /** 点击反查小节号（t_b22f5467 项 4）：谱面视口坐标 → 命中小节。
   *  距离策略：y 最近的小节行内取 x 最近的小节——点行首/行尾空白也能命中，
   *  谱面无谱或未渲染返回 null。 */
  measureAtPoint(clientX: number, clientY: number): number | null {
    const svg = this.containerEl.querySelector('svg')
    if (!svg) return null
    // OSMD 图形坐标 unitInPixels=10，zoom 叠加缩放；svg 无 viewBox，px 1:1
    const unitPx = 10 * (this.osmd.Zoom || 1)
    const svgRect = svg.getBoundingClientRect()
    const x = clientX - svgRect.left
    const y = clientY - svgRect.top
    const ml = this.osmd.GraphicSheet?.MeasureList
    if (!ml) return null
    // y 最近的小节行
    let bestSystem: { num: number; d: number } | null = null
    for (const systemMeasures of ml) {
      if (!systemMeasures?.length) continue
      let top = Infinity
      let bottom = -Infinity
      for (const m of systemMeasures) {
        const ps = m.PositionAndShape
        top = Math.min(top, ps.AbsolutePosition.y * unitPx)
        bottom = Math.max(bottom, (ps.AbsolutePosition.y + ps.Size.height) * unitPx)
      }
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0
      if (bestSystem && dy >= bestSystem.d) continue
      // 行内 x 最近的小节
      let best: { num: number; d: number } | null = null
      for (const m of systemMeasures) {
        const ps = m.PositionAndShape
        const left = ps.AbsolutePosition.x * unitPx
        const right = left + ps.Size.width * unitPx
        const dx = x < left ? left - x : x > right ? x - right : 0
        if (!best || dx < best.d) best = { num: m.MeasureNumber, d: dx }
      }
      if (best) bestSystem = { num: best.num, d: dy }
    }
    return bestSystem ? bestSystem.num : null
  }

  /** [sync-tune 调试页扩展] 点击反查音符级位置：y 最近小节行内取 x 最近的
   *  staffEntry，返回 { 小节号, 小节内全音符位置 }；谱面无谱/未渲染返回 null。
   *  独立可选方法：演奏页不调用，缺省行为不变。 */
  noteAtPoint(clientX: number, clientY: number): { measure: number; rvInMeasure: number } | null {
    const svg = this.containerEl.querySelector('svg')
    if (!svg) return null
    const unitPx = 10 * (this.osmd.Zoom || 1)
    const svgRect = svg.getBoundingClientRect()
    const x = clientX - svgRect.left
    const y = clientY - svgRect.top
    const ml = this.osmd.GraphicSheet?.MeasureList
    if (!ml) return null
    // y 最近的小节行（与 measureAtPoint 同距离策略）
    let bestRow: { measures: (typeof ml)[number]; d: number } | null = null
    for (const systemMeasures of ml) {
      if (!systemMeasures?.length) continue
      let top = Infinity
      let bottom = -Infinity
      for (const m of systemMeasures) {
        const ps = m.PositionAndShape
        top = Math.min(top, ps.AbsolutePosition.y * unitPx)
        bottom = Math.max(bottom, (ps.AbsolutePosition.y + ps.Size.height) * unitPx)
      }
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0
      if (!bestRow || dy < bestRow.d) bestRow = { measures: systemMeasures, d: dy }
    }
    if (!bestRow) return null
    // 行内 x 最近的 staffEntry（staffEntry 位置相对小节，叠上小节 x 得 svg 坐标）
    let best: { measure: number; rv: number; d: number } | null = null
    for (const m of bestRow.measures) {
      const mx = m.PositionAndShape.AbsolutePosition.x * unitPx
      for (const se of m.staffEntries) {
        const sx = mx + se.PositionAndShape.AbsolutePosition.x * unitPx
        const d = Math.abs(x - sx)
        if (!best || d < best.d) {
          best = { measure: m.MeasureNumber, rv: se.sourceStaffEntry?.Timestamp?.RealValue ?? 0, d }
        }
      }
    }
    return best ? { measure: best.measure, rvInMeasure: best.rv } : null
  }

  /**
   * [sync-tune 调试页扩展] 控制点标记层：谱面上叠加定位刻度（如 beats 微调页的
   * 控制点/选中音标记）。空数组清除整层；OSMD 未渲染时忽略。纯 overlay，
   * 不触碰谱面图形树，缺省（不调用）行为不变。
   */
  setMarkers(markers: { measure: number; rvInMeasure: number; color: string; title?: string }[]): void {
    const layer =
      this.containerEl.querySelector<HTMLElement>('.sync-marker-layer') ??
      document.createElement('div')
    layer.className = 'sync-marker-layer'
    if (!markers.length) {
      layer.remove()
      return
    }
    const svg = this.containerEl.querySelector('svg')
    const ml = this.osmd.GraphicSheet?.MeasureList
    if (!svg || !ml) return
    layer.innerHTML = ''
    // 容器可能带内边距：svg 相对容器的偏移叠进标记坐标
    const cRect = this.containerEl.getBoundingClientRect()
    const svgRect = svg.getBoundingClientRect()
    const offX = svgRect.left - cRect.left
    const offY = svgRect.top - cRect.top
    const unitPx = 10 * (this.osmd.Zoom || 1)
    // 小节号 → 几何（首个同名项）+ 小节内 rv→x 映射（staffEntry 线性插值，缺数据回退比例）
    const geom = new Map<number, { x: number; y: number; w: number; h: number; se: { rv: number; x: number }[] }>()
    for (const systemMeasures of ml) {
      if (!systemMeasures?.length) continue
      for (const m of systemMeasures) {
        if (geom.has(m.MeasureNumber)) continue
        const ps = m.PositionAndShape
        geom.set(m.MeasureNumber, {
          x: ps.AbsolutePosition.x * unitPx,
          y: ps.AbsolutePosition.y * unitPx,
          w: ps.Size.width * unitPx,
          h: ps.Size.height * unitPx,
          se: m.staffEntries.map((se) => ({
            rv: se.sourceStaffEntry?.Timestamp?.RealValue ?? 0,
            x: se.PositionAndShape.AbsolutePosition.x,
          })),
        })
      }
    }
    for (const mk of markers) {
      const g = geom.get(mk.measure)
      if (!g) continue
      // rv→x：夹取到 staffEntry 时间戳范围后按相邻项线性插值（符距与音值近似成正比）；
      // 无 staffEntry 数据时回退小节宽度比例（fx 与 g.x 同为 OSMD 单位）
      const last = g.se.at(-1)
      const rel = Math.max(0, Math.min(last?.rv ?? 1, mk.rvInMeasure))
      let fx: number
      if (!last) fx = 0
      else if (rel >= last.rv) fx = last.x
      else {
        const i = g.se.findIndex((p) => p.rv > rel)
        if (i <= 0) fx = g.se[0].x
        else {
          const a = g.se[i - 1]
          const b = g.se[i]
          fx = a.x + ((b.x - a.x) * (rel - a.rv)) / Math.max(b.rv - a.rv, 1e-9)
        }
      }
      const el = document.createElement('div')
      el.className = 'sync-marker'
      el.style.left = `${offX + g.x + fx * unitPx}px`
      el.style.top = `${offY + g.y}px`
      el.style.height = `${g.h}px`
      el.style.borderColor = mk.color
      if (mk.title) el.title = mk.title
      layer.appendChild(el)
    }
    if (layer.parentElement !== this.containerEl) this.containerEl.appendChild(layer)
  }

  dispose(): void {
    this.disposed = true
    // OSMD 无 dispose API；清空容器释放 DOM
    this.containerEl.innerHTML = ''
  }
}

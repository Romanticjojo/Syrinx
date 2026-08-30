import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { Timeline } from '../types'

/**
 * OSMD 曲谱渲染封装：
 * - 暗色谱面（白色音符、透明背景，融入暗色界面）
 * - 主题色光标（每曲 accent）
 * - 音符高亮：光标所在音符染成 accent 色（演奏主视觉），离开恢复白色——
 *   「吹到哪个音，哪个音符变色」（任务 t_a857b79e Bug 4）
 * - syncToTime(t)：由伴奏音频时钟每帧驱动，光标推进到时间 t
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
  /** 小节变化回调（rAF 中触发，直接操作 DOM，勿 setState） */
  onMeasureChange?: (measure: number, total: number) => void

  constructor(container: HTMLElement, accent = '#3ddfae') {
    this.containerEl = container
    this.accent = accent
    this.baseNoteColor = '#e8e8e2' // 暗底下降一档对比：纯白刺眼（t_3b9cfc25）
    this.osmd = new OpenSheetMusicDisplay(container, {
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
  }

  /** 显示光标并置于起点 */
  showCursor(): void {
    this.osmd.cursor.reset()
    this.osmd.cursor.show()
    this.lastMeasure = 0
  }

  /** 重置光标到起点（seek 用） */
  resetCursor(): void {
    this.osmd.cursor.reset()
    this.lastMeasure = 0
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

  /** 每帧调用：把光标推进到曲目时间 t（秒）。由 rAF 驱动，只前进不后退 */
  syncToTime(t: number): void {
    const cursor = this.osmd.cursor
    const it = cursor.iterator
    let guard = 0
    let advanced = false
    while (!it.EndReached && this.timeAtQuarters(it.currentTimeStamp.RealValue) <= t && guard < 2048) {
      cursor.next()
      advanced = true
      guard++
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

  dispose(): void {
    this.disposed = true
    // OSMD 无 dispose API；清空容器释放 DOM
    this.containerEl.innerHTML = ''
  }
}

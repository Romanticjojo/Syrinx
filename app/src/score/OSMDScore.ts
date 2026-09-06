import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { Timeline } from '../types'

/** [t_7518c69e] 换行跟随滑移动画参数：ease-out cubic，约 500ms */
const SCROLL_ANIM_MS = 500
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3

/** [t_7518c69e] 系统减少动态偏好（ui-ux-pro-max：prefers-reduced-motion
 *  优先于一切装饰性动效）：reduce 时换行滚动跳过动画直达 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** 小节几何缓存结构（markerGeom）：标记层（t_perf_sync_tune）与小节聚焦（T3）共用 */
type MarkerGeom = {
  map: Map<number, { x: number; y: number; w: number; h: number; se: { rv: number; x: number }[] }>
  offX: number
  offY: number
  unitPx: number
  /** [T3b] 命中测试行表（noteAtPoint 用） */
  hitRows: HitRow[]
  /** [T3c] 光标跨度查表：全谱 staffEntry 的 {全局 rv(全音符), 行内绝对 x(单位)}，
   *  按 rv 升序去重（updateCursorSpan 用） */
  cursorStops: { rv: number; x: number }[]
}

/** [T3b] 命中测试表项：x = 音符头绘制包络中心（svg px），ys = 各音符头中心 y，
 *  hw = 音符头半宽（precise 判定阈值） */
type HitEntry = { m: number; rv: number; x: number; ys: number[]; hw: number }
/** [T3b] 命中测试行：noteAtPoint 用——行几何 + 行内全部 HitEntry */
type HitRow = { top: number; bottom: number; entries: HitEntry[] }

/** [T3b] 命中路径上 GraphicalNote 可用的几何来源（DOM SVG 元素 / PositionAndShape） */
type HitDomNote = {
  getNoteheadSVGs?: () => { getBoundingClientRect(): ClientRectLike }[]
  getModifierSVGs?: () => { getBoundingClientRect(): ClientRectLike }[]
  PositionAndShape?: {
    AbsolutePosition: { x: number; y: number }
    Size: { width: number; height: number }
  }
}
/** DOM rect 最小面（含 right/bottom 的计算字段） */
type ClientRectLike = { left: number; right: number; top: number; bottom: number; width: number; height: number }

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
  /** 谱面缩放（构造传入，load 时真正生效——见构造函数注释） */
  private zoom: number
  /** 上一帧被染色的 GraphicalNote：一帧至多一个当前音，离开时恢复 */
  private highlighted: { setColor: (c: string, o?: unknown) => void } | null = null
  /** [sync-tune T3] 选中的 GraphicalNote（三向选中染色持有者，独立于光标高亮） */
  private selNote: { setColor: (c: string, o?: unknown) => void } | null = null
  /** [T3b] 选中音染色：与播放光标 accent 视觉分离（sync-tune 传 #ff9f43）；
   *  缺省跟随 accent——演奏页不传第 5 参，行为与 T3b 前完全一致 */
  private selColor: string
  /** [T3c] 光标跨时值高亮开关：开启后光标元素宽度覆盖当前音完整时值（sync-tune）；
   *  缺省 false，演奏页不传即维持 OSMD ThinLeft 窄条 */
  private cursorSpan: boolean
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

  // —— 标记层性能缓存（t_perf_sync_tune）——
  /** 小节几何缓存：load 渲染后首算，谱面不变则复用（601 标记共享一份） */
  private markerGeom: MarkerGeom | null = null
  /** 标记 DOM 元素池：key → 已定位元素，setMarkers 复用不再重建 */
  private markerEls = new Map<string, HTMLDivElement>()
  private markerLayer: HTMLElement | null = null
  /** 光标已由调用方显示（showCursor）：OSMD render() 会重建光标并隐藏
   *  （enableOrDisableCursors → 新 Cursor + init→hide），重渲后须自动恢复，
   *  否则光标永久 hidden → update() 早退 → 不滚动不高亮（切光标模式丢跟随的根因） */
  private cursorShown = false
  /** [t_7518c69e] 换行跟随滑移动画挂起的 rAF 句柄（0 = 无动画进行） */
  private scrollRaf = 0
  /** [t_7518c69e] 动画期间的让位监听摘除钩子（用户 wheel/pointerdown 即停） */
  private detachScrollGuard: (() => void) | null = null
  /** [t_1d124051] 谱面视口缩放系数（调用方 CSS transform: scale(k) 施加在渲染
   *  容器祖先上，fit 模式用）。几何缓存一律存「未缩放虚拟坐标」：构建时 DOM
   *  实测 rect（视觉值 = 未缩放 × k）÷ viewScale 归一；使用时滚动目标 ×
   *  viewScale、点击换算 ÷ viewScale——旋转/缩窗只更新 k，缓存不作废 */
  private viewScale = 1

  constructor(
    container: HTMLElement,
    accent = '#3ddfae',
    osmdInstance?: OpenSheetMusicDisplay,
    /** 谱面缩放（t_53aa8b7a）：配合容器 max-width 减少每行小节数，缺省 1 不改变现状 */
    zoom = 1,
    /** [T3b] 选中音颜色（可选）：与播放光标 accent 分离（sync-tune 传 #ff9f43）；
     *  缺省跟随 accent，演奏页不传即保持旧观感 */
    selectionColor?: string,
    /** [T3c] 光标高亮覆盖当前音完整时值跨度（宽度=当前停靠点→下一停靠点）；
     *  缺省 false：OSMD ThinLeft 窄条行为，演奏页不传即不变 */
    cursorSpan = false,
    /** OSMD 原生跟随滚动开关（缺省 true=原行为）。false 时滚动权移交调用方：
     *  演奏页在 onMeasureChange 里 scrollToMeasure 行居中+手动让位——若 OSMD
     *  原生 follow 同时开着，两个滚动驱动会打架（原生 follow 在让位期内仍会
     *  挪 scrollTop，与「手动滚谱 5s 让位」语义冲突，2026-09-04 fd 跟随修复实证） */
    autoScroll = true,
    /** [t_1d124051] OSMD window-resize 自动重渲开关（缺省 true=原行为）。fit 模式
     *  （固定 1280px 虚拟宽 + 外层 CSS scale）必须传 false：OSMD 的 autoResize 监听
     *  window resize（200ms 去抖）后不看容器宽是否变化、无条件全量 render()
     *  （min.js 实证 handleResize→renderAndScrollBack）——开着的话旋转/缩窗必然
     *  重排谱面，违背「只更新 scale 不重排」。reflow 模式（<640px 手机）容器宽真
     *  随视口变，保留原行为 */
    autoResize = true,
  ) {
    this.containerEl = container
    this.accent = accent
    this.selColor = selectionColor ?? accent
    this.cursorSpan = cursorSpan
    this.baseNoteColor = '#e8e8e2' // 暗底下降一档对比：纯白刺眼（t_3b9cfc25）
    // osmdInstance：测试注入口（happy-dom 下不真正渲染 OSMD），缺省构造真实实例
    this.osmd = osmdInstance ?? new OpenSheetMusicDisplay(container, {
      autoResize,
      backend: 'svg',
      followCursor: autoScroll,
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
        { type: 1, color: accent, follow: autoScroll, alpha: 0.35 }, // ThinLeft 细竖线（辅助）
      ],
    })
    this.osmd.FollowCursor = autoScroll
    // 关闭「final-barline 风格小节线后的系统行首重绘拍号」：反复展开谱每段末尾残留
    // light-heavy 小节线，OSMD 默认在其后的行首补画小谱号 + 拍号，观感即用户反馈的
    // 「行内多余谱号 + 4/4」；首小节拍号不受影响（isFirstSourceMeasure 仍绘制）。
    // EngravingRules 可选链保护：测试注入口的 fake 实例没有该成员
    if (this.osmd.EngravingRules) this.osmd.EngravingRules.ShowRhythmAgainAfterPartEndOrFinalBarline = false
    // 记录目标 zoom；实际设置推迟到 load() 内（load 后、render 前）——
    // OSMD 的 Zoom setter 只在内部已就绪时重算布局，构造期设置会被静默忽略
    // （探针实测：load 前设置 zoom 0.7/0.8/1.0 输出完全相同），t_53aa8b7a 的
    // 「zoom 缩谱」从未真正生效。渲染后 unitPx=10×Zoom 的几何口径不变。
    this.zoom = zoom
  }

  /** 恢复一个高亮音符的颜色（T3b 起按释放方区分）：光标释放时若音符仍被选中
   *  持有 → 保持选中色（鼠标意图优先，与光标 accent 同屏可分辨）；选中释放时
   *  若仍被光标持有 → accent；两方都不持有 → 恢复底色 */
  private restore(
    g: { setColor: (c: string, o?: unknown) => void },
    released: 'cursor' | 'sel',
  ): void {
    const color =
      released === 'cursor' && g === this.selNote
        ? this.selColor
        : released === 'sel' && g === this.highlighted
          ? this.accent
          : this.baseNoteColor
    try {
      g.setColor(color)
    } catch {
      /* 渲染层可能已重排，忽略单帧恢复失败 */
    }
  }

  async load(xml: string, timeline: Timeline): Promise<void> {
    await this.osmd.load(xml)
    if (this.disposed) return
    // zoom 在 load 后、render 前设置才真正生效（构造期设置被 OSMD 忽略，见构造注释）；
    // EngravingRules 可选链保护测试注入口（fake 无 Zoom setter 依赖的内部状态）
    this.osmd.Zoom = this.zoom
    this.osmd.render()
    // 新谱面几何：标记层缓存全部作废（t_perf_sync_tune）
    this.markerGeom = null
    this.markerEls.clear()
    this.markerLayer = null
    this.secPerQuarter = timeline.secPerQuarter
    this.measureTimes = timeline.measureTimes
    // 终点标记不是真实小节
    this.totalMeasures = timeline.measureTimes.filter((e) => !e.end).length
    this.lastMeasure = 0
    this.highlighted = null
    this.selNote = null
    this.prescanCursorStops()
    // 重渲后光标被 OSMD 重建并隐藏（根因见 cursorShown 注释）：之前显示过就恢复。
    // show() 内部 reset + update：光标回起点后由下一帧 syncToTime 快进到当前伴奏
    // 位置（只前进语义），切换瞬间即重定位且谱面跟随滚动。
    if (this.cursorShown) this.showCursor()
  }

  /** [sync-tune T3c] 就地更换时间轴（保存修改后播放即新节奏）：谱面不重渲，
   *  仅更新 measureTimes/secPerQuarter——停靠点 quarters 是谱面几何（不变），
   *  时间轴只改「quarters → 秒」的映射。独立可选方法：演奏页不调用，缺省行为不变。 */
  setTimeline(timeline: Timeline): void {
    this.secPerQuarter = timeline.secPerQuarter
    this.measureTimes = timeline.measureTimes
    this.totalMeasures = timeline.measureTimes.filter((e) => !e.end).length
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
    this.cursorShown = true
    this.osmd.cursor.reset()
    this.osmd.cursor.show()
    this.lastMeasure = 0
    this.nextIdx = 1
    this.updateCursorSpan()
  }

  /** 重置光标到起点（seek 用） */
  resetCursor(): void {
    this.osmd.cursor.reset()
    this.lastMeasure = 0
    this.nextIdx = 1
    this.updateCursorSpan()
  }

  /** [t_1d124051] 更新视口缩放系数（fit 模式旋转/缩窗时由谱面容器调用）。
   *  几何缓存存未缩放坐标，改 k 不作废缓存；k<=0 非法值兜底为 1 */
  setViewScale(k: number): void {
    this.viewScale = k > 0 ? k : 1
  }

  /** 把当前光标下的音符染成 accent 色，上一帧的恢复原色 */
  private updateHighlight(): void {
    const gnotes = this.osmd.cursor.GNotesUnderCursor()
    const next = (gnotes.find((g) => !g.sourceNote?.isRest?.()) ?? null) as
      | { setColor: (c: string, o?: unknown) => void; sourceNote?: unknown }
      | null
    if (next === this.highlighted) return
    const prev = this.highlighted
    this.highlighted = null
    if (prev) this.restore(prev, 'cursor')
    if (next) {
      try {
        // 选中持有的音符保持选中色（鼠标意图优先）；演奏页 selNote 恒为 null，行为不变
        if (next !== this.selNote) next.setColor(this.accent)
        this.highlighted = next
      } catch {
        /* 同上 */
      }
    }
  }

  /** [T3c] 光标跨时值高亮（可选功能，cursorSpan 开启时）：把光标元素（OSMD 公开
   *  的 cursorElement img）宽度覆写为「当前停靠点 → 下一停靠点」的横向跨度——
   *  即正在响的音的完整时值。OSMD ThinLeft 每次 cursor.next()/reset() 的 update()
   *  会把宽度重置为 5*zoom，故推进/重置后再覆写。末站（无下一停靠点）、跨行
   *  （下一停靠点 x 反而更小）、查表缺失时不覆写，保持 OSMD 缺省窄条。 */
  private updateCursorSpan(): void {
    if (!this.cursorSpan) return
    const img = (this.osmd.cursor as unknown as { cursorElement?: HTMLImageElement }).cursorElement
    if (!img) return
    const geom = this.ensureMarkerGeom()
    if (!geom) return
    const cur = this.stopQuarters[this.nextIdx - 1]
    const nxt = this.stopQuarters[this.nextIdx]
    if (cur === undefined || nxt === undefined) return
    const x0 = this.stopXAt(geom, cur)
    const x1 = this.stopXAt(geom, nxt)
    if (x0 === null || x1 === null || x1 <= x0) return
    const w = Math.round((x1 - x0) * geom.unitPx)
    if (w > 0) img.width = w
  }

  /** [T3c] 全局 rv（全音符）-> 最近 cursorStops 表项的行内绝对 x（单位）；空表 null */
  private stopXAt(geom: MarkerGeom, rv: number): number | null {
    const cs = geom.cursorStops
    if (!cs.length) return null
    let best = 0
    let bd = Math.abs(cs[0].rv - rv)
    for (let i = 1; i < cs.length; i++) {
      const d = Math.abs(cs[i].rv - rv)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return cs[best].x
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
    if (advanced) {
      this.updateHighlight()
      this.updateCursorSpan()
    }
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

  /** [sync-tune 调试页扩展（T3b 强化）] 点击反查音符级位置：markerGeom 的
   *  hitRows 缓存（行几何 + 音符头绘制 x，ensureMarkerGeom 一次构建复用），
   *  行内取「音符头绘制 x」最近的非休止 entry——staffEntry 锚点是时间位置 x，
   *  与音符头绘制 x 有横向偏差（accidental/宽头/密集段），按锚点最近邻会点 A 选 B。
   *  返回 { 小节号, 小节内全音符位置, 欧氏距离(px), 是否精确命中 }：
   *  - 行判定收紧：点击处与行几何 y 距离超行高一半 -> null（无效点击，不跨行乱选）
   *  - 同 x 并列（±4px，多声部）时 y 更接近点击处者优先
   *  - precise = 距离在音符头半宽内，供调用方三档提示（精确/附近/超距，T3b 决策 3）
   *  谱面无谱/未渲染返回 null。独立可选方法：演奏页不调用，缺省行为不变。 */
  noteAtPoint(
    clientX: number,
    clientY: number,
  ): { measure: number; rvInMeasure: number; dist: number; precise: boolean } | null {
    const svg = this.containerEl.querySelector('svg')
    if (!svg) return null
    const geom = this.ensureMarkerGeom()
    if (!geom || !geom.hitRows.length) return null
    const svgRect = svg.getBoundingClientRect()
    // [t_1d124051] 点击坐标是视觉值（svg 也被 transform 缩放，相减只剩 k 倍数），
    // ÷ viewScale 回未缩放虚拟坐标再比对 hitRows
    const x = (clientX - svgRect.left) / this.viewScale
    const y = (clientY - svgRect.top) / this.viewScale
    // y 最近的小节行；行判定收紧（T3b）：超行高一半直接淘汰
    let bestRow: { row: HitRow; d: number } | null = null
    for (const row of geom.hitRows) {
      const dy = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0
      if (dy > (row.bottom - row.top) / 2) continue
      if (!bestRow || dy < bestRow.d) bestRow = { row, d: dy }
    }
    if (!bestRow) return null
    // 行内音符头绘制 x 最近邻；x 并列（±4px）时 y 更接近点击处者优先（多声部/同 x）
    let best: { e: HitEntry; dx: number; dy: number } | null = null
    for (const e of bestRow.row.entries) {
      const dx = Math.abs(x - e.x)
      const dy = e.ys.length ? Math.min(...e.ys.map((yy) => Math.abs(y - yy))) : bestRow.d
      if (!best || dx < best.dx - 4 || (Math.abs(dx - best.dx) <= 4 && dy < best.dy)) {
        best = { e, dx, dy }
      }
    }
    if (!best) return null
    const dist = Math.hypot(best.dx, bestRow.d)
    return {
      measure: best.e.m,
      rvInMeasure: best.e.rv,
      dist,
      precise: dist <= Math.max(best.e.hw, 3),
    }
  }

  /** [sync-tune T3] 在 MeasureList 中找 (measure, rvInMeasure) 最近的非休止
   *  GraphicalNote（选中染色用；同小节跨行时取首个匹配小节） */
  private findGNote(
    measure: number,
    rvInMeasure: number,
  ): { setColor: (c: string, o?: unknown) => void } | null {
    const ml = this.osmd.GraphicSheet?.MeasureList
    if (!ml) return null
    for (const systemMeasures of ml) {
      if (!systemMeasures?.length) continue
      for (const m of systemMeasures) {
        // 空槽位防御（同 ensureMarkerGeom）：真实曲谱（river-flows-in-you/
        // birds-poem/expedition-33）的 MeasureList 可能含 undefined 小节
        // （OSMD 内部多项小节 bug），直接访问 MeasureNumber 会抛 TypeError
        // 且 React 无错误边界整页白屏。跳过空槽。
        if (!m?.staffEntries) continue
        if (m.MeasureNumber !== measure) continue
        // 行内 rv 最近的含非休止音符的 staffEntry（该 entry 只有休止符时顺延到更近的）
        let best: { d: number; g: { setColor: (c: string, o?: unknown) => void } } | null = null
        for (const se of m.staffEntries) {
          const rv = se.sourceStaffEntry?.Timestamp?.RealValue ?? 0
          const d = Math.abs(rv - rvInMeasure)
          if (best && d >= best.d) continue
          const gn = (
            (se.graphicalVoiceEntries ?? [])
              .flatMap((v) => v.notes ?? [])
              .find((n) => !n.sourceNote?.isRest?.()) ?? null
          ) as { setColor: (c: string, o?: unknown) => void } | null
          if (gn) best = { d, g: gn }
        }
        if (best) return best.g
      }
    }
    return null
  }

  /** [sync-tune 调试页扩展（T3）] 选中音染色：把 (measure, rvInMeasure) 处最近的
   *  notehead 染成选中色（缺省 accent，sync-tune 传橙色与光标分离，T3b），旧选中
   *  恢复白色；measure 传 null 仅清除选中。
   *  复用 updateHighlight 的 setColor 机制做单音符操作（不重建标记层、不动图形树），
   *  与光标高亮互不干扰：同一音符被光标/选中双方持有时显示选中色（鼠标意图优先）。
   *  独立可选方法：演奏页不调用，缺省行为不变。 */
  highlightNoteAt(measure: number | null, rvInMeasure = 0): void {
    const prev = this.selNote
    this.selNote = null
    if (measure !== null) {
      const gn = this.findGNote(measure, rvInMeasure)
      if (gn) {
        try {
          gn.setColor(this.selColor)
          this.selNote = gn
        } catch {
          /* 渲染层可能已重排，忽略本次染色失败 */
        }
      }
    }
    if (prev) this.restore(prev, 'sel')
  }

  /** [sync-tune T3] 小节自动聚焦：把第 m 小节所在行滚动到最近滚动
   *  祖先视口中部（markerGeom 同源的 MeasureList 几何）。滚动写入经
   *  animateScrollTo 缓动滑移（t_7518c69e）——程序性 scrollTop 写入不派发
   *  wheel/pointerdown，与页面侧「手动滚动 5 秒让位」逻辑不冲突。
   *  独立可选方法：演奏页不调用，缺省行为不变。
   *  [2026-09-04 fd 跟随修复] y 推导弃用 map 里的小节 y（OSMD 音乐单位坐标，
   *  随行深与 SVG 真实 y 偏差 ~21px/行线性发散，长谱深行会滚过头——几何对账实证），
   *  改用 hitRows 行包络（top/bottom 为 svg 坐标，与视口无关）+ offY 换算：
   *  行真实 y = 行包络 + offY（svg 在容器内的偏移），滚到行中心 = 视口中部。 */
  scrollToMeasure(m: number): void {
    const geom = this.ensureMarkerGeom()
    if (!geom) return
    // 由小节号找行：map 小节 y 与 hitRows top/bottom 同在 OSMD 坐标系（同源
    // MeasureList，实测小节 y 恰等于所在行 top），纵向包含判定在本坐标系内
    // 自洽（行间不重叠，±24 容差防边界），换算真实 y 时才 +offY
    const g = geom.map.get(m)
    if (!g) return
    const rowHits = geom.hitRows.filter((r) => g.y >= r.top - 24 && g.y <= r.bottom + 24)
    const hr = rowHits[0] ?? geom.hitRows.find((r) => r.bottom >= g.y) ?? geom.hitRows.at(-1)
    if (!hr) return
    // 行真实中心：该行音符头 DOM 实测 y 的均值（hitEntryFor 采自
    // getBoundingClientRect−svgRect，svg 坐标真值）。map/hitRows 的 OSMD 单位
    // 坐标随行深与真实 y 偏差 ~21px/行（几何对账实证），只能用于行归属判定，
    // 绝对滚动位置必须用 DOM 实测值——均值≈旋律行中心（单谱表乐器即 staff 中线）
    const ysAll: number[] = []
    for (const e of hr.entries) ysAll.push(...e.ys)
    const rowRealCenter =
      (ysAll.length ? ysAll.reduce((a, b) => a + b, 0) / ysAll.length : (hr.top + hr.bottom) / 2) +
      geom.offY
    // 向上找 overflowY auto/scroll 的滚动祖先（sync-tune 页为 .st-score）。
    // 从容器自身找起：演奏页的滚动容器就是 .sheet-container 本身（容器即 scroller），
    // 从 parentElement 起步会漏掉它导致 scrollToMeasure 空转
    let sc: HTMLElement | null = this.containerEl
    while (sc && sc !== document.body) {
      const oy = getComputedStyle(sc).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      sc = sc.parentElement
    }
    if (!sc) return
    // 行中心换算到滚动祖先坐标。两种拓扑（2026-09-04 fd 跟随修复实证）：
    // - 容器即 scroller（演奏页 .sheet-container）：cRect/sRect 同元素恒等，
    //   行的内容 y = offY + rowCenter（offY 为构建时 svg 相对容器的内容偏移，
    //   与滚动无关）——旧式 cRect.top−sRect.top+sc.scrollTop 在此退化成
    //   「现值+增量」的累加制，每次小节变化叠加滚过头；
    // - 容器在 scroller 内（sync-tune .st-score>div）：容器视口位置随滚动
    //   下移，cRect.top−sRect.top+sc.scrollTop 恰好抵消滚动得内容偏移。
    const cRect = this.containerEl.getBoundingClientRect()
    const sRect = sc.getBoundingClientRect()
    const base = sc === this.containerEl ? 0 : cRect.top - sRect.top + sc.scrollTop
    // [t_1d124051] rowRealCenter 为未缩放虚拟坐标（fit 模式谱面经 transform
    // 缩放，滚动容器的坐标是视觉/布局值）——× viewScale 折算后写入 scrollTop
    const target = Math.max(0, base + rowRealCenter * this.viewScale - sc.clientHeight / 2)
    this.animateScrollTo(sc, target)
  }

  /** [t_7518c69e] 换行跟随缓动滑移：ease-out cubic 约 500ms、rAF 驱动——替代
   *  scrollTop 直写的瞬时跳变（用户实测反馈「换行的时候滚动对演奏者很不友好」）。
   *  - 动画进行中被新调用打断：从当前位置重起步滚向新目标（平滑接管，不从旧
   *    起点重算——上一行还没滚完就换行的连续翻谱不断档）
   *  - 用户 wheel/pointerdown 立即取消并停在原地：页面侧「手动滚谱 5s 让位」
   *    （manualUntilRef）的前置防线——不取消的话让位期内动画仍会继续抢滚动；
   *    程序性 scrollTop 写入不派发这两个事件，不会自我触发
   *  - prefers-reduced-motion: reduce 时跳过动画直达目标
   *  - 时间轴只用 rAF 时间戳（首帧立 t0），测试桩时钟可直接驱动 */
  private animateScrollTo(sc: HTMLElement, target: number): void {
    this.stopScrollAnim()
    const delta = target - sc.scrollTop
    if (prefersReducedMotion() || Math.abs(delta) < 1) {
      sc.scrollTop = target
      return
    }
    const stop = () => this.stopScrollAnim()
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('pointerdown', stop, { passive: true })
    this.detachScrollGuard = () => {
      window.removeEventListener('wheel', stop)
      window.removeEventListener('pointerdown', stop)
    }
    const from = sc.scrollTop
    let t0 = -1
    const step = (now: number) => {
      try {
        if (t0 < 0) t0 = now
        const k = Math.max(0, Math.min(1, (now - t0) / SCROLL_ANIM_MS))
        sc.scrollTop = from + delta * easeOutCubic(k)
        if (k < 1) this.scrollRaf = requestAnimationFrame(step)
        else this.stopScrollAnim()
      } catch {
        // rAF 内异常会静默炸死主循环（65dcbef 渲染防崩前科）：止损停动画不上抛
        this.stopScrollAnim()
      }
    }
    this.scrollRaf = requestAnimationFrame(step)
  }

  /** 停止进行中的换行滑移动画（新动画起步/用户接管/到位/dispose 共用出口） */
  private stopScrollAnim(): void {
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf)
    this.scrollRaf = 0
    this.detachScrollGuard?.()
    this.detachScrollGuard = null
  }

  /** 小节几何缓存（t_perf_sync_tune，T3 起与 scrollToMeasure 共用）：
   *  MeasureList -> 小节号到行内几何/staffEntry 表，渲染后首算，谱面不变复用。
   *  容器可能带内边距：svg 相对容器的偏移叠进标记坐标。
   *  T3b 起同帧构建 hitRows（noteAtPoint 命中测试行表）：行几何 + 每个
   *  staffEntry 的音符头「绘制 x」（DOM SVG 元素 rect 主路径、GraphicalNote
   *  PositionAndShape 几何回退、staffEntry 锚点兜底），谱面不变一并复用。
   *  T3c 修正：MeasureList 实为 [小节][staff]（非 [系统行][小节]）——外层逐小节，
   *  系统行按纵向包络归并（相邻小节重叠 > 较小者半高即同行）；此前每小节各成
   *  一行且同系统行小节包络重合，noteAtPoint 行判定平局时行首小节恒胜，
   *  即「每行只有第一小节音符能选中」bug。 */
  private ensureMarkerGeom(): MarkerGeom | null {
    if (this.markerGeom) return this.markerGeom
    const svg = this.containerEl.querySelector('svg')
    const ml = this.osmd.GraphicSheet?.MeasureList
    if (!svg || !ml) return null
    const cRect = this.containerEl.getBoundingClientRect()
    const svgRect = svg.getBoundingClientRect()
    const unitPx = 10 * (this.osmd.Zoom || 1)
    const map = new Map<
      number,
      { x: number; y: number; w: number; h: number; se: { rv: number; x: number }[] }
    >()
    const hitRows: HitRow[] = []
    // [T3c] 光标跨度查表：小节号 -> 起始 quarters（终点标记除外），配合
    // staffEntry 锚点得到全谱 {全局 rv, 行内绝对 x} 表
    const qByM = new Map<number, number>()
    for (const e of this.measureTimes) {
      if (!e.end && !qByM.has(e.measure)) qByM.set(e.measure, e.quarters)
    }
    const cursorStops: { rv: number; x: number }[] = []
    let row: HitRow | null = null
    for (const measureStaves of ml) {
      if (!measureStaves?.length) continue
      let mTop = Infinity
      let mBottom = -Infinity
      const entries: HitEntry[] = []
      let hasEntry = false
      for (const m of measureStaves) {
        // 空槽位防御：真实曲谱（如 expedition-33）的 MeasureList 末尾可能含
        // undefined 小节（OSMD 内部多项小节 bug），直接访问其 PositionAndShape
        // 会抛 TypeError 并被上层误报为「曲谱渲染失败」。跳过空槽。
        if (!m?.PositionAndShape?.AbsolutePosition || !m?.staffEntries) continue
        const ps = m.PositionAndShape
        mTop = Math.min(mTop, ps.AbsolutePosition.y * unitPx)
        mBottom = Math.max(mBottom, (ps.AbsolutePosition.y + ps.Size.height) * unitPx)
        if (!map.has(m.MeasureNumber)) {
          map.set(m.MeasureNumber, {
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
        // 命中表不去重：多 staff（钢琴上下谱表）的 staffEntries 各自入表
        const q0 = qByM.get(m.MeasureNumber)
        for (const se of m.staffEntries) {
          const entry = this.hitEntryFor(se, m.MeasureNumber, unitPx, svgRect)
          if (entry) {
            entries.push(entry)
            hasEntry = true
          }
          if (q0 !== undefined) {
            const rv = se.sourceStaffEntry?.Timestamp?.RealValue
            if (rv !== undefined) cursorStops.push({ rv: q0 / 4 + rv, x: se.PositionAndShape.AbsolutePosition.x })
          }
        }
      }
      if (!hasEntry) continue
      // 行归并：与当前行的纵向包络重叠超过较小者半高 -> 同一系统行并入
      const inter = row ? Math.min(mBottom, row.bottom) - Math.max(mTop, row.top) : -1
      const minH = Math.min(mBottom - mTop, row ? row.bottom - row.top : Infinity)
      if (row && inter > minH / 2) {
        row.top = Math.min(row.top, mTop)
        row.bottom = Math.max(row.bottom, mBottom)
        row.entries.push(...entries)
      } else {
        row = { top: mTop, bottom: mBottom, entries }
        hitRows.push(row)
      }
    }
    cursorStops.sort((a, b) => a.rv - b.rv || a.x - b.x)
    const stopsDedup: { rv: number; x: number }[] = []
    for (const s of cursorStops) {
      if (!stopsDedup.length || stopsDedup.at(-1)!.rv !== s.rv) stopsDedup.push(s)
    }
    this.markerGeom = {
      map,
      // [t_1d124051] 视觉偏移 ÷ viewScale 归一成未缩放坐标（标记层/滚动换算共用）
      offX: (svgRect.left - cRect.left) / this.viewScale,
      offY: (svgRect.top - cRect.top) / this.viewScale,
      unitPx,
      hitRows,
      cursorStops: stopsDedup,
    }
    return this.markerGeom
  }

  /** [T3b] staffEntry -> 命中表项：x 对齐音符头「绘制位置」而非 staffEntry 时间锚点
   *  （升/降号、宽音符头、密集十六分时两者横向差可达半音符头以上，锚点最近邻
   *  会选错邻）。DOM 主路径用 notehead/修饰符 SVG 元素 getBoundingClientRect——
   *  与 svg 同帧两次测量相减，滚动/页面缩放自然抵消，得到的即真实绘制包络
   *  （有 accidental 时取 accidental+notehead 包络中心）；SVG 元素不可用时回退
   *  GraphicalNote 的 PositionAndShape 包络（乘 unitPx）；再不行退锚点旧口径
   *  （T3c 修正：锚点 x 是行内绝对坐标，与小节同空间，不再叠加小节 x）。
   *  纯休止 entry 不入命中表（不可选中）。 */
  private hitEntryFor(
    se: {
      graphicalVoiceEntries?: { notes?: unknown[] }[]
      sourceStaffEntry?: { Timestamp?: { RealValue?: number } }
      PositionAndShape?: { AbsolutePosition?: { x: number } }
    },
    measure: number,
    unitPx: number,
    svgRect: { left: number; top: number },
  ): HitEntry | null {
    const gnotes = (se.graphicalVoiceEntries ?? [])
      .flatMap((v) => v.notes ?? [])
      .filter((n) => !(n as { sourceNote?: { isRest?: () => boolean } }).sourceNote?.isRest?.()) as HitDomNote[]
    if (!gnotes.length) return null
    const rv = se.sourceStaffEntry?.Timestamp?.RealValue ?? 0
    const boxes = gnotes.map((gn) => {
      const headRects = (gn.getNoteheadSVGs?.() ?? [])
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r && (r.width > 0 || r.height > 0))
      if (headRects.length) {
        const modRects = (gn.getModifierSVGs?.() ?? [])
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r && (r.width > 0 || r.height > 0))
        // [t_1d124051] DOM 实测为视觉坐标（= 未缩放 × viewScale），÷k 归一存储
        return {
          left:
            (Math.min(...headRects.map((r) => r.left), ...modRects.map((r) => r.left)) - svgRect.left) /
            this.viewScale,
          right:
            (Math.max(...headRects.map((r) => r.right), ...modRects.map((r) => r.right)) - svgRect.left) /
            this.viewScale,
          ys: headRects.map((r) => (r.top + r.height / 2 - svgRect.top) / this.viewScale),
          hw: Math.max(...headRects.map((r) => r.width / 2)) / this.viewScale,
        }
      }
      // 几何回退：GraphicalNote 包络（OSMD bbox 含 accidental 时同样并入）
      const bb = gn.PositionAndShape
      if (bb && bb.Size.width > 0) {
        return {
          left: bb.AbsolutePosition.x * unitPx,
          right: (bb.AbsolutePosition.x + bb.Size.width) * unitPx,
          ys: [(bb.AbsolutePosition.y + bb.Size.height / 2) * unitPx],
          hw: (bb.Size.width * unitPx) / 2,
        }
      }
      return null
    })
    const ok = boxes.filter((b): b is NonNullable<typeof b> => b !== null)
    if (!ok.length) {
      // 兜底：DOM 与几何都不可用 -> staffEntry 锚点（行内绝对坐标，T3c 修正：
      // 与小节 AbsolutePosition 同空间，不叠加小节 x——旧口径双重计数会选错邻）
      const ax = se.PositionAndShape?.AbsolutePosition?.x
      return { m: measure, rv, x: (ax ?? 0) * unitPx, ys: [], hw: 0 }
    }
    return {
      m: measure,
      rv,
      x: (Math.min(...ok.map((b) => b.left)) + Math.max(...ok.map((b) => b.right))) / 2,
      ys: ok.flatMap((b) => b.ys),
      hw: Math.max(...ok.map((b) => b.hw)),
    }
  }

  /**
   * [sync-tune 调试页扩展] 控制点标记层：谱面上叠加定位刻度（如 beats 微调页的
   * 控制点/选中音标记）。空数组清除整层；OSMD 未渲染时忽略。纯 overlay，
   * 不触碰谱面图形树，缺省（不调用）行为不变。
   * 性能（t_perf_sync_tune）：小节几何渲染后缓存一次；标记 DOM 走元素池
   * （q→元素复用，仅更新 style/title），601 标记从「全删全建」降为「差异更新」。
   */
  setMarkers(markers: { measure: number; rvInMeasure: number; color: string; title?: string }[]): void {
    if (!markers.length) {
      this.markerLayer?.remove()
      this.markerEls.clear()
      return
    }
    const svg = this.containerEl.querySelector('svg')
    if (!svg) return
    let layer = this.markerLayer
    if (!layer || layer.parentElement !== this.containerEl) {
      layer =
        this.containerEl.querySelector<HTMLElement>('.sync-marker-layer') ??
        document.createElement('div')
      layer.className = 'sync-marker-layer'
      if (layer.parentElement !== this.containerEl) this.containerEl.appendChild(layer)
      this.markerLayer = layer
    }
    const geom = this.ensureMarkerGeom()
    if (!geom) return
    // rv→x：夹取到 staffEntry 时间戳范围后按相邻项线性插值（符距与音值近似成正比）；
    // 无 staffEntry 数据时回退小节宽度比例（fx 与 g.x 同为 OSMD 单位）
    const rvToX = (g: { se: { rv: number; x: number }[] }, rvInMeasure: number): number => {
      const last = g.se.at(-1)
      const rel = Math.max(0, Math.min(last?.rv ?? 1, rvInMeasure))
      if (!last) return 0
      if (rel >= last.rv) return last.x
      const i = g.se.findIndex((p) => p.rv > rel)
      if (i <= 0) return g.se[0].x
      const a = g.se[i - 1]
      const b = g.se[i]
      return a.x + ((b.x - a.x) * (rel - a.rv)) / Math.max(b.rv - a.rv, 1e-9)
    }
    // 元素池差异更新：key = `m<measure>@rv<rvInMeasure>`（微调不改标记位置，稳定）
    const used = new Set<string>()
    for (const mk of markers) {
      const g = geom.map.get(mk.measure)
      if (!g) continue
      const key = `m${mk.measure}@rv${mk.rvInMeasure}`
      used.add(key)
      let el = this.markerEls.get(key)
      if (!el) {
        el = document.createElement('div')
        el.className = 'sync-marker'
        this.markerEls.set(key, el)
        layer.appendChild(el)
      }
      const fx = rvToX(g, mk.rvInMeasure)
      // fx 已是行内绝对坐标（se x 与小节同空间，T3c 诊断实测），不再叠加小节 x
      el.style.left = `${geom.offX + fx * geom.unitPx}px`
      el.style.top = `${geom.offY + g.y}px`
      el.style.height = `${g.h}px`
      el.style.borderColor = mk.color
      if (mk.title) el.title = mk.title
      else el.removeAttribute('title')
    }
    // 池中已不在本次集合的元素 → 摘除并回收
    for (const [key, el] of this.markerEls) {
      if (!used.has(key)) {
        el.remove()
        this.markerEls.delete(key)
      }
    }
  }

  /** [T4] 标记层局部更新：微调/选中变化只改受影响 marker 的 borderColor/title，
   *  不触碰其它 marker 的定位样式（left/top/height 由 setMarkers 全量路径管理，
   *  元素池 key 同源 `m<measure>@rv<rvInMeasure>`）。key 未命中（谱面未渲染/
   *  键集未就位）返回 false，由调用方的全量路径兜底。独立可选方法：演奏页
   *  不调用，缺省行为不变。 */
  patchMarker(
    measure: number,
    rvInMeasure: number,
    patch: { color?: string; title?: string },
  ): boolean {
    const el = this.markerEls.get(`m${measure}@rv${rvInMeasure}`)
    if (!el) return false
    if (patch.color !== undefined) el.style.borderColor = patch.color
    if (patch.title !== undefined) el.title = patch.title
    return true
  }

  dispose(): void {
    this.disposed = true
    // OSMD 无 dispose API；清空容器释放 DOM
    this.stopScrollAnim()
    this.markerGeom = null
    this.markerEls.clear()
    this.markerLayer = null
    this.highlighted = null
    this.selNote = null
    this.containerEl.innerHTML = ''
  }
}

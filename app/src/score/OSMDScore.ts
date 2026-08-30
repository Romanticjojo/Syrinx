import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { Timeline } from '../types'

/**
 * OSMD 曲谱渲染封装：
 * - 暗色谱面（白色音符、透明背景，融入暗色界面）
 * - 主题色光标（每曲 accent）
 * - syncToTime(t)：由伴奏音频时钟每帧驱动，光标推进到时间 t
 * - followCursor 自动滚动；小节变化通过 onMeasureChange 回调（不进响应式 store）
 */
export class OSMDScore {
  private osmd: OpenSheetMusicDisplay
  private containerEl: HTMLElement
  private secPerQuarter = 0.5
  private measureTimes: { measure: number; time: number }[] = []
  private lastMeasure = 0
  private totalMeasures = 0
  /** 小节变化回调（rAF 中触发，直接操作 DOM，勿 setState） */
  onMeasureChange?: (measure: number, total: number) => void

  constructor(container: HTMLElement, accent = '#3ddfae') {
    this.containerEl = container
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
      defaultColorMusic: '#f2f2ee',
      defaultColorNotehead: '#fdfdf8',
      defaultColorRest: '#9a9a90',
      defaultColorLabel: '#b3b3b3',
      cursorsOptions: [
        { type: 1, color: accent, follow: true, alpha: 0.9 }, // ThinLeft 细竖线
      ],
    })
    this.osmd.FollowCursor = true
  }

  async load(xml: string, timeline: Timeline): Promise<void> {
    await this.osmd.load(xml)
    this.osmd.render()
    this.secPerQuarter = timeline.secPerQuarter
    this.measureTimes = timeline.measureTimes
    this.totalMeasures = timeline.measureTimes.length
    this.lastMeasure = 0
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

  /** 每帧调用：把光标推进到曲目时间 t（秒）。由 rAF 驱动，只前进不后退 */
  syncToTime(t: number): void {
    const cursor = this.osmd.cursor
    const it = cursor.iterator
    // currentTimeStamp.RealValue 单位 = 四分音符数
    let guard = 0
    while (!it.EndReached && it.currentTimeStamp.RealValue * this.secPerQuarter <= t && guard < 512) {
      cursor.next()
      guard++
    }
    // 当前小节：由 measureTimes 反查（iterator.currentMeasure 是私有成员）
    let m = 1
    for (let i = 0; i < this.measureTimes.length; i++) {
      if (this.measureTimes[i].time <= t) m = this.measureTimes[i].measure
      else break
    }
    if (m !== this.lastMeasure) {
      this.lastMeasure = m
      this.onMeasureChange?.(m, this.totalMeasures)
    }
  }

  setZoom(scale: number): void {
    this.osmd.Zoom = scale
    this.osmd.render()
    // 重渲染后光标元素需重新出现
    if (!this.osmd.cursor.Hidden) {
      this.osmd.cursor.show()
      this.osmd.cursor.update()
    }
  }

  get zoom(): number {
    return this.osmd.Zoom
  }

  dispose(): void {
    // OSMD 无 dispose API；清空容器释放 DOM
    this.containerEl.innerHTML = ''
  }
}

import { useEffect, useRef, useState, type RefObject } from 'react'
import { OSMDScore } from '../score/OSMDScore'
import type { Timeline } from '../types'
import './ScoreSheet.css'

/** [t_1d124051] fit 模式固定虚拟渲染宽：与页面 CSS .sheet-container 的
 *  min(1280px, 100%) 上限同值（PerformPage/PreviewPage）——OSMD 按 1280px
 *  布局，谱面与桌面 1280px 完全同版（每行小节数/换行位置不变），外层
 *  transform: scale(k) 等比缩放到实际可用宽 */
const VIRTUAL_WIDTH = 1280
/** [t_1d124051] fit/reflow 模式阈值（视口宽，与 matchMedia (min-width: 640px) 同口径） */
const FIT_MIN_VIEWPORT = 640

interface Props {
  xml: string | null
  timeline: Timeline | null
  accent?: string
  /** 把封装实例抛给父组件（演奏页驱动光标用） */
  scoreRef?: RefObject<OSMDScore | null>
  /** 小节变化回调：随实例一起挂/摘（实例在本组件内创建，挂接放这里才不会
      错过 StrictMode remount 换出的新实例——演奏页侧挂会扑空，t_b22f5467 项 3） */
  onMeasureChange?: (measure: number, total: number) => void
  /** 谱面缩放（配合容器限宽调整每行小节数，默认 1） */
  zoom?: number
  /** OSMD 原生跟随滚动开关（默认 true 原行为）。false = 滚动权移交调用方
      （演奏页行居中跟随+手动滚谱让位，见 OSMDScore.autoScroll 注释） */
  autoScroll?: boolean
  /** [t_1d124051] 装载完成即显示光标（演奏/倒数中跨 640px 阈值重挂载后恢复光标）：
   *  重挂载换出全新 OSMDScore 实例，cursorShown 状态随之丢失——传 true 让 load
   *  完成后自动 showCursor（光标回起点，下一帧 syncToTime 快进回当前伴奏小节），
   *  且不再上报 HUD 初始化回调（演奏中 HUD 由 rAF 主循环驱动） */
  autoShowCursor?: boolean
}

/** 谱面容器：挂载 OSMDScore，负责加载/重渲染生命周期。
 *  [t_1d124051] 小屏混合适配（两模式，matchMedia 驱动切换）：
 *  - fit（视口 ≥640px，平板横竖屏/桌面小窗）：OSMD 在 1280px 虚拟宽节点上渲染
 *    （autoResize 关闭——OSMD 的 window resize 监听不看容器宽是否变化，开着必然
 *    违背「旋转只改 scale 不重排」），外层 wrapper transform: scale(k) 等比缩放
 *    （k = 容器实际宽 / 1280）+ 高度补偿（transform 不改布局占位，滚动区高度要
 *    手动压到 H·k，否则底部整段空白）；旋转/缩窗只更新 k，谱面零重排
 *  - reflow（<640px 手机竖屏）：维持现状——容器自适应宽重排渲染，autoResize 保留
 *  - 跨 640px 阈值：整棵谱面子树按 mode 重建（宽 ↔ 虚拟宽切换必须重渲染），
 *    演奏中由 autoShowCursor + syncToTime 恢复光标 */
export default function ScoreSheet({
  xml,
  timeline,
  accent = '#3ddfae',
  scoreRef,
  onMeasureChange,
  zoom = 1,
  autoScroll = true,
  autoShowCursor = false,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OSMDScore | null>(null)
  const [error, setError] = useState<string | null>(null)
  // fit/reflow：matchMedia 只在跨 640px 时触发 change，同模式内 resize 不换档
  const [mode, setMode] = useState<'fit' | 'reflow'>(
    () =>
      typeof window !== 'undefined' && window.matchMedia(`(min-width: ${FIT_MIN_VIEWPORT}px)`).matches
        ? 'fit'
        : 'reflow',
  )
  // fit 缩放函数的落点（load 渲染完成后谱面高才可知，需补一次 apply）
  const applyScaleRef = useRef<() => void>(() => {})
  // autoShowCursor 走 ref 镜像：作为 prop 进 load effect 依赖会让 phase 每次变化
  // （ready→countdown→performing）都重载谱面——只取挂载/重挂载当下的值即可
  const autoShowRef = useRef(autoShowCursor)
  autoShowRef.current = autoShowCursor

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${FIT_MIN_VIEWPORT}px)`)
    const onChange = () => setMode(mq.matches ? 'fit' : 'reflow')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 创建实例（每曲一次；跨模式阈值重建一次——autoResize 开关随模式变化）
  useEffect(() => {
    if (!divRef.current) return
    const osmd = new OSMDScore(
      divRef.current,
      accent,
      undefined,
      zoom,
      undefined,
      undefined,
      autoScroll,
      // fit 固定虚拟宽下 OSMD window-resize 自动重渲必须关（见类头注释）；
      // reflow 保留现状 true
      mode !== 'fit',
    )
    osmdRef.current = osmd
    if (scoreRef) scoreRef.current = osmd
    if (onMeasureChange) osmd.onMeasureChange = onMeasureChange
    return () => {
      osmd.onMeasureChange = undefined
      osmd.dispose()
      osmdRef.current = null
      if (scoreRef) scoreRef.current = null
    }
    // accent 变化意味着换曲，需要重建
  }, [accent, scoreRef, onMeasureChange, zoom, autoScroll, mode])

  // 加载曲谱（mode 变化 → 新实例上重新 load）
  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd || !xml || !timeline) return
    setError(null)
    osmd
      .load(xml, timeline)
      .then(() => {
        if (osmdRef.current === osmd) {
          // fit 模式：渲染完成才知道虚拟谱面高，补一次缩放与高度补偿
          applyScaleRef.current()
          if (autoShowRef.current) {
            // 演奏/倒数中重挂载：恢复光标（下一帧 syncToTime 快进回当前小节）；
            // HUD 初始化回调跳过——演奏中由主循环驱动，避免先跳回第 1 小节再弹回
            osmd.showCursor()
          } else if (onMeasureChange) {
            // HUD 初始化：谱面一就绪即报第 1 小节（终点标记不是真实小节），不等起奏第一帧
            const total = timeline.measureTimes.filter((e) => !e.end).length
            onMeasureChange(1, total)
          }
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [xml, timeline, onMeasureChange, mode])

  // fit 缩放：k = 容器实际宽 / 虚拟宽，直写 style（不经 React 状态，resize 高频
  // 也不重渲组件）；高度补偿防滚动区底部空白。rAF 合并同一帧内的多次 resize
  useEffect(() => {
    if (mode !== 'fit') return
    const apply = () => {
      const scroller = scrollerRef.current
      const wrap = wrapRef.current
      const host = divRef.current
      if (!scroller || !wrap || !host) return
      const k = scroller.clientWidth / VIRTUAL_WIDTH
      // k=1（容器已达 1280 上限）不落 transform：省一个无谓的 stacking context；
      // k<=0（happy-dom 无布局/未挂载）跳过
      wrap.style.transform = k > 0 && k !== 1 ? `scale(${k})` : ''
      wrap.style.height = `${Math.ceil(host.offsetHeight * k)}px`
      osmdRef.current?.setViewScale(k)
    }
    applyScaleRef.current = apply
    let raf = 0
    const onResize = () => {
      // 帧回调里先复位 flag 再干活：否则句柄用后残留，后续 resize 全被挡掉
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply() })
    }
    apply()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
      applyScaleRef.current = () => {}
    }
  }, [mode])

  return (
    <div className="score-sheet">
      {error && <div className="sheet-error">曲谱渲染失败：{error}</div>}
      {/* key 分枝防「容器复用 + 命令式清空」互踩：跨模式切换时两分支外层同为
          .sheet-container（div），React 默认复用 DOM 节点——而 OSMDScore.dispose
          与 OSMD autoResize 的滞后 render 都会对旧实例容器 innerHTML='' 重建，
          把 React 刚提交进复用节点的新子树清成孤儿（390→800 实测：fit 树
          isConnected=false、谱面停留在僵尸 svg）。key 不同 → 切换即卸旧建新，
          命令式清空永远落在 detached 节点上 */}
      {mode === 'fit' ? (
        <div className="sheet-container" ref={scrollerRef} key="fit">
          <div className="sheet-scale" ref={wrapRef}>
            <div ref={divRef} className="sheet-virtual" />
          </div>
        </div>
      ) : (
        <div ref={divRef} className="sheet-container" key="reflow" />
      )}
    </div>
  )
}

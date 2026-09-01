import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { audioEngine } from '../audio/AudioEngine'
import { applyBeats, type BeatsFile } from '../score/anchors'
import { OSMDScore } from '../score/OSMDScore'
import { expandRepeats, parseMusicXml } from '../score/musicxml'
import { assetUrl } from '../lib/assetUrl'
import { getSong, SONGS } from '../songs'
import {
  buildBeatsExport,
  buildSyncNotes,
  deltaMsAt,
  fmtTime,
  makeQ2T,
  midiName,
  type CtrlPoint,
  type SyncNote,
} from '../synctune/logic'
import { selectedNoteView, tunedCount, useSyncTuneStore, visibleNotes } from '../synctune/store'
import './SyncTunePage.css'

/**
 * 同步调试页（/sync-tune/:songId，独立于曲库导航）：
 * 三栏（音符列表 / OSMD 谱面 / 属性面板）+ 底部伴奏波形总览。
 * 微调 beats.json 的 beatAnchors 控制点使光标节奏与伴奏逐音对齐；
 * diff 只在本页内存中，导出 JSON 由用户覆盖 beats.json 后才影响演奏页。
 * 时间唯一来源 audioEngine（不新起时钟）；q↔t 换算走局部段速率（logic.ts）。
 * R2（T2）：顶栏播放控制条（⏮⏯⏭ + 进度条 + 时间/小节）、波形图例/可折叠、
 * 右栏「? 操作说明」面板；进度/时间走 rAF 帧直写 DOM，不进每帧 React 渲染。
 * R2（T3）：三向选中（谱面/列表/波形）谱面 notehead 染 accent（OSMDScore
 * .highlightNoteAt，单音符 setColor）；播放/选中变化自动滚动聚焦当前小节
 * （scrollToMeasure），谱面手动 wheel/pointerdown 后 5 秒内不抢滚动；
 * 谱面点击命中距离 >120px 时右栏提示「已选最近音符」。
 * R2（T3d）：列表全量展示（去小节 ±2 窗口）+ 行元数据 memo 查表；帮助按钮
 * 「? 操作说明」文字恢复（绿色 ？ 保留）。
 */

type Phase = 'loading' | 'ready' | 'error'

/** 波形峰值预计算步长（样本数）：~11.6ms/桶（44.1k），总览分辨率足够 */
const PEAK_STEP = 512

export default function SyncTunePage({ songId }: { songId: string }) {
  const song = getSong(songId) ?? SONGS[0]
  const [phase, setPhase] = useState<Phase>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [xml, setXml] = useState<string | null>(null)
  const [markersReady, setMarkersReady] = useState(false)
  // 命中距离提示（T3 决策 4）：点谱面 120px 内无音符仍选最近时在右栏提示（5s 自动消隐）
  const [nearHint, setNearHint] = useState<string | null>(null)
  const nearHintTimerRef = useRef(0)
  // 音频状态徽标（T1）：仅事件驱动更新（启用/播放尝试后 set），不进 rAF 帧路径
  const [audioState, setAudioState] = useState<AudioContextState>(() => audioEngine.state)
  const audioBadgeRef = useRef<HTMLButtonElement>(null)
  // 波形按需重绘（t_perf_sync_tune）：store 变化/视口变化置脏，rAF 循环只在
  // 播放中或脏时重绘（旧实现无条件 60fps 全量重绘，空闲时也吃满一核）；
  // q2t 闭包/刻度表/选中 q 由 store 订阅预构建缓存，绘制帧只读 refs；
  // 页脚刻度文本由 drawWave 直写 DOM（拖拽/缩放不再触发 React 重渲染）
  const waveDirtyRef = useRef(true)
  const q2tWorkRef = useRef<((q: number) => { t: number }) | null>(null)
  const q2tBaseRef = useRef<((q: number) => { t: number }) | null>(null)
  const ticksRef = useRef<{ t: number; q: number; tuned: boolean }[]>([])
  const notesRef = useRef<SyncNote[]>([])
  const selQRef = useRef<number | null>(null)
  const waveHintRef = useRef<HTMLSpanElement>(null)
  /** rAF 唤醒器：主循环空闲（未播放）时置脏后必须 kick 一次才会重绘 */
  const waveKickRef = useRef<() => void>(() => {})
  // 播放控制条（T2）：进度/时间/小节号由 rAF 帧直写 DOM（ref），不进每帧 React 渲染；
  // ⏯ 图标仅在播放态翻转时 setState；拖拽进度条期间暂停 rAF 直写，松手才 seek
  const [playingUi, setPlayingUi] = useState(false)
  const playingUiRef = useRef(false)
  const fillRef = useRef<HTMLDivElement>(null)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const measureLabelRef = useRef<HTMLSpanElement>(null)
  const scrubbingRef = useRef(false)
  /** 小节起始时间表（基线网格 t）：⏮/⏭ 换算与小节号显示共用，随 baseline 重建 */
  const measureStartsRef = useRef<{ m: number; t: number }[]>([])
  // 波形面板折叠（T2）：localStorage 记忆；图例常驻折叠条
  const [waveCollapsed, setWaveCollapsed] = useState(() => {
    try {
      return localStorage.getItem('st-wave-collapsed') === '1'
    } catch {
      return false
    }
  })

  // store 快照（渲染用）；rAF/事件回调里一律 getState() 取最新
  const working = useSyncTuneStore((s) => s.working)
  const baseline = useSyncTuneStore((s) => s.baseline)
  const selectedIdx = useSyncTuneStore((s) => s.selectedIdx)
  const filter = useSyncTuneStore((s) => s.filter)
  const undoStack = useSyncTuneStore((s) => s.undoStack)
  const dirty = useSyncTuneStore((s) => s.dirty)
  const tuned = useSyncTuneStore((s) => tunedCount(s))
  const selView = useSyncTuneStore(useShallow(selectedNoteView))

  const scoreRef = useRef<OSMDScore | null>(null)
  const scoreDivRef = useRef<HTMLDivElement>(null)
  // 谱面滚动容器（.st-score，overflow:auto）：T3 让位时间戳监听挂这里
  const scoreSectionRef = useRef<HTMLElement>(null)
  /** 谱面手动滚动时间戳（T3 决策 6）：wheel/pointerdown 后 5 秒内暂停自动跟随 */
  const lastUserScrollRef = useRef(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const beatsRef = useRef<BeatsFile | null>(null)
  const peaksRef = useRef<Float32Array | null>(null)
  const stepSecRef = useRef(0)
  const durationRef = useRef(0)
  const displayTlRef = useRef<ReturnType<typeof parseMusicXml> | null>(null)
  /** [T3c] 恒速解析谱（parseMusicXml 结果，q 换算基准）：保存修改时以原 beats
   *  的 anchors/bpm + 新 working 重建显示时间轴（applyBeats），供 setTimeline 热切换 */
  const baseTlRef = useRef<ReturnType<typeof parseMusicXml> | null>(null)
  const measureTableRef = useRef<{ m: number; quarters: number }[]>([])
  const viewRef = useRef({ t0: 0, t1: 1 })

  const st = useSyncTuneStore

  /** 徽标闪动（播放被自动播放策略挡下时）：直接操作 DOM 重启动画，避免定时 setState */
  const flashAudioBadge = useCallback(() => {
    const el = audioBadgeRef.current
    if (!el) return
    el.classList.remove('st-audio-flash')
    void el.offsetWidth // 强制回流，重启动画
    el.classList.add('st-audio-flash')
  }, [])

  /** 用户手势内解锁音频：resume 后刷新徽标（仍失败则闪动提示） */
  const enableAudio = useCallback(async () => {
    try {
      await audioEngine.resume()
    } catch {
      // resume 抛错保持 suspended，徽标仍提示
    }
    setAudioState(audioEngine.state)
    if (audioEngine.state !== 'running') flashAudioBadge()
  }, [flashAudioBadge])

  /** q → 所在播放序小节（quarters ≤ q 的最后一个非终点小节） */
  const measureForQ = useCallback(
    (q: number): { m: number; quarters: number } => {
      const mt = measureTableRef.current
      let best = mt[0] ?? { m: 1, quarters: 0 }
      for (const e of mt) {
        if (e.quarters <= q) best = e
        else break
      }
      return best
    },
    [],
  )

  /** 小节自动聚焦（T3 决策 6）：滚动到第 m 小节所在行；谱面手动 wheel/拖动后
   *  5 秒内让位不抢滚动（点击音符的 pointerdown 也会记时间戳——点哪儿哪儿就
   *  在视口里，本就无需跟随）。稳定回调，rAF/回调路径可直接引用 */
  const followMeasure = useCallback((m: number) => {
    if (Date.now() - lastUserScrollRef.current < 5000) return
    scoreRef.current?.scrollToMeasure(m)
  }, [])

  // —— 装配：曲谱解析（恒速系，q 换算基准）+ beats.json + 伴奏解码 ——
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(assetUrl(song.scoreUrl))
        if (!res.ok) throw new Error(`曲谱加载失败：HTTP ${res.status}`)
        const xmlExp = expandRepeats(await res.text())
        const pre = parseMusicXml(xmlExp)
        if (!song.beatsUrl) throw new Error('该曲目没有 beatsUrl，无需同步微调')
        const bres = await fetch(assetUrl(song.beatsUrl))
        if (!bres.ok) throw new Error(`beats.json 加载失败：HTTP ${bres.status}`)
        const beats = (await bres.json()) as BeatsFile
        const ba = beats.beatAnchors
        if (!Array.isArray(ba) || ba.length < 2)
          throw new Error('beats.json 无有效 beatAnchors（需 ≥2 个控制点）')
        if (!alive) return
        measureTableRef.current = pre.measureTimes
          .filter((e) => !e.end)
          .map((e) => ({ m: e.measure, quarters: e.quarters }))
        beatsRef.current = beats
        st.getState().load(song.id, buildSyncNotes(pre), ba.map((p) => ({ ...p })))
        // 小节起始时间表（订阅前兜底）：⏮/⏭ 与小节号显示用
        const q2tB0 = makeQ2T(st.getState().baseline)
        measureStartsRef.current = measureTableRef.current.map((e) => ({
          m: e.m,
          t: q2tB0(e.quarters).t,
        }))
        setXml(xmlExp)
        // 恒速解析谱存 ref（保存修改时重建显示时间轴用，T3c）
        baseTlRef.current = pre
        // 演奏显示时间轴：基线锚点应用后的时间轴（光标语义同演奏页）
        displayTlRef.current = applyBeats(pre, beats)
        // 伴奏解码 → 峰值包络
        if (song.accompanimentUrl) {
          try {
            const ab = await fetch(assetUrl(song.accompanimentUrl))
            if (!ab.ok) throw new Error(`HTTP ${ab.status}`)
            const buf = await audioEngine.decode(await ab.arrayBuffer())
            // 装载为 play() 数据源：decode 只解码不装载，缺这行冷启动 play() 恒 false
            await audioEngine.load(buf)
            const ch = buf.getChannelData(0)
            const n = Math.ceil(ch.length / PEAK_STEP)
            const peaks = new Float32Array(n * 2)
            for (let i = 0; i < n; i++) {
              let mn = 1
              let mx = -1
              const end = Math.min(ch.length, (i + 1) * PEAK_STEP)
              for (let j = i * PEAK_STEP; j < end; j++) {
                const v = ch[j]
                if (v < mn) mn = v
                if (v > mx) mx = v
              }
              peaks[i * 2] = mn
              peaks[i * 2 + 1] = mx
            }
            peaksRef.current = peaks
            stepSecRef.current = PEAK_STEP / buf.sampleRate
            durationRef.current = buf.duration
            viewRef.current = { t0: 0, t1: buf.duration }
          } catch (e: unknown) {
            console.warn(
              `[sync-tune] 伴奏解码失败（波形不可用）：${e instanceof Error ? e.message : e}`,
            )
          }
        }
        if (!alive) return
        setPhase('ready')
      } catch (e: unknown) {
        if (alive) {
          setErrorMsg(e instanceof Error ? e.message : String(e))
          setPhase('error')
        }
      }
    })()
    return () => {
      alive = false
      window.clearTimeout(nearHintTimerRef.current)
      audioEngine.pause()
    }
    // song 由路由参数派生，进入本页装配一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // —— 谱面：ready 后挂载（容器已渲染），StrictMode 重挂载由 disposed 标志兜底 ——
  useEffect(() => {
    if (phase !== 'ready' || !xml) return
    const div = scoreDivRef.current
    const tl = displayTlRef.current
    if (!div || !tl) return
    // 橙色选中（T3b）：与播放光标 accent 分离，「我点的」一眼可辨；
    // 光标跨时值高亮（T3c）：光标宽度覆盖正在响的音的完整时值
    const osmd = new OSMDScore(div, song.accent, undefined, undefined, '#ff9f43', true)
    scoreRef.current = osmd
    // 小节号显示 + 播放中自动聚焦当前小节（T3 决策 6：rAF 回调路径，不 setState）
    osmd.onMeasureChange = (m) => {
      if (audioEngine.playing) followMeasure(m)
    }
    let cancelled = false
    osmd
      .load(xml, tl)
      .then(() => {
        if (cancelled) return
        osmd.showCursor()
        setMarkersReady(true) // 触发标记层首绘
      })
      .catch((e: unknown) => {
        console.warn(`[sync-tune] 谱面渲染失败：${e instanceof Error ? e.message : e}`)
      })
    return () => {
      cancelled = true
      osmd.onMeasureChange = undefined
      osmd.dispose()
      if (scoreRef.current === osmd) scoreRef.current = null
    }
    // accent/xml 随曲目变化时重建（followMeasure 为稳定回调）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, xml, song.accent, followMeasure])

  // —— 谱面手动滚动让位（T3 决策 6）：滚动容器上的 wheel/pointerdown 记时间戳，
  //  followMeasure 5 秒内据此跳过自动跟随，避免抢用户的滚动条 ——
  useEffect(() => {
    if (phase !== 'ready') return
    const el = scoreSectionRef.current
    if (!el) return
    const mark = () => {
      lastUserScrollRef.current = Date.now()
    }
    el.addEventListener('wheel', mark, { passive: true })
    el.addEventListener('pointerdown', mark)
    return () => {
      el.removeEventListener('wheel', mark)
      el.removeEventListener('pointerdown', mark)
    }
  }, [phase])

  // —— 控制点标记层：working/选中变化即重画（q 是谱面空间位置，微调 t 不动标记） ——
  useEffect(() => {
    const score = scoreRef.current
    if (!score || !markersReady) return
    const selQ = selView.note?.q
    const q2tBase = makeQ2T(baseline)
    const markers = working.map((p) => {
      const m = measureForQ(p.q)
      const isSel = selQ !== undefined && p.q === selQ
      const tunedHere = Math.abs(p.t - q2tBase(p.q).t) > 1e-6
      return {
        measure: m.m,
        rvInMeasure: (p.q - m.quarters) / 4,
        color: isSel ? song.accent : tunedHere ? '#ff9f43' : 'rgba(255,255,255,0.28)',
        title: `q=${p.q} t=${p.t.toFixed(3)}${tunedHere ? '（已调）' : ''}`,
      }
    })
    score.setMarkers(markers)
  }, [working, baseline, selView.note, markersReady, measureForQ, song.accent])

  // —— 三向选中染色 + 小节聚焦（T3 决策 3/6）：谱面点击/列表/波形三入口都走
  //  store 选中，此单一 effect 收口——选中变化 -> notehead 染 accent + 聚焦
  //  所在小节；单音符 setColor，不重建标记层，无每帧 React 渲染 ——
  useEffect(() => {
    const score = scoreRef.current
    if (!score || !markersReady) return
    const n = selView.note
    if (!n) {
      score.highlightNoteAt(null)
      return
    }
    const entry = measureTableRef.current.find((x) => x.m === n.measure)
    if (!entry) return
    score.highlightNoteAt(n.measure, (n.q - entry.quarters) / 4)
    followMeasure(n.measure)
  }, [selView.note, markersReady, followMeasure])

  // —— 波形派生缓存：working/baseline/选中变化时重建（订阅级，渲染外） ——
  useEffect(() => {
    const unsub = useSyncTuneStore.subscribe((s0) => {
      q2tWorkRef.current = makeQ2T(s0.working)
      const q2tB = makeQ2T(s0.baseline)
      q2tBaseRef.current = q2tB
      measureStartsRef.current = measureTableRef.current.map((e) => ({
        m: e.m,
        t: q2tB(e.quarters).t,
      }))
      ticksRef.current = s0.working.map((p) => ({
        t: p.t,
        q: p.q,
        tuned: s0.baseline.some((b) => b.q === p.q && Math.abs(b.t - p.t) > 1e-6),
      }))
      notesRef.current = s0.notes
      selQRef.current =
        s0.selectedIdx === null
          ? null
          : (s0.notes.find((n) => n.idx === s0.selectedIdx)?.q ?? null)
      waveDirtyRef.current = true
      waveKickRef.current()
    })
    return unsub
  }, [])

  // —— 主循环：唯一时钟 audioEngine.time → 光标推进 + 波形按需重绘。
  //  空闲（未播放且不脏）时完全停掉 rAF 循环，零空转；置脏方负责 kick 唤醒 ——
  useEffect(() => {
    if (phase !== 'ready') return
    let raf = 0
    let running = false
    const step = () => {
      const t = audioEngine.time
      const playing = audioEngine.playing
      if (playing) scoreRef.current?.syncToTime(t)
      if (waveDirtyRef.current) {
        drawWave(t)
        waveDirtyRef.current = false
      }
      // 控制条（T2）：进度/时间/小节号直写 DOM；拖拽中让位给指针回调
      if (!scrubbingRef.current) updateTransport(t)
      // ⏯ 图标：仅播放态翻转时 setState（非每帧）
      if (playingUiRef.current !== playing) {
        playingUiRef.current = playing
        setPlayingUi(playing)
      }
      if (playing) {
        raf = requestAnimationFrame(step)
      } else {
        running = false // 空闲休眠：直到 kick/播放恢复
      }
    }
    waveKickRef.current = () => {
      if (!running) {
        running = true
        raf = requestAnimationFrame(step)
      }
    }
    // 首绘一次后休眠
    waveKickRef.current()
    return () => {
      cancelAnimationFrame(raf)
      running = false
      waveKickRef.current = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  /** 波形绘制：包络 + 基线/工作期望线 + 控制点刻度 + 播放头
   *  性能（t_perf_sync_tune）：q2t 闭包/刻度表/选中 q 全部来自缓存 refs
   *  （store 订阅预构建，绘制帧零 getState/零 Map 构建），期望线两遍循环
   *  各合并单 path；页脚刻度文本直写 DOM，拖拽/缩放不再触发 React 重渲染 */
  const drawWave = (playT: number) => {
    const canvas = canvasRef.current
    const peaks = peaksRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#10151a'
    ctx.fillRect(0, 0, w, h)
    const dur = durationRef.current
    if (!peaks || dur <= 0) {
      ctx.fillStyle = '#5a6a72'
      ctx.font = '12px sans-serif'
      ctx.fillText('波形不可用（伴奏解码失败）', 12, h / 2)
      return
    }
    const { t0, t1 } = viewRef.current
    const span = Math.max(t1 - t0, 1e-6)
    const xOf = (t: number) => ((t - t0) / span) * w
    const mid = h * 0.42
    const amp = h * 0.36
    // 包络
    const stepSec = stepSecRef.current || PEAK_STEP / 44100
    ctx.strokeStyle = '#3d5a63'
    ctx.beginPath()
    for (let x = 0; x < w; x++) {
      const ta = t0 + (x / w) * span
      const tb = ta + span / w
      let b0 = Math.floor(ta / stepSec)
      const b1 = Math.min(Math.floor(tb / stepSec), peaks.length / 2 - 1)
      if (b1 < b0) b0 = Math.max(0, b1)
      let mn = 1
      let mx = -1
      for (let b = b0; b <= b1; b++) {
        if (b < 0 || b * 2 + 1 >= peaks.length) continue
        mn = Math.min(mn, peaks[b * 2])
        mx = Math.max(mx, peaks[b * 2 + 1])
      }
      if (mn > mx) continue
      ctx.moveTo(x + 0.5, mid + mn * amp)
      ctx.lineTo(x + 0.5, mid + mx * amp)
    }
    ctx.stroke()
    // 期望线：基线（暗）与工作网格（亮）——微调时亮线实时移动
    const q2tW = q2tWorkRef.current
    const q2tB = q2tBaseRef.current
    if (q2tW && q2tB) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.13)'
      ctx.beginPath()
      for (const n of notesRef.current) {
        const t = q2tB(n.q).t
        if (t < t0 || t > t1) continue
        const x = xOf(t)
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, h)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(95,184,168,0.45)'
      ctx.beginPath()
      for (const n of notesRef.current) {
        const t = q2tW(n.q).t
        if (t < t0 || t > t1) continue
        const x = xOf(t)
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, h)
      }
      ctx.stroke()
    }
    // 选中音期望线（工作网格，高亮）
    const selQ = selQRef.current
    if (selQ !== null && q2tW) {
      const x = xOf(q2tW(selQ).t)
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = song.accent
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.lineWidth = 1
      }
    }
    // 控制点刻度（底部）：已调橙 / 未调灰 / 选中 accent——缓存刻度表
    for (const p of ticksRef.current) {
      if (p.t < t0 || p.t > t1) continue
      const x = xOf(p.t)
      const isSel = selQ === p.q
      ctx.strokeStyle = isSel ? song.accent : p.tuned ? '#ff9f43' : 'rgba(255,255,255,0.35)'
      ctx.lineWidth = isSel ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x + 0.5, h - (isSel ? 14 : 8))
      ctx.lineTo(x + 0.5, h)
      ctx.stroke()
      ctx.lineWidth = 1
    }
    // 播放头
    if (playT >= t0 && playT <= t1) {
      ctx.strokeStyle = '#e8e8e2'
      ctx.beginPath()
      ctx.moveTo(xOf(playT) + 0.5, 0)
      ctx.lineTo(xOf(playT) + 0.5, h)
      ctx.stroke()
    }
    // 页脚刻度文本：直写 DOM（T2 起仅显示视口时间范围，交互说明移入图例/帮助面板）
    const hint = waveHintRef.current
    if (hint) {
      hint.textContent = `${fmtTime(t0)} – ${fmtTime(t1)}`
    }
  }

  // —— 波形交互：拖拽平移 / 滚轮缩放 / 点击命中刻度或 seek ——
  const dragRef = useRef<{ x: number; t0: number; t1: number; moved: boolean } | null>(null)
  const onWavePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, t0: viewRef.current.t0, t1: viewRef.current.t1, moved: false }
  }
  const onWavePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    const w = e.currentTarget.clientWidth
    const span = d.t1 - d.t0
    const dx = e.clientX - d.x
    if (Math.abs(dx) > 3) d.moved = true
    if (!d.moved) return
    const dur = durationRef.current
    let t0 = d.t0 - (dx / w) * span
    t0 = Math.max(0, Math.min(t0, dur - span))
    viewRef.current = { t0, t1: t0 + span }
    waveDirtyRef.current = true // 页脚文本由 drawWave 直写，rAF 帧内重绘
    waveKickRef.current()
  }
  const onWavePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved) return
    // 点击：命中控制点刻度（±6px）→ 选中；否则 seek
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const { t0, t1 } = viewRef.current
    const span = t1 - t0
    const st0 = st.getState()
    let hit: { q: number; d: number } | null = null
    for (const p of st0.working) {
      const dpx = Math.abs(((p.t - t0) / span) * rect.width - x)
      if (dpx <= 6 && (!hit || dpx < hit.d)) hit = { q: p.q, d: dpx }
    }
    if (hit) {
      st0.selectByQ(hit.q)
      return
    }
    const t = t0 + (x / rect.width) * span
    if (t < 0 || t > durationRef.current) return
    audioEngine.seek(t)
    scoreRef.current?.resetCursor()
    waveDirtyRef.current = true
    waveKickRef.current()
  }
  const onWaveWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const { t0, t1 } = viewRef.current
    const span = t1 - t0
    const tc = t0 + ((e.clientX - rect.left) / rect.width) * span
    const k = e.deltaY > 0 ? 1.25 : 0.8
    const dur = durationRef.current
    let ns = Math.max(0.5, Math.min(span * k, dur || span * k))
    let nt0 = tc - (tc - t0) * (ns / span)
    if (dur > 0) {
      nt0 = Math.max(0, Math.min(nt0, dur - ns))
      ns = Math.min(ns, dur)
    }
    viewRef.current = { t0: nt0, t1: nt0 + ns }
    waveDirtyRef.current = true // 同拖拽：按需重绘
    waveKickRef.current()
  }

  // —— 播放控制条（T2）：时间/小节号/进度填充直写 DOM（refs），供 rAF 帧与指针回调共用 ——
  const updateTransport = useCallback((t: number) => {
    const dur = durationRef.current
    if (fillRef.current) {
      const frac = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 0
      fillRef.current.style.width = `${(frac * 100).toFixed(2)}%`
    }
    if (timeLabelRef.current) timeLabelRef.current.textContent = fmtTime(t)
    if (measureLabelRef.current) {
      const ms = measureStartsRef.current
      let m = ms[0]?.m ?? 1
      for (const e of ms) {
        if (e.t <= t) m = e.m
        else break
      }
      measureLabelRef.current.textContent = `m ${m} / ${ms.length ? ms[ms.length - 1].m : m}`
    }
  }, [])

  /** seek 到 t（进度条/⏮/⏭ 共用）：暂停态同步推进光标；波形与控制条即刻刷新 */
  const doSeek = useCallback(
    (t: number) => {
      audioEngine.seek(t)
      scoreRef.current?.resetCursor()
      if (!audioEngine.playing) scoreRef.current?.syncToTime(t)
      updateTransport(audioEngine.time)
      waveDirtyRef.current = true
      waveKickRef.current()
    },
    [updateTransport],
  )

  /** 当前 t 所在小节序（measureStarts 单调递增，线性足够） */
  const measureIdxAt = (t: number): number => {
    const ms = measureStartsRef.current
    let i = 0
    for (let k = 0; k < ms.length; k++) {
      if (ms[k].t <= t) i = k
      else break
    }
    return i
  }

  /** ⏮：距小节头 >1s 回本小节头，否则退上一小节；首小节回开头 */
  const seekPrevMeasure = useCallback(() => {
    const ms = measureStartsRef.current
    if (!ms.length) return
    const i = measureIdxAt(audioEngine.time)
    const target = audioEngine.time - ms[i].t > 1 ? ms[i].t : i > 0 ? ms[i - 1].t : 0
    doSeek(Math.max(0, target))
  }, [doSeek])

  /** ⏭：下一小节头；末小节到曲尾 */
  const seekNextMeasure = useCallback(() => {
    const ms = measureStartsRef.current
    if (!ms.length) return
    const i = measureIdxAt(audioEngine.time)
    const target = i + 1 < ms.length ? ms[i + 1].t : durationRef.current
    doSeek(Math.min(target, durationRef.current))
  }, [doSeek])

  // —— 进度条：拖拽中只直写视觉（updateTransport），松手才 audioEngine.seek（避免反复重启音频）——
  const fracOfProgress = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(rect.width, 1)))
  }
  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (durationRef.current <= 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbingRef.current = true
    updateTransport(fracOfProgress(e) * durationRef.current)
  }
  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return
    updateTransport(fracOfProgress(e) * durationRef.current)
  }
  const onProgressPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    doSeek(fracOfProgress(e) * durationRef.current)
  }

  // —— 波形面板折叠（T2）：localStorage 记忆；展开后画布尺寸恢复需置脏重绘 ——
  const toggleWaveCollapsed = useCallback(() => {
    setWaveCollapsed((c) => {
      const nc = !c
      try {
        localStorage.setItem('st-wave-collapsed', nc ? '1' : '0')
      } catch {
        // 存储不可用时仅内存态生效
      }
      return nc
    })
  }, [])
  useEffect(() => {
    if (waveCollapsed) return
    waveDirtyRef.current = true
    waveKickRef.current()
  }, [waveCollapsed])

  // —— 播放/暂停 与 保存修改（T3c 工作流）——
  const togglePlay = useCallback(async () => {
    if (audioEngine.playing) {
      audioEngine.pause()
    } else {
      // play 是 async：先解锁 AudioContext 再 start；await 后 playing 才为真，
      // 需再 kick 一次唤醒 rAF 循环（同步 kick 已在未播放态休眠）
      const ok = await audioEngine.play()
      setAudioState(audioEngine.state)
      if (!ok) {
        flashAudioBadge()
      } else {
        scoreRef.current?.showCursor()
        waveDirtyRef.current = true
        waveKickRef.current()
      }
    }
    waveDirtyRef.current = true
    waveKickRef.current()
  }, [flashAudioBadge])

  /** 保存修改（T3c）：working 应用为新基线（store.saveBaseline），显示时间轴
   *  按新锚点热切换（setTimeline，谱面不重渲）——播放光标/波形期望线即刻切到
   *  新节奏；波形置脏重绘（store 订阅亦会重建 q2t/刻度缓存） */
  const saveChanges = useCallback(() => {
    const st0 = st.getState()
    if (!st0.dirty) return
    st0.saveBaseline()
    const beats = beatsRef.current
    const baseTl = baseTlRef.current
    if (beats && baseTl) {
      displayTlRef.current = applyBeats(baseTl, {
        ...beats,
        beatAnchors: st0.working.map((p) => ({ ...p })),
      })
      scoreRef.current?.setTimeline(displayTlRef.current)
    }
    waveDirtyRef.current = true
    waveKickRef.current()
  }, [])

  // —— 快捷键：[/]=±50ms、{/}=±200ms、空格、Ctrl+Z ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        st.getState().undo()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case '[':
          e.preventDefault()
          st.getState().adjust(-50)
          break
        case ']':
          e.preventDefault()
          st.getState().adjust(50)
          break
        case '{':
          e.preventDefault()
          st.getState().adjust(-200)
          break
        case '}':
          e.preventDefault()
          st.getState().adjust(200)
          break
        case ' ':
          e.preventDefault()
          void togglePlay()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  // —— 导出：beats.json（version+1）+ manual_offsets.json ——
  const download = (data: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const saveAll = () => {
    const st0 = st.getState()
    const beats = beatsRef.current
    if (!beats) return
    const date = new Date().toISOString().slice(0, 10)
    download(buildBeatsExport(beats, st0.working, tunedCount(st0), date), 'beats.json')
    if (st0.log.length) download(st0.log, 'manual_offsets.json')
  }

  // —— 渲染 ——
  // 列表全量展示（T3d）：去掉小节 ±2 窗口，滚轮可浏览全谱；chips 过滤作用于全量，
  // 选中行自动 scrollIntoView 保留（下方 effect）
  const listNotes = visibleNotes(st.getState())
  // 行元数据（T3d 全量列表）：q→{控制点, 偏差ms} 随 working/baseline 一次构建 O(N+M)，
  // 行渲染 O(1) 查表——601 行逐行 working.find + 重复 deltaMsAt 扫描是全量化后的卡顿源
  const rowMeta = useMemo(() => {
    const cpByQ = new Map(working.map((p) => [p.q, p]))
    const meta = new Map<number, { cp?: CtrlPoint; delta: number }>()
    for (const n of st.getState().notes) {
      meta.set(n.q, { cp: cpByQ.get(n.q), delta: Math.round(deltaMsAt(working, baseline, n.q)) })
    }
    return meta
  }, [working, baseline])
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, filter])

  /** 谱面点音符（三向同步之一）：noteAtPoint（T3b 强化：音符头绘制 x 对齐 +
   *  行阈值收紧）→ 小节+小节内拍位 → 最近音符。nearHint 三档（T3b 决策 3）：
   *  精确命中（音符头半宽内）无提示 / 附近音符（半宽外 120px 内）/ 超距最近
   *  （>120px）；行外无效点击不选不误触、也给出提示。提示 5s 自动消隐，
   *  离散点击路径不进帧渲染 */
  const onScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = scoreRef.current?.noteAtPoint(e.clientX, e.clientY)
    window.clearTimeout(nearHintTimerRef.current)
    if (!hit) {
      // 无效点击（T3b 行判定收紧）：点击处离谱行过远（超行高一半），不选不误触
      setNearHint('点击处离谱行过远，未选中（无效点击）')
      nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
      return
    }
    const entry = measureTableRef.current.find((x) => x.m === hit.measure)
    if (!entry) return
    if (hit.dist > 120) {
      setNearHint('已选最近音符（点击处附近无音符）')
      nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
    } else if (!hit.precise) {
      // 半个音符头宽度外但 120px 内：始终告知选中的是附近音符（T3b 决策 3；
      // T3c 文案不带 px 数字，仅语义提示）
      setNearHint('已选附近音符（距点击处稍远）')
      nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
    } else {
      setNearHint(null) // 精确命中：无提示
    }
    st.getState().selectByQ(entry.quarters + hit.rvInMeasure * 4)
  }

  return (
    <div className="st-page" style={{ '--song-accent': song.accent } as React.CSSProperties}>
      <div className="st-topwrap">
        <header className="st-topbar">
        <a className="st-back" href="/">
          ← 返回
        </a>
        <b>{song.title}</b>
        {audioState === 'running' ? (
          <span className="st-audio ok" title="音频已启用">
            ●
          </span>
        ) : (
          <button
            ref={audioBadgeRef}
            className="st-audio"
            onClick={() => void enableAudio()}
            title="浏览器自动播放策略挂起了音频，点击解锁"
          >
            🔊 点击启用音频
          </button>
        )}
        <span className="st-meta">
          beats v{beatsRef.current?.version ?? '—'} · 控制点 {working.length} · 已调{' '}
          <em className={tuned ? 'on' : ''}>{tuned}</em>
          {dirty && <i className="st-dirty">未导出</i>}
        </span>
        <span className="st-flex" />
        <button className="st-btn primary" onClick={saveAll} disabled={!dirty}>
          导出 beats.json
        </button>
      </header>
        {phase === 'ready' && (
          <div className="st-transport">
            <button
              className="st-tbtn"
              onClick={seekPrevMeasure}
              title="回小节头（小节头附近再按退上一小节）"
            >
              ⏮
            </button>
            <button className="st-tbtn" onClick={() => void togglePlay()} title="播放/暂停（空格）">
              {playingUi ? '⏸' : '▶'}
            </button>
            <button className="st-tbtn" onClick={seekNextMeasure} title="下一小节">
              ⏭
            </button>
            <span className="st-pos" ref={measureLabelRef}>
              m 1 / -
            </span>
            <div
              className="st-progress"
              onPointerDown={onProgressPointerDown}
              onPointerMove={onProgressPointerMove}
              onPointerUp={onProgressPointerUp}
              title="进度条：点击/拖拽 seek（松手生效）"
            >
              <div className="st-progress-fill" ref={fillRef} />
            </div>
            <span className="st-time" ref={timeLabelRef}>
              {fmtTime(0)}
            </span>
          </div>
        )}
      </div>

      {phase === 'loading' && <div className="st-status">正在装配曲谱 / 伴奏 / 锚点…</div>}
      {phase === 'error' && <div className="st-status err">装配失败：{errorMsg}</div>}

      {phase === 'ready' && (
        <div className="st-main">
          <aside className="st-list">
            <div className="st-list-head">
              <span>
                {filter === 'all' ? '全部' : filter === 'tuned' ? '已调' : '未调'} {listNotes.length}{' '}
                音符
              </span>
              {(['all', 'tuned', 'untuned'] as const).map((f) => (
                <button
                  key={f}
                  className={`st-chip${filter === f ? ' on' : ''}`}
                  onClick={() => st.getState().setFilter(f)}
                >
                  {f === 'all' ? '全部' : f === 'tuned' ? '已调' : '未调'}
                </button>
              ))}
            </div>
            <div className="st-list-body" ref={listRef}>
              {listNotes.map((n) => {
                const isSel = n.idx === selectedIdx
                const { cp, delta } = rowMeta.get(n.q) ?? { cp: undefined, delta: 0 }
                return (
                  <button
                    key={n.idx}
                    className={`st-row${isSel ? ' sel' : ''}`}
                    data-sel={isSel ? '1' : undefined}
                    onClick={() => st.getState().select(n.idx)}
                  >
                    <span className="m">m{n.measure}</span>
                    <span className="p">{midiName(n.midi)}</span>
                    <span className="q">q{n.q.toFixed(2)}</span>
                    <span className="t">{cp ? `${cp.t.toFixed(2)}s` : '—'}</span>
                    {delta !== 0 && (
                      <span className={`delta${delta > 0 ? ' pos' : ' neg'}`}>
                        {delta > 0 ? '+' : ''}
                        {delta}ms
                      </span>
                    )}
                  </button>
                )
              })}
              {listNotes.length === 0 && <div className="st-empty">无此状态音符</div>}
            </div>
          </aside>

          <section className="st-score" ref={scoreSectionRef} onClick={onScoreClick}>
            <div ref={scoreDivRef} className="st-score-container" />
          </section>

          <aside className="st-props">
            {/* 命中提示提到顶层（T3b）：无效点击/无选中时右栏也可见 */}
            {nearHint && <p className="st-near-hint">{nearHint}</p>}
            {selView.note ? (
              <>
                <h3>
                  m{selView.note.measure} · {midiName(selView.note.midi)}
                </h3>
                <dl>
                  <dt>q（四分音符位）</dt>
                  <dd>{selView.note.q.toFixed(3)}</dd>
                  <dt>当前 t（基线）</dt>
                  <dd>{selView.baselineT.toFixed(3)}s</dd>
                  <dt>修正 t（工作）</dt>
                  <dd>
                    {selView.currentT.toFixed(3)}s{' '}
                    {!selView.hasCp && <i className="st-tag">无控制点，微调时插入</i>}
                  </dd>
                  <dt>偏差</dt>
                  <dd className={selView.deltaMs !== 0 ? (selView.deltaMs > 0 ? 'pos' : 'neg') : ''}>
                    {selView.deltaMs === 0
                      ? '0 ms'
                      : `${selView.deltaMs > 0 ? '+' : ''}${selView.deltaMs.toFixed(0)} ms`}
                  </dd>
                </dl>
                <div className="st-btn-grid">
                  {[-200, -100, -50, -10, 10, 50, 100, 200].map((d) => (
                    <button key={d} className="st-btn" onClick={() => st.getState().adjust(d)}>
                      {d > 0 ? `+${d}` : d}ms
                    </button>
                  ))}
                </div>
                <div className="st-btn-row">
                  <button
                    className="st-btn"
                    onClick={() => st.getState().undo()}
                    disabled={undoStack.length === 0}
                  >
                    撤销上一步
                  </button>
                  <button className="st-btn primary" onClick={saveChanges} disabled={!dirty}>
                    保存修改
                  </button>
                </div>
              </>
            ) : (
              <p className="st-empty">在左侧列表、谱面或波形上选中一个音符开始微调</p>
            )}
            {/* 操作说明（T2）：默认收起、展开不持久化；T3c 起只留绿色 ？，
                「操作说明」文字进 aria-label（无障碍不丢） */}
            <details className="st-help">
              <summary aria-label="操作说明" />
              <div className="st-help-body">
                <p className="st-help-sec">快捷键</p>
                <ul>
                  <li>
                    <kbd>[</kbd> / <kbd>]</kbd>：选中音符 −50 / +50 ms
                  </li>
                  <li>
                    <kbd>{'{'}</kbd> / <kbd>{'}'}</kbd>：−200 / +200 ms
                  </li>
                  <li>
                    <kbd>空格</kbd>：播放 / 暂停
                  </li>
                  <li>
                    <kbd>Ctrl</kbd>+<kbd>Z</kbd>：撤销
                  </li>
                </ul>
                <p className="st-help-sec">鼠标操作</p>
                <ul>
                  <li>列表点行 / 谱面点音符 / 波形点刻度：选中音符</li>
                  <li>波形拖拽：平移；滚轮：缩放</li>
                  <li>波形点空白处：seek 到该时刻</li>
                  <li>⏯ 按钮：播放 / 暂停</li>
                  <li>进度条点 / 拖：seek（松手生效）</li>
                  <li>⏮ / ⏭：回小节头 / 下一小节</li>
                </ul>
              </div>
            </details>
          </aside>
        </div>
      )}

      <footer className={`st-wave${waveCollapsed ? ' collapsed' : ''}`}>
        <div
          className="st-wave-head"
          onClick={toggleWaveCollapsed}
          title={waveCollapsed ? '展开波形面板' : '收起波形面板'}
        >
          <span className={`st-wave-caret${waveCollapsed ? ' closed' : ''}`}>▾</span>
          <span className="st-wave-title">伴奏波形</span>
          <div className="st-legend">
            <span>
              <i className="sw h" style={{ background: 'rgba(255,255,255,0.13)' }} />
              白细线=基线期望
            </span>
            <span>
              <i className="sw h" style={{ background: 'rgba(95,184,168,0.45)' }} />
              青线=当前网格
            </span>
            <span>
              <i className="sw v" style={{ background: '#ff9f43' }} />
              橙刻度=已调
            </span>
            <span>
              <i className="sw v" style={{ background: 'var(--song-accent)' }} />
              亮刻度=选中
            </span>
            <span>
              <i className="sw h" style={{ background: '#e8e8e2' }} />
              白竖线=播放头
            </span>
          </div>
          <span className="st-flex" />
          <span className="st-wave-hint" ref={waveHintRef}>
            {fmtTime(viewRef.current.t0)} – {fmtTime(viewRef.current.t1)}
          </span>
        </div>
        <canvas
          ref={canvasRef}
          onPointerDown={onWavePointerDown}
          onPointerMove={onWavePointerMove}
          onPointerUp={onWavePointerUp}
          onWheel={onWaveWheel}
        />
      </footer>
    </div>
  )
}

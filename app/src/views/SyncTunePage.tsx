import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { audioEngine } from '../audio/AudioEngine'
import { applyBeats, type BeatsFile } from '../score/anchors'
import { OSMDScore } from '../score/OSMDScore'
import { expandRepeats, parseMusicXml } from '../score/musicxml'
import { assetUrl } from '../lib/assetUrl'
import { getSong, SONGS } from '../songs'
import {
  auditionWindow,
  buildBeatsExport,
  buildSyncNotes,
  deltaMsAt,
  fmtTime,
  makeQ2T,
  midiName,
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
  const [curMeasure, setCurMeasure] = useState(1)
  const [auditioning, setAuditioning] = useState(false)
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const beatsRef = useRef<BeatsFile | null>(null)
  const peaksRef = useRef<Float32Array | null>(null)
  const stepSecRef = useRef(0)
  const durationRef = useRef(0)
  const displayTlRef = useRef<ReturnType<typeof parseMusicXml> | null>(null)
  const measureTableRef = useRef<{ m: number; quarters: number }[]>([])
  const viewRef = useRef({ t0: 0, t1: 1 })
  const auditionSeqRef = useRef(0)

  const st = useSyncTuneStore
  const cancelAudition = useCallback(() => {
    auditionSeqRef.current++
    setAuditioning(false)
  }, [])

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
        setXml(xmlExp)
        // 演奏显示时间轴：基线锚点应用后的时间轴（光标语义同演奏页）
        displayTlRef.current = applyBeats(pre, beats)
        // 伴奏解码 → 峰值包络
        if (song.accompanimentUrl) {
          try {
            const ab = await fetch(assetUrl(song.accompanimentUrl))
            if (!ab.ok) throw new Error(`HTTP ${ab.status}`)
            const buf = await audioEngine.decode(await ab.arrayBuffer())
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
      auditionSeqRef.current++
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
    const osmd = new OSMDScore(div, song.accent)
    scoreRef.current = osmd
    osmd.onMeasureChange = (m) => setCurMeasure(m)
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
    // accent/xml 随曲目变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, xml, song.accent])

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

  // —— 波形派生缓存：working/baseline/选中变化时重建（订阅级，渲染外） ——
  useEffect(() => {
    const unsub = useSyncTuneStore.subscribe((s0) => {
      q2tWorkRef.current = makeQ2T(s0.working)
      q2tBaseRef.current = makeQ2T(s0.baseline)
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
    // 页脚刻度文本：直写 DOM
    const hint = waveHintRef.current
    if (hint) {
      hint.textContent = `拖拽平移 · 滚轮缩放 · 点刻度选中 · 点空白 seek ｜ ${fmtTime(t0)} – ${fmtTime(t1)}`
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
      cancelAudition()
      st0.selectByQ(hit.q)
      return
    }
    const t = t0 + (x / rect.width) * span
    if (t < 0 || t > durationRef.current) return
    cancelAudition()
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

  // —— 播放/暂停 与 试听 A/B ——
  const togglePlay = useCallback(async () => {
    cancelAudition()
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
  }, [cancelAudition, flashAudioBadge])

  const runAudition = useCallback(async () => {
    const st0 = st.getState()
    const view = selectedNoteView(st0)
    if (!view.note) return
    cancelAudition()
    const A = auditionWindow(view.baselineT)
    const tB = makeQ2T(st0.working)(view.note.q).t
    const B = auditionWindow(tB)
    const seq = ++auditionSeqRef.current
    setAuditioning(true)
    audioEngine.pause()
    // A 窗播放：失败（仍 suspended）直接终止试听并闪动徽标
    const okA = await audioEngine.play(A.start)
    setAudioState(audioEngine.state)
    if (!okA) {
      flashAudioBadge()
      setAuditioning(false)
      return
    }
    scoreRef.current?.resetCursor()
    waveDirtyRef.current = true
    waveKickRef.current()
    const watch = (endT: number, next: () => void) => {
      const step = () => {
        if (auditionSeqRef.current !== seq) return
        if (!audioEngine.playing) {
          setAuditioning(false)
          return
        }
        if (audioEngine.time >= endT) {
          next()
          return
        }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
    watch(A.end, () => {
      if (Math.abs(tB - view.baselineT) < 1e-6) {
        // 修正未生效：B 窗与 A 相同，不重复播
        audioEngine.pause()
        setAuditioning(false)
        return
      }
      // B 窗在 rAF 回调里启动：play 为 async，成功后再起 watch
      void audioEngine.play(B.start).then((okB) => {
        setAudioState(audioEngine.state)
        if (!okB) {
          flashAudioBadge()
          setAuditioning(false)
          return
        }
        scoreRef.current?.resetCursor()
        waveDirtyRef.current = true
        waveKickRef.current()
        watch(B.end, () => {
          audioEngine.pause()
          setAuditioning(false)
        })
      })
    })
  }, [cancelAudition, flashAudioBadge])

  // —— 快捷键：[/]=±50ms、{/}=±200ms、空格、Enter、Ctrl+Z ——
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
        case 'Enter':
          e.preventDefault()
          void runAudition()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, runAudition])

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
  const anchorMeasure = selView.note?.measure ?? curMeasure
  const listNotes = visibleNotes(st.getState(), anchorMeasure, 2)
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, filter])

  /** 谱面点音符（三向同步之一）：noteAtPoint → 小节+小节内拍位 → 最近音符 */
  const onScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = scoreRef.current?.noteAtPoint(e.clientX, e.clientY)
    if (!hit) return
    const entry = measureTableRef.current.find((x) => x.m === hit.measure)
    if (!entry) return
    cancelAudition()
    st.getState().selectByQ(entry.quarters + hit.rvInMeasure * 4)
  }

  return (
    <div className="st-page" style={{ '--song-accent': song.accent } as React.CSSProperties}>
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
        <button className="st-btn" onClick={() => st.getState().undo()} disabled={undoStack.length === 0}>
          撤销 (Ctrl+Z)
        </button>
        <button className="st-btn primary" onClick={saveAll} disabled={!dirty}>
          导出 beats.json
        </button>
      </header>

      {phase === 'loading' && <div className="st-status">正在装配曲谱 / 伴奏 / 锚点…</div>}
      {phase === 'error' && <div className="st-status err">装配失败：{errorMsg}</div>}

      {phase === 'ready' && (
        <div className="st-main">
          <aside className="st-list">
            <div className="st-list-head">
              <span>
                m{Math.max(1, anchorMeasure - 2)}–{anchorMeasure + 2}
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
                const delta = Math.round(deltaMsAt(working, baseline, n.q))
                const cp = working.find((p) => p.q === n.q)
                return (
                  <button
                    key={n.idx}
                    className={`st-row${isSel ? ' sel' : ''}`}
                    data-sel={isSel ? '1' : undefined}
                    onClick={() => {
                      cancelAudition()
                      st.getState().select(n.idx)
                      setCurMeasure(n.measure)
                    }}
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
              {listNotes.length === 0 && <div className="st-empty">该窗口内无此状态音符</div>}
            </div>
          </aside>

          <section className="st-score" onClick={onScoreClick}>
            <div ref={scoreDivRef} className="st-score-container" />
          </section>

          <aside className="st-props">
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
                  <button className="st-btn" onClick={() => st.getState().resetSelected()}>
                    重置
                  </button>
                  <button
                    className={`st-btn primary${auditioning ? ' live' : ''}`}
                    onClick={runAudition}
                  >
                    {auditioning ? '试听中…' : '试听 A/B (Enter)'}
                  </button>
                </div>
                <p className="st-hint">
                  {`[ / ] ±50ms · { / } ±200ms · 空格 播放/暂停`}
                  <br />
                  {`Enter 播放 基线→修正 各 −1s→+2s 窗口`}
                </p>
              </>
            ) : (
              <p className="st-empty">在左侧列表、谱面或波形上选中一个音符开始微调</p>
            )}
          </aside>
        </div>
      )}

      <footer className="st-wave">
        <canvas
          ref={canvasRef}
          onPointerDown={onWavePointerDown}
          onPointerMove={onWavePointerMove}
          onPointerUp={onWavePointerUp}
          onWheel={onWaveWheel}
        />
        <span className="st-wave-hint" ref={waveHintRef}>
          拖拽平移 · 滚轮缩放 · 点刻度选中 · 点空白 seek ｜ {fmtTime(viewRef.current.t0)} –{' '}
          {fmtTime(viewRef.current.t1)}
        </span>
      </footer>
    </div>
  )
}

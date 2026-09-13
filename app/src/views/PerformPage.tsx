import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { openMic, type MicSession } from '../audio/recorder'
import { loadAccompaniment, cancelPendingAccompaniment } from '../audio/accompaniment'
import { LumiereScene } from '../background/LumiereScene'
import ControlBar, { type CaptureIndicator } from '../components/ControlBar'
import PitchMeter, { type PitchMeterHandle } from '../components/PitchMeter'
import { noteAt } from '../pitch/compare'
import { LivePitchTracker } from '../pitch/live'
import { yinDetect } from '../pitch/yin'
import ScoreSheet from '../components/ScoreSheet'
import type { OSMDScore } from '../score/OSMDScore'
import { getSong, loadSong, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { useAppStore } from '../store'
import type { PerformanceSegment, Timeline } from '../types'
import './PerformPage.css'

/**
 * 页内阶段机：加载 → 就绪 → 倒数 → 演奏（含暂停）→ 结束。
 * 高频数据（当前时间/小节/进度/实时音准）由 rAF 直写 DOM，不进 store（已定决策 5）。
 */
type Phase = 'loading' | 'ready' | 'countdown' | 'performing' | 'ended' | 'error'

const IDLE_MS = 3200
const COUNT_BEATS = 4
const TAIL_GRACE = 0.6 // 末音后留给混响的余韵再收
const LIVE_EVERY = 3 // 实时音高检测隔帧跑（≈20Hz），YIN O(W²) 控制开销

const fmt = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

/** 采集段起点：伴奏时间轴位置 + 墙钟（Take.startedAt 用） */
interface CaptureStart {
  t: number
  wall: number
  rate: number
}

interface CaptureRequest {
  generation: number
  sessionId: string
  mic: MicSession
}

interface CountdownState {
  t0: number
  beat: number
  target: number
  initial: boolean
  generation: number
}

function tempoAtTime(timeline: Timeline, time: number): number {
  const segment = timeline.tempoSegments
    ?.filter((item) => item.time <= time)
    .at(-1)
  return segment?.bpm ?? timeline.tempo
}

export default function PerformPage() {
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const beginPerformance = useAppStore((s) => s.beginPerformance)
  const setPerformanceStatus = useAppStore((s) => s.setPerformanceStatus)
  const appendPerformanceSegment = useAppStore((s) => s.appendPerformanceSegment)
  const finishPerformance = useAppStore((s) => s.finishPerformance)
  const song = getSong(songId) ?? SONGS[0]

  const [phase, setPhase] = useState<Phase>('loading')
  const [playing, setPlaying] = useState(false)
  const [recOn, setRecOn] = useState(false)
  const [captureIndicator, setCaptureIndicator] = useState<CaptureIndicator>('idle')
  // 初值读引擎实际增益（t_5957a725）：audioEngine 全局单例，回放页「对照伴奏」
  // 拖过的音量跨页留存——写死 1 会显示假满格而实际 gain=0，背景伴奏无声
  const [volume, setVolume] = useState(() => audioEngine.getVolume())
  const [errorMsg, setErrorMsg] = useState('')
  const [xml, setXml] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [synthesizedAccompaniment, setSynthesizedAccompaniment] = useState(false)
  const [tempoRatio, setTempoRatio] = useState(1)
  const [tempoPending, setTempoPending] = useState(false)
  const tempoPendingRef = useRef(false)
  const requestedRateRef = useRef(1)

  // rAF 循环用的 ref 镜像（避开闭包过期）
  const timelineRef = useRef<Timeline | null>(null)
  const phaseRef = useRef<Phase>('loading')
  const playingRef = useRef(false)
  const finishedRef = useRef(false)
  const mountedRef = useRef(true)
  const sessionIdRef = useRef<string | null>(null)
  const startPendingRef = useRef(false)
  const resumePendingRef = useRef(false)
  const countdownRef = useRef<CountdownState>({ t0: 0, beat: 0.7, target: 0, initial: true, generation: 0 })
  const [countdownRound, setCountdownRound] = useState(0)
  const transitionGenerationRef = useRef(0)
  const transitionShouldResumeRef = useRef(false)
  const playOperationSeqRef = useRef(0)
  const playOwnerRef = useRef(0)
  const playIntentRef = useRef(false)
  const tickCancelsRef = useRef<(() => void)[]>([])
  const idleTimer = useRef(0)
  const toastTimer = useRef(0)

  // 麦克风会话（实时音高反馈 + 采集两条支路）与录音开关镜像
  const micRef = useRef<MicSession | null>(null)
  const micOpeningRef = useRef<Promise<MicSession> | null>(null)
  const recOnRef = useRef(false)
  const recStartedRef = useRef<CaptureStart | null>(null)
  const sealQueueRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const captureGateQueueRef = useRef<Promise<void>>(Promise.resolve())
  const captureGenerationRef = useRef(0)
  const segmentSeqRef = useRef(0)
  const liveTrackerRef = useRef(new LivePitchTracker())
  const frameIdxRef = useRef(0)

  const scoreRef = useRef<OSMDScore | null>(null)
  const pitchMeterRef = useRef<PitchMeterHandle | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)
  const bgVideoRef = useRef<HTMLVideoElement>(null)
  const measureEl = useRef<HTMLSpanElement>(null)
  const timeEl = useRef<HTMLSpanElement>(null)
  const playedEl = useRef<HTMLSpanElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const countEl = useRef<HTMLDivElement>(null)
  /** 谱面行跟随：小节变化时把当前行滚到视口中部（OSMD 原生只在光标行掉出
   *  视口时最小滚动——首行起步的谱面前几行全在首屏内，光标走几行都纹丝不动，
   *  fd 前奏 ~45s 不滚动即此根因）。用户手动滚谱/摸谱时让位 5s。 */
  const lastFollowedMeasureRef = useRef(0)
  const manualUntilRef = useRef(0)

  // 手动滚谱让位：wheel/pointerdown 直接说明「用户在看别处」，程序性 scrollTop
  // 写入不派发这些事件，不会自我触发（scroll 事件则会——所以不能监听 scroll）
  useEffect(() => {
    const bump = () => {
      manualUntilRef.current = performance.now() + 5000
    }
    window.addEventListener("wheel", bump, { passive: true })
    window.addEventListener("pointerdown", bump, { passive: true })
    return () => {
      window.removeEventListener("wheel", bump)
      window.removeEventListener("pointerdown", bump)
    }
  }, [])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  /** 唤醒沉浸控件；播放中静置 IDLE_MS 后隐藏 */
  const wake = useCallback(() => {
    shellRef.current?.classList.remove('idle')
    clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      if (playingRef.current && shellRef.current && !document.querySelector('[role="dialog"][aria-modal="true"]')) shellRef.current.classList.add('idle')
    }, IDLE_MS)
  }, [])

  /** 轻提示（麦克风不可用等降级场景），3 秒自动消失 */
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  const reportCaptureError = useCallback((error: unknown) => {
    if (!mountedRef.current || finishedRef.current) return
    setCaptureIndicator('error')
    showToast(`录音不可用：${error instanceof Error ? error.message : String(error)}`)
  }, [showToast])

  /** 确保麦克风会话存在（只开一次；实时音准反馈不受录音开关影响） */
  const ensureMic = useCallback((): Promise<MicSession> => {
    if (micRef.current) return Promise.resolve(micRef.current)
    if (!micOpeningRef.current) {
      setCaptureIndicator('waiting')
      showToast('等待麦克风授权，暂未录音')
      micOpeningRef.current = openMic(audioEngine.audioCtx)
        .then((mic) => {
          if (!mountedRef.current || finishedRef.current) {
            mic.release()
            micOpeningRef.current = null
            throw new Error('麦克风请求已取消')
          }
          micRef.current = mic
          micOpeningRef.current = null
          setCaptureIndicator('idle')
          return mic
        })
        .catch((e: unknown) => {
          micOpeningRef.current = null
          reportCaptureError(e)
          throw e
        })
    }
    return micOpeningRef.current
  }, [reportCaptureError, showToast])

  const captureRequestIsCurrent = useCallback((request: CaptureRequest): boolean => (
    mountedRef.current
    && !finishedRef.current
    && recOnRef.current
    && captureGenerationRef.current === request.generation
    && sessionIdRef.current === request.sessionId
    && micRef.current === request.mic
  ), [])

  /**
   * 开一段新采集。所有 gate 操作串行执行；起点只在 worklet 已确认 gate 打开后
   * 读取伴奏时钟，不能把等待上一段封存的空白时间算进录音。
   */
  const startCapture = useCallback((paused: boolean): Promise<boolean> => {
    const mic = micRef.current
    const sessionId = sessionIdRef.current
    if (!mic || !sessionId || !recOnRef.current) return Promise.resolve(false)
    const request: CaptureRequest = {
      generation: captureGenerationRef.current,
      sessionId,
      mic,
    }
    const task = captureGateQueueRef.current.then(async () => {
      await sealQueueRef.current
      if (!captureRequestIsCurrent(request)) return false
      setCaptureIndicator('preparing')
      try {
        await mic.restartCapture()
        if (paused) await mic.pauseCapture()
      } catch (error) {
        if (!captureRequestIsCurrent(request)) return false
        reportCaptureError(error)
        throw error
      }
      if (!captureRequestIsCurrent(request)) {
        // gate 已经打开但请求随后被“关录音/跳转”淘汰，必须明确丢弃；后续
        // start 请求排在本任务之后，所以不会误伤更新的采集。
        if (mountedRef.current && !finishedRef.current && micRef.current === mic) {
          await mic.discardCapture().catch(() => {})
        }
        return false
      }
      recStartedRef.current = { t: audioEngine.time, wall: Date.now(), rate: audioEngine.rate }
      setCaptureIndicator('ready')
      setPerformanceStatus(request.sessionId, 'recording')
      return true
    })
    captureGateQueueRef.current = task.then(() => {}, () => {})
    return task
  }, [captureRequestIsCurrent, reportCaptureError, setPerformanceStatus])

  /** 恢复已有采集也受同一 gate 队列和请求代次保护。 */
  const resumeCapture = useCallback((): Promise<boolean> => {
    const mic = micRef.current
    const sessionId = sessionIdRef.current
    if (!mic || !sessionId || !recOnRef.current || !recStartedRef.current) {
      return Promise.resolve(false)
    }
    const request: CaptureRequest = {
      generation: captureGenerationRef.current,
      sessionId,
      mic,
    }
    const task = captureGateQueueRef.current.then(async () => {
      if (!captureRequestIsCurrent(request) || !recStartedRef.current) return false
      setCaptureIndicator('preparing')
      try {
        await mic.resumeCapture()
      } catch (error) {
        if (!captureRequestIsCurrent(request)) return false
        reportCaptureError(error)
        throw error
      }
      const resumed = captureRequestIsCurrent(request) && !!recStartedRef.current
      if (resumed) setCaptureIndicator('ready')
      return resumed
    })
    captureGateQueueRef.current = task.then(() => {}, () => {})
    return task
  }, [captureRequestIsCurrent, reportCaptureError])

  const sealCurrentCapture = useCallback((stopSec: number): Promise<boolean> => {
    const started = recStartedRef.current
    recStartedRef.current = null
    if (!started) return sealQueueRef.current
    setCaptureIndicator('idle')
    const mic = micRef.current
    const sessionId = sessionIdRef.current
    const captureBarrier = captureGateQueueRef.current
    const task = Promise.all([sealQueueRef.current, captureBarrier]).then(async () => {
      if (!mic || !sessionId) return false
      const recording = await mic.finishCapture()
      if (!recording) return true
      if (!mountedRef.current || sessionIdRef.current !== sessionId) {
        URL.revokeObjectURL(recording.url)
        return false
      }
      if (recording.silent) showToast('警告：本段录音电平接近 0，请检查麦克风输入')
      const segment: PerformanceSegment = {
        id: `${sessionId}-segment-${++segmentSeqRef.current}`,
        sessionId,
        songId: song.id,
        startedAt: started.wall,
        durationSec: Math.max(0, (stopSec - started.t) / started.rate),
        audioUrl: recording.url,
        mimeType: recording.mime,
        startSec: started.t,
        stopSec,
        playbackRate: started.rate,
        pitchTrack: null,
        stats: null,
      }
      if (!appendPerformanceSegment(sessionId, segment)) {
        URL.revokeObjectURL(recording.url)
        return false
      }
      return true
    })
    sealQueueRef.current = task.catch(() => false)
    return task
  }, [appendPerformanceSegment, showToast, song.id])

  const cancelCountIn = useCallback(() => {
    transitionGenerationRef.current += 1
    for (const cancel of tickCancelsRef.current.splice(0)) cancel()
  }, [])

  const claimPlayOperation = useCallback((): number => {
    const operation = ++playOperationSeqRef.current
    playOwnerRef.current = operation
    playIntentRef.current = true
    return operation
  }, [])

  const pauseOwnedPlay = useCallback((operation: number) => {
    if (playOwnerRef.current !== operation) return
    playIntentRef.current = false
    audioEngine.pause()
  }, [])

  const playOperationIsCurrent = useCallback((operation: number): boolean => (
    playOwnerRef.current === operation && playIntentRef.current
  ), [])

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    captureGenerationRef.current += 1
    cancelCountIn()
    transitionShouldResumeRef.current = false
    const stopSec = audioEngine.time
    playIntentRef.current = false
    audioEngine.pause()
    playingRef.current = false
    setPlaying(false)
    shellRef.current?.classList.remove('idle')
    phaseRef.current = 'ended'
    setPhase('ended')

    // 停麦克风并封存 Take（音高分析在回放页按需进行）；录音关着则丢弃采集
    const mic = micRef.current
    const recordingRequested = recOnRef.current
    recOnRef.current = false
    setRecOn(false)
    setCaptureIndicator('idle')
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    setPerformanceStatus(sessionId, 'saving')
    void (async () => {
      try {
        let sealed = true
        try {
          if (recordingRequested) sealed = await sealCurrentCapture(stopSec)
          else await sealQueueRef.current
        } catch (error) {
          sealed = false
          if (mountedRef.current) showToast(`录音分段保存失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const trailing = mic ? await mic.stop() : null
        if (micRef.current === mic) micRef.current = null
        if (trailing) URL.revokeObjectURL(trailing.url)
        if (!mountedRef.current) {
          return
        }
        const hasSegments = (useAppStore.getState().performanceSession?.segments.length ?? 0) > 0
        if (!sealed && !hasSegments) {
          if (setPerformanceStatus(sessionId, 'failed', '录音分段保存失败，本次没有可回放录音。')) go('result')
        } else if (finishPerformance(sessionId, sealed ? undefined : '最后一段保存失败，已保留此前录音。')) {
          go('result')
        }
      } catch (e: unknown) {
        if (!mountedRef.current) return
        const message = e instanceof Error ? e.message : String(e)
        const hasSegments = (useAppStore.getState().performanceSession?.segments.length ?? 0) > 0
        if (hasSegments && finishPerformance(sessionId, `录音保存失败：${message}；已保留此前录音。`)) go('result')
        else if (setPerformanceStatus(sessionId, 'failed', `录音保存失败：${message}`)) go('result')
      }
    })()
  }, [cancelCountIn, finishPerformance, go, sealCurrentCapture, setPerformanceStatus, showToast])

  // 进入即装配：曲谱解析 → 伴奏装入（真实伴奏优先，缺省合成） → 装入主时钟（就绪前由浮层遮罩）
  useEffect(() => {
    let alive = true
    mountedRef.current = true
    const previous = useAppStore.getState()
    const previousUrls = new Set([
      ...(previous.performanceSession?.segments.map((segment) => segment.audioUrl) ?? []),
      ...(previous.performanceSession?.take?.audioUrl ? [previous.performanceSession.take.audioUrl] : []),
      ...(previous.lastTake?.audioUrl ? [previous.lastTake.audioUrl] : []),
    ])
    for (const url of previousUrls) URL.revokeObjectURL(url)
    sessionIdRef.current = beginPerformance(song.id)
    audioEngine.onEnd = finish
    ;(async () => {
      try {
        const { xml: x, timeline: t } = await loadSong(song)
        if (!alive) return
        setXml(x)
        setTimeline(t)
        timelineRef.current = t
        if (timeEl.current) timeEl.current.textContent = `0:00 / ${fmt(t.durationSec)}`
        const { buffer, synthesized } = await loadAccompaniment(song, t)
        if (!alive) return
        await audioEngine.load(buffer)
        if (!alive) return
        requestedRateRef.current = 1
        setTempoRatio(1)
        setSynthesizedAccompaniment(synthesized)
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
      mountedRef.current = false
      captureGenerationRef.current += 1
      cancelCountIn()
      startPendingRef.current = false
      resumePendingRef.current = false
      cancelPendingAccompaniment(song.id)
      audioEngine.onEnd = undefined
      playIntentRef.current = false
      audioEngine.pause()
      clearTimeout(idleTimer.current)
      clearTimeout(toastTimer.current)
      // 中途退出：整个麦克风会话作废（含未封存的录音）
      const mic = micRef.current
      micRef.current = null
      if (mic) mic.release()
      const session = useAppStore.getState().performanceSession
      if (session?.id === sessionIdRef.current && session.status !== 'completed') {
        for (const url of new Set(session.segments.map((segment) => segment.audioUrl))) {
          URL.revokeObjectURL(url)
        }
      }
    }
    // song 由 currentSongId 派生，进入本页才加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 每曲动态背景：有视频素材走 <video> 支路（静音循环），否则 three.js 主题背景
  useEffect(() => {
    if (!song.backgroundVideoUrl) return
    const v = bgVideoRef.current
    if (!v) return
    v.src = assetUrl(song.backgroundVideoUrl)
    v.play().catch(() => {})
    return () => {
      v.pause()
      v.removeAttribute('src')
    }
  }, [song.backgroundVideoUrl])

  // three.js 主题背景：挂载即渲染，伴奏 analyser 驱动呼吸，卸载全量释放（有视频时跳过）。
  // WebGL 上下文创建失败（headless/无 GPU/驱动被禁/上下文数耗尽）时 THREE.WebGLRenderer
  // 构造会 throw——不能让背景拖垮整页（React 无错误边界会白屏，river-flows/birds-poem
  // 无视频曲目在 headless 环境实测白屏复现）。失败降级为纯色/渐变背景（canvas 保持透明）。
  useEffect(() => {
    if (song.backgroundVideoUrl) return
    const canvas = bgCanvasRef.current
    if (!canvas) return
    let scene: LumiereScene | null = null
    try {
      scene = new LumiereScene(canvas, song.accent)
    } catch (e: unknown) {
      console.warn(`[syrinx] 动态背景不可用（WebGL 初始化失败），已降级：${e instanceof Error ? e.message : e}`)
      return
    }
    scene.setAnalyser(audioEngine.analyser)
    const fit = () => {
      const r = canvas.getBoundingClientRect()
      scene.resize(r.width, r.height)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
      scene.dispose()
    }
    // accent 随曲目变化时重建场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.accent])

  // 光标小节回调 → 直写 HUD + 行跟随滚动。回调必须随 ScoreSheet 实例一起挂/摘
  // （传 prop 由 ScoreSheet 挂接）：演奏页侧自己往 scoreRef 挂会错过 StrictMode
  // remount 换出的新实例，HUD 永远停在 -- / --（t_b22f5467 项 3 根因）
  const handleMeasure = useCallback((m: number, total: number) => {
    if (measureEl.current)
      measureEl.current.textContent = `${String(m).padStart(2, '0')} / ${total}`
    // 行跟随：小节变化时把当前行保持视口中部。手动滚谱让位期内不抢滚动；
    // scrollToMeasure 内部会判断行几何，行已在舒适区时滚动量趋近 0
    const now = performance.now()
    if (now < manualUntilRef.current) return
    if (m === lastFollowedMeasureRef.current) return
    lastFollowedMeasureRef.current = m
    scoreRef.current?.scrollToMeasure(m)
  }, [])

  /** 就绪 → 用户手势起奏：恢复音频上下文 + 预开麦克风 + 调度 4 拍节拍音 */
  const beginCountIn = useCallback((target: number, initial: boolean) => {
    const tl = timelineRef.current
    if (!tl) return
    cancelCountIn()
    const generation = transitionGenerationRef.current
    const beat = 60 / (tempoAtTime(tl, target) * audioEngine.rate)
    const t0 = audioEngine.ctxTime + 0.12
    const cancels: (() => void)[] = []
    for (let k = 0; k < COUNT_BEATS; k++) {
      const cancel = audioEngine.scheduleTick(
        t0 + k * beat,
        k === COUNT_BEATS - 1 ? 1174.66 : 880,
        0.09,
        0.22,
      )
      if (typeof cancel === 'function') cancels.push(cancel)
    }
    tickCancelsRef.current = cancels
    countdownRef.current = { t0, beat, target, initial, generation }
    phaseRef.current = 'countdown'
    setPhase('countdown')
    setCountdownRound((round) => round + 1)
  }, [cancelCountIn])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'ready' || startPendingRef.current || tempoPendingRef.current) return
    const tl = timelineRef.current
    if (!tl) return
    startPendingRef.current = true
    const generation = transitionGenerationRef.current
    try {
      await audioEngine.resume()
    } catch {
      startPendingRef.current = false
      if (mountedRef.current) showToast('音频无法启动，请重试')
      return
    }
    if (!mountedRef.current || phaseRef.current !== 'ready' || generation !== transitionGenerationRef.current || tempoPendingRef.current) {
      startPendingRef.current = false
      return
    }
    startPendingRef.current = false
    // 麦克风在倒数期间申请（权限弹窗时间被倒数盖住）；失败不阻断演奏
    void ensureMic().catch(() => {}) // ensureMic reports its current request failure.
    scoreRef.current?.showCursor()
    beginCountIn(audioEngine.time, true)
  }, [beginCountIn, ensureMic, showToast])

  // 倒数：以 ctx.currentTime 为准（与节拍音同源），归零瞬间 play(0)
  useEffect(() => {
    if (phase !== 'countdown') return
    let raf = 0
    let alive = true
    const step = () => {
      const { t0, beat, target, initial, generation } = countdownRef.current
      if (!alive || finishedRef.current || phaseRef.current !== 'countdown' || generation !== transitionGenerationRef.current) return
      const remain = t0 + beat * COUNT_BEATS - audioEngine.ctxTime
      if (remain <= 0) {
        void (async () => {
          if (initial) {
            recOnRef.current = true
            setRecOn(true)
          }
          const playOperation = claimPlayOperation()
          const started = await audioEngine.play(target)
          if (
            !alive
            || phaseRef.current !== 'countdown'
            || generation !== transitionGenerationRef.current
            || !playOperationIsCurrent(playOperation)
          ) {
            if (started) pauseOwnedPlay(playOperation)
            return
          }
          if (!started) {
            playIntentRef.current = false
            phaseRef.current = initial ? 'ready' : 'performing'
            setPhase(initial ? 'ready' : 'performing')
            showToast('伴奏无法开始，请重试')
            return
          }
          if (recOnRef.current && micRef.current && !recStartedRef.current) {
            try {
              await startCapture(false)
            } catch (error) {
              if (
                !alive
                || finishedRef.current
                || phaseRef.current !== 'countdown'
                || generation !== transitionGenerationRef.current
                || !playOperationIsCurrent(playOperation)
              ) {
                pauseOwnedPlay(playOperation)
                return
              }
              recOnRef.current = false
              setRecOn(false)
              showToast(`录音无法开始：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (
            !alive
            || finishedRef.current
            || phaseRef.current !== 'countdown'
            || generation !== transitionGenerationRef.current
            || !playOperationIsCurrent(playOperation)
          ) {
            pauseOwnedPlay(playOperation)
            return
          }
          tickCancelsRef.current = []
          transitionShouldResumeRef.current = false
          phaseRef.current = 'performing'
          playingRef.current = true
          setPlaying(true)
          setPhase('performing')
          // 默认开录；麦克风没就绪时等它就绪后补开。
          const REC_ON_TOAST = '🎙️ 录音已开启，结束后可在回放页查看'
          if (recStartedRef.current) showToast(REC_ON_TOAST)
          else void ensureMic().then((mic) => {
            if (
              mountedRef.current &&
              phaseRef.current === 'performing' &&
              recOnRef.current &&
              micRef.current === mic &&
              !recStartedRef.current
            )
              void startCapture(!playingRef.current).then((capturing) => {
                if (capturing) showToast(REC_ON_TOAST)
              }).catch(() => {})
          }).catch(() => {})
        })()
        return
      }
      if (countEl.current)
        countEl.current.textContent = String(Math.max(1, Math.ceil(remain / beat)))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [claimPlayOperation, countdownRound, ensureMic, pauseOwnedPlay, phase, playOperationIsCurrent, setPerformanceStatus, showToast, startCapture])

  // 演奏主循环：唯一时间源 audioEngine.time → 光标推进 + HUD 直写 + 实时音准 + 结束判定
  useEffect(() => {
    if (phase !== 'performing') return
    let raf = 0
    const step = () => {
      const tl = timelineRef.current
      if (tl) {
        const t = audioEngine.time
        scoreRef.current?.syncToTime(t)
        if (timeEl.current) timeEl.current.textContent = `${fmt(t)} / ${fmt(tl.durationSec)}`
        if (playedEl.current)
          playedEl.current.style.width = `${Math.min(100, (t / tl.durationSec) * 100)}%`
        if (railRef.current) {
          railRef.current.setAttribute('aria-valuenow', String(Math.max(0, Math.min(t, tl.durationSec))))
          railRef.current.setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(tl.durationSec)}`)
        }
        // 实时音高检测：隔帧跑 YIN，与谱面期望音对比后直写 PitchMeter（暂停时冻结显示）
        const mic = micRef.current
        if (mic && playingRef.current) {
          frameIdxRef.current += 1
          if (frameIdxRef.current % LIVE_EVERY === 0) {
            const r = yinDetect(mic.readFrame(), mic.sampleRate())
            const fb = liveTrackerRef.current.update(r ? r.hz : null, noteAt(tl.notes, t))
            pitchMeterRef.current?.update(fb)
          }
        }
        if (t >= Math.min(tl.durationSec + TAIL_GRACE, audioEngine.duration)) {
          finish()
          return
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [phase, finish])

  const toggle = useCallback(() => {
    if (tempoPendingRef.current) return
    if (phaseRef.current === 'ready') {
      void start()
      return
    }
    if (phaseRef.current !== 'performing') return
    if (audioEngine.playing || resumePendingRef.current) {
      playIntentRef.current = false
      resumePendingRef.current = false
      audioEngine.pause()
      void micRef.current?.pauseCapture().catch((error: unknown) => {
        if (mountedRef.current) showToast(`录音暂停失败：${error instanceof Error ? error.message : String(error)}`)
      })
      playingRef.current = false
      setPlaying(false)
      shellRef.current?.classList.remove('idle')
    } else if (!resumePendingRef.current) {
      resumePendingRef.current = true
      const playOperation = claimPlayOperation()
      const generation = transitionGenerationRef.current
      const captureGeneration = captureGenerationRef.current
      const sessionId = sessionIdRef.current
      void (async () => {
        let started = false
        try {
          started = await audioEngine.play()
        } catch {
          // 下方按 started=false 统一保留暂停态并提示
        }
        if (playOwnerRef.current === playOperation) resumePendingRef.current = false
        if (
          !mountedRef.current
          || finishedRef.current
          || phaseRef.current !== 'performing'
          || generation !== transitionGenerationRef.current
          || sessionId !== sessionIdRef.current
          || !playOperationIsCurrent(playOperation)
        ) {
          if (started) pauseOwnedPlay(playOperation)
          return
        }
        if (!started) {
          playIntentRef.current = false
          showToast('伴奏无法继续，请重试')
          return
        }
        const mic = micRef.current
        if (recOnRef.current && mic) {
          try {
            if (recStartedRef.current) await resumeCapture()
            else await startCapture(false)
          } catch (error) {
            if (
              !mountedRef.current
              || finishedRef.current
              || phaseRef.current !== 'performing'
              || generation !== transitionGenerationRef.current
              || sessionId !== sessionIdRef.current
              || !playOperationIsCurrent(playOperation)
            ) {
              pauseOwnedPlay(playOperation)
              return
            }
            if (captureGeneration === captureGenerationRef.current) {
              recOnRef.current = false
              setRecOn(false)
              showToast(`录音无法继续：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        if (
          !mountedRef.current
          || finishedRef.current
          || phaseRef.current !== 'performing'
          || generation !== transitionGenerationRef.current
          || sessionId !== sessionIdRef.current
          || !playOperationIsCurrent(playOperation)
        ) {
          pauseOwnedPlay(playOperation)
          return
        }
        scoreRef.current?.selectMeasure(null)
        playingRef.current = true
        setPlaying(true)
        wake()
      })()
    }
  }, [claimPlayOperation, pauseOwnedPlay, playOperationIsCurrent, resumeCapture, showToast, start, startCapture, wake])

  /** 停止演奏：走与自然结束相同的 finish() 封存流程（伴奏停在点击时刻、
   *  Take.durationSec 截断为该时刻，回放页按截断口径统计与播放） */
  const stop = useCallback(() => {
    if (phaseRef.current !== 'performing' && phaseRef.current !== 'countdown') return
    finish()
  }, [finish])

  const positionTransport = useCallback((time: number, measure?: number) => {
    const tl = timelineRef.current
    if (!tl) return
    const clamped = Math.max(0, Math.min(time, tl.durationSec))
    audioEngine.seek(clamped)
    scoreRef.current?.resetCursor()
    scoreRef.current?.syncToTime(clamped)
    if (measure !== undefined) scoreRef.current?.selectMeasure(measure)
    liveTrackerRef.current.reset()
    pitchMeterRef.current?.reset()
    if (timeEl.current) timeEl.current.textContent = `${fmt(clamped)} / ${fmt(tl.durationSec)}`
    if (playedEl.current) playedEl.current.style.width = `${Math.min(100, (clamped / tl.durationSec) * 100)}%`
    if (railRef.current) {
      railRef.current.setAttribute('aria-valuenow', String(clamped))
      railRef.current.setAttribute('aria-valuetext', `${fmt(clamped)} / ${fmt(tl.durationSec)}`)
    }
  }, [])

  /** 单次跳转事务：播放中先封段，再定位、倒数并续录；暂停/就绪只定位。 */
  const seekTo = useCallback((t: number, measure?: number, nextRate?: number) => {
      const currentPhase = phaseRef.current
      if (!['ready', 'performing', 'countdown'].includes(currentPhase)) return
      const tl = timelineRef.current
      if (!tl) return
      if (nextRate !== undefined) requestedRateRef.current = nextRate
      const prepareRate = nextRate !== undefined || tempoPendingRef.current
      const desiredRate = requestedRateRef.current
      const clamped = Math.max(0, Math.min(t, tl.durationSec))
      if (currentPhase === 'ready' && !prepareRate) {
        positionTransport(clamped, measure)
        playingRef.current = false
        setPlaying(false)
        wake()
        return
      }
      const resumeAfter = audioEngine.playing
        || (currentPhase === 'countdown' && !countdownRef.current.initial)
        || transitionShouldResumeRef.current
      const initialCountdown = currentPhase === 'countdown' && countdownRef.current.initial
      transitionShouldResumeRef.current = resumeAfter
      captureGenerationRef.current += 1
      cancelCountIn()
      const generation = transitionGenerationRef.current
      playIntentRef.current = false
      audioEngine.pause()
      const captureStop = audioEngine.time
      playingRef.current = false
      setPlaying(false)
      shellRef.current?.classList.remove('idle')
      if (prepareRate) {
        tempoPendingRef.current = true
        setTempoPending(true)
      }
      void (async () => {
        try {
          if (recOnRef.current) await sealCurrentCapture(captureStop)
          else await sealQueueRef.current
          if (!mountedRef.current || finishedRef.current || generation !== transitionGenerationRef.current) return
          if (prepareRate) {
            const changed = await audioEngine.setRate(desiredRate)
            if (!mountedRef.current || finishedRef.current || generation !== transitionGenerationRef.current) return
            if (!changed) throw new Error('当前浏览器无法完成保调变速，请重试或还原推荐速度')
            setTempoRatio(audioEngine.rate)
            tempoPendingRef.current = false
            setTempoPending(false)
          }
        } catch (error) {
          if (mountedRef.current && generation === transitionGenerationRef.current) {
            recOnRef.current = false
            setRecOn(false)
            requestedRateRef.current = audioEngine.rate
            setTempoRatio(audioEngine.rate)
            tempoPendingRef.current = false
            setTempoPending(false)
            transitionShouldResumeRef.current = false
            const stoppedPhase = currentPhase === 'ready' ? 'ready' : 'performing'
            phaseRef.current = stoppedPhase
            setPhase(stoppedPhase)
            showToast(`未能继续：${error instanceof Error ? error.message : String(error)}`)
          }
          return
        }
        if (!mountedRef.current || finishedRef.current || generation !== transitionGenerationRef.current) return
        positionTransport(clamped, measure)
        if (currentPhase === 'ready') {
          phaseRef.current = 'ready'
          setPhase('ready')
        } else if (resumeAfter || initialCountdown) beginCountIn(clamped, initialCountdown)
        else {
          transitionShouldResumeRef.current = false
          phaseRef.current = 'performing'
          setPhase('performing')
          showToast('已定位，播放时从这里继续')
        }
        wake()
      })()
    }, [beginCountIn, cancelCountIn, positionTransport, sealCurrentCapture, showToast, wake])

  const changeTempo = useCallback((bpm: number) => {
    const recommended = timelineRef.current?.tempo
    if (!recommended || !Number.isInteger(bpm)) return
    const rate = bpm === Math.round(recommended) ? 1 : bpm / recommended
    if (rate < 0.5 || rate > 1.5 || rate === audioEngine.rate) return
    seekTo(audioEngine.time, undefined, rate)
  }, [seekTo])

  const restart = useCallback(() => {
    const first = timelineRef.current?.measureTimes.find((item) => !item.end)
    seekTo(0, first?.measure)
  }, [seekTo])

  // 进度轨点击/拖拽：移动只预览，pointer-up 才提交一次分段跳转。
  const onRailDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (phaseRef.current !== 'performing') return
      const tl = timelineRef.current
      const rail = railRef.current
      if (!tl || !rail) return
      e.currentTarget.setPointerCapture(e.pointerId)
      let pendingX = e.clientX
      const timeFromX = (clientX: number) => {
        const rect = rail.getBoundingClientRect()
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        return ratio * tl.durationSec
      }
      const move = (ev: PointerEvent) => {
        pendingX = ev.clientX
        const preview = timeFromX(pendingX)
        if (playedEl.current) playedEl.current.style.width = `${(preview / tl.durationSec) * 100}%`
        rail.setAttribute('aria-valuenow', String(preview))
        rail.setAttribute('aria-valuetext', `${fmt(preview)} / ${fmt(tl.durationSec)}`)
      }
      const cleanup = () => {
        rail.removeEventListener('pointermove', move)
        rail.removeEventListener('pointerup', up)
        rail.removeEventListener('pointercancel', cancel)
      }
      const up = (event: PointerEvent) => {
        pendingX = event.clientX
        cleanup()
        const target = timeFromX(pendingX)
        const anchor = [...tl.measureTimes].reverse().find((item) => !item.end && item.time <= target)
        seekTo(target, anchor?.measure)
      }
      const cancel = () => {
        cleanup()
        if (playedEl.current) playedEl.current.style.width = `${Math.min(100, (audioEngine.time / tl.durationSec) * 100)}%`
        rail.setAttribute('aria-valuenow', String(Math.max(0, Math.min(audioEngine.time, tl.durationSec))))
        rail.setAttribute('aria-valuetext', `${fmt(audioEngine.time)} / ${fmt(tl.durationSec)}`)
      }
      rail.addEventListener('pointermove', move)
      rail.addEventListener('pointerup', up)
      rail.addEventListener('pointercancel', cancel)
    },
    [seekTo],
  )

  const onRailKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const tl = timelineRef.current
    if (!tl) return
    const step = Math.max(0.1, tl.durationSec / 100)
    let target: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = audioEngine.time - step
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = audioEngine.time + step
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = tl.durationSec
    if (target === null) return
    event.preventDefault()
    const clamped = Math.max(0, Math.min(target, tl.durationSec))
    const anchor = [...tl.measureTimes].reverse().find((item) => !item.end && item.time <= clamped)
    seekTo(clamped, anchor?.measure)
  }, [seekTo])

  /** 录音开关：关闭时封存当前段；再次开启从当前谱面时间建立新段。 */
  const toggleRec = useCallback(() => {
    if (tempoPendingRef.current) return
    if (phaseRef.current !== 'performing') return
    const next = !recOnRef.current
    const captureGeneration = ++captureGenerationRef.current
    recOnRef.current = next
    setRecOn(next)
    if (!next) {
      void sealCurrentCapture(audioEngine.time).then((retained) => {
        if (mountedRef.current && captureGenerationRef.current === captureGeneration) {
          showToast(retained ? '录音已关闭，当前段已保留' : '录音已关闭，但当前段未能保存')
        }
      }).catch((error: unknown) => {
        if (mountedRef.current && captureGenerationRef.current === captureGeneration) {
          showToast(`录音分段保存失败：${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } else {
      void startCapture(!audioEngine.playing).then((capturing) => {
        if (capturing) return
        if (
          !mountedRef.current
          || !recOnRef.current
          || captureGenerationRef.current !== captureGeneration
        ) return
        showToast('麦克风不可用，无法录音')
        recOnRef.current = false
        setRecOn(false)
      }).catch((error: unknown) => {
        if (
          !mountedRef.current
          || !recOnRef.current
          || captureGenerationRef.current !== captureGeneration
        ) return
        showToast(`录音无法开始：${error instanceof Error ? error.message : String(error)}`)
        recOnRef.current = false
        setRecOn(false)
      })
    }
  }, [sealCurrentCapture, startCapture, showToast])

  /** ✕/顶栏返回/Esc 共用出口（t_c10d648d）：演奏中（含倒数）用户以为 ✕ 是
   *  「停止」，直接回曲库会丢掉整段演奏——改与 ■ 同语义走 finish() 封存进回放；
   *  非演奏状态（loading/ready/ended/error）没有可封存的 Take，保持回曲库 */
  const exit = useCallback(() => {
    if (phaseRef.current === 'performing' || phaseRef.current === 'countdown') finish()
    else go('home')
  }, [finish, go])

  // 键盘：空格 播放/暂停，Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (e.code === 'Space') {
        if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, button, [contenteditable="true"]')) return
        e.preventDefault()
        toggle()
      } else if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault()
        exit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, exit])

  // 键盘、辅助技术 click 与 pointer 事件不一定伴随 mouse/touch 兼容事件。
  // 捕获阶段先唤醒控件，避免 idle 的 pointer-events:none 让第一下交互无反馈。
  useEffect(() => {
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'touchstart', 'wheel', 'pointerdown', 'click', 'keydown', 'focusin']
    events.forEach((e) => window.addEventListener(e, wake, { passive: true, capture: true }))
    return () => events.forEach((e) => window.removeEventListener(e, wake, { capture: true }))
  }, [wake])

  const changeVolume = (v: number) => {
    setVolume(v)
    audioEngine.setVolume(v)
  }

  /** 停止演奏：封存本段 Take 并进入回放（光标数据源切换按钮已删，9/8） */
  return (
    <div
      className="perform"
      ref={shellRef}
      style={{ '--song-accent': song.accent } as React.CSSProperties}
    >
      <canvas className="perform-bg" ref={bgCanvasRef} aria-hidden="true" />
      {/* playOnce 曲目：模糊垫底层（cover 铺满 + blur），contain 主视频的留边透出模糊画面而非纯色 */}
      {song.backgroundVideoUrl && song.playOnce && (
        <video
          className="perform-bg perform-bg-blur"
          src={assetUrl(song.backgroundVideoUrl)}
          muted
          loop={false}
          playsInline
          autoPlay
          aria-hidden="true"
        />
      )}
      <video
        className={`perform-bg${song.backgroundFit === 'cover' ? ' perform-bg-cover' : ''}`}
        ref={bgVideoRef}
        muted
        loop={!song.playOnce}
        playsInline
        autoPlay
        aria-hidden="true"
        style={{ display: song.backgroundVideoUrl ? 'block' : 'none', background: song.playOnce || song.backgroundFit === 'cover' ? undefined : song.backgroundPadColor }}
      />
      <header className="perform-hud hud-top">
        <div className="hud-song">
          <button className="back-ghost" onClick={exit} aria-label="返回曲库">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="hud-song-text">
            <b>{song.title}</b>
            <span>{song.composer}</span>
          </div>
        </div>
        <div className="hud-stats">
          <div className="hud-stat">
            <span>小节</span>
            <span className="num" ref={measureEl}>
              -- / --
            </span>
          </div>
          <div className="hud-stat">
            <span>时间</span>
            <span className="num" ref={timeEl}>
              0:00 / 0:00
            </span>
          </div>
        </div>
      </header>

      {phase === 'ready' && (
        <div className="perform-ready">
          <div>
            <span>点击小节选择起点，准备好后开始</span>
            {synthesizedAccompaniment && <small role="status">
              {song.accompanimentUrl ? '原始伴奏暂不可用，已准备合成伴奏。' : '已准备合成伴奏。'}
            </small>}
          </div>
          <button className="ov-start" onClick={() => void start()}>▶ 开始演奏</button>
        </div>
      )}
      <div className="perform-stage">
        {xml && timeline && (
          <ScoreSheet
            xml={xml}
            timeline={timeline}
            accent={song.accent}
            scoreRef={scoreRef}
            onMeasureChange={handleMeasure}
            onMeasureSelect={(measure, time) => seekTo(time, measure)}
            zoom={0.85}
            autoScroll={false}
            autoShowCursor={phase === 'performing' || phase === 'countdown'}
          />
        )}
      </div>

      <div
        className="progress-rail"
        ref={railRef}
        role="slider"
        aria-label="演奏进度"
        aria-valuemin={0}
        aria-valuemax={timeline?.durationSec ?? 0}
        aria-valuenow={Math.max(0, Math.min(audioEngine.time, timeline?.durationSec ?? 0))}
        aria-valuetext={`${fmt(audioEngine.time)} / ${fmt(timeline?.durationSec ?? 0)}`}
        tabIndex={0}
        onPointerDown={onRailDown}
        onKeyDown={onRailKeyDown}
      >
        <span className="played" ref={playedEl} />
      </div>

      <PitchMeter handleRef={pitchMeterRef} />

      <div className="perform-hud hud-bottom">
        <ControlBar
          playing={playing}
          ended={phase === 'ended'}
          active={phase === 'performing' || phase === 'countdown'}
          recOn={recOn}
          captureIndicator={captureIndicator}
          volume={volume}
          bpm={Math.round((timeline?.tempo ?? song.bpm) * tempoRatio)}
          recommendedBpm={timeline?.tempo ?? song.bpm}
          tempoDisabled={phase === 'loading' || phase === 'error' || phase === 'ended'}
          tempoPending={tempoPending}
          onTempo={changeTempo}
          onToggle={toggle}
          onRecToggle={toggleRec}
          onRestart={restart}
          onStop={stop}
          onVolume={changeVolume}
          onExit={exit}
        />
      </div>

      {phase === 'loading' && (
        <div className="perform-overlay" role="status" aria-label="正在准备">
          <div className="ov-card">
            <div className="ov-glyph">𝄞</div>
            <div className="ov-title">正在准备伴奏…</div>
            <div className="ov-sub">正在准备曲谱与伴奏，请稍候</div>
            <div className="ov-bar">
              <i />
            </div>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="perform-overlay" role="alert">
          <div className="ov-card">
            <div className="ov-title">演奏准备失败</div>
            <div className="ov-sub err">{errorMsg}</div>
            <button className="ov-btn" onClick={exit}>
              返回预览
            </button>
          </div>
        </div>
      )}

      {phase === 'countdown' && (
        <div className="perform-overlay countdown" aria-hidden="true">
          <div className="count-num" ref={countEl}>
            {COUNT_BEATS}
          </div>
          <div className="count-label">跟上节拍</div>
        </div>
      )}

      {phase === 'ended' && (
        <div className="perform-overlay">
          <div className="ov-card">
            <div className="ov-title big">演奏完成 ♪</div>
            <div className="ov-sub">正在前往回放…</div>
          </div>
        </div>
      )}

      {toast && (
        <div className="perform-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

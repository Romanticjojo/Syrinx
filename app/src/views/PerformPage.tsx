import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { openMic, type MicSession } from '../audio/recorder'
import { loadAccompaniment, cancelPendingAccompaniment } from '../audio/accompaniment'
import { LumiereScene } from '../background/LumiereScene'
import ControlBar from '../components/ControlBar'
import PitchMeter, { type PitchMeterHandle } from '../components/PitchMeter'
import { noteAt } from '../pitch/compare'
import { LivePitchTracker } from '../pitch/live'
import { yinDetect } from '../pitch/yin'
import ScoreSheet from '../components/ScoreSheet'
import type { OSMDScore } from '../score/OSMDScore'
import { getSong, loadSong, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { useAppStore } from '../store'
import { savePractice } from '../practice/history'
import { practiceRange, songVersion, scoredNotesKey, SCORING_VERSION, type PracticeConfig } from '../practice/model'
import type { Take, Timeline } from '../types'
import './PerformPage.css'

/**
 * 页内阶段机：加载 → 就绪 → 倒数 → 演奏（含暂停）→ 结束。
 * 高频数据（当前时间/小节/进度/实时音准）由 rAF 直写 DOM，不进 store（已定决策 5）。
 */
type Phase = 'loading' | 'ready' | 'countdown' | 'performing' | 'saving' | 'ended' | 'error'

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
}

export default function PerformPage() {
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const beginPerformance = useAppStore((s) => s.beginPerformance)
  const setPerformanceStatus = useAppStore((s) => s.setPerformanceStatus)
  const completePerformance = useAppStore((s) => s.completePerformance)
  const requestedConfig = useAppStore((s) => s.practiceConfig)
  const configRef = useRef<PracticeConfig | null>(null)
  const versionRef = useRef('')
  const groupRef = useRef('')
  const roundRef = useRef(1)
  const [round, setRound] = useState(1)
  const recChoiceRef = useRef(true)
  const countdownNextRef = useRef<() => void>(() => {})
  const song = getSong(songId) ?? SONGS[0]

  const [phase, setPhase] = useState<Phase>('loading')
  const [playing, setPlaying] = useState(false)
  const [recOn, setRecOn] = useState(false)
  // 初值读引擎实际增益（t_5957a725）：audioEngine 全局单例，回放页「对照伴奏」
  // 拖过的音量跨页留存——写死 1 会显示假满格而实际 gain=0，背景伴奏无声
  const [volume, setVolume] = useState(() => audioEngine.getVolume())
  const [errorMsg, setErrorMsg] = useState('')
  const [xml, setXml] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [synthesizedAccompaniment, setSynthesizedAccompaniment] = useState(false)

  // rAF 循环用的 ref 镜像（避开闭包过期）
  const timelineRef = useRef<Timeline | null>(null)
  const phaseRef = useRef<Phase>('loading')
  const playingRef = useRef(false)
  const finishedRef = useRef(false)
  const mountedRef = useRef(true)
  const sessionIdRef = useRef<string | null>(null)
  const startPendingRef = useRef(false)
  const resumePendingRef = useRef(false)
  const countdownRef = useRef({ t0: 0, beat: 0.7 })
  const idleTimer = useRef(0)
  const toastTimer = useRef(0)

  // 麦克风会话（实时音高反馈 + 采集两条支路）与录音开关镜像
  const micRef = useRef<MicSession | null>(null)
  const micOpeningRef = useRef<Promise<MicSession> | null>(null)
  const recOnRef = useRef(false)
  const recStartedRef = useRef<CaptureStart | null>(null)
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
      if (playingRef.current && shellRef.current) shellRef.current.classList.add('idle')
    }, IDLE_MS)
  }, [])

  /** 轻提示（麦克风不可用等降级场景），3 秒自动消失 */
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  /** 确保麦克风会话存在（只开一次；实时音准反馈不受录音开关影响） */
  const ensureMic = useCallback((): Promise<MicSession> => {
    if (micRef.current) return Promise.resolve(micRef.current)
    if (!micOpeningRef.current) {
      const sessionId = sessionIdRef.current
      const opening = openMic(audioEngine.audioCtx).then((mic) => {
        if (!mountedRef.current || sessionId !== sessionIdRef.current || finishedRef.current) {
          mic.release()
          throw new Error('麦克风请求已取消')
        }
        micRef.current = mic
        return mic
      }).finally(() => {
        if (micOpeningRef.current === opening) micOpeningRef.current = null
      })
      micOpeningRef.current = opening
    }
    return micOpeningRef.current
  }, [])

  /** 开一段新采集（丢弃旧段）；paused=true 时新采集立即暂停（跟伴奏暂停态对齐） */
  const startCapture = useCallback((tSec: number, paused: boolean): boolean => {
    const mic = micRef.current
    if (!mic) return false
    mic.restartCapture()
    if (paused) mic.pauseCapture()
    recStartedRef.current = { t: tSec, wall: Date.now() }
    return true
  }, [])

  const finish = useCallback((automatic = false, expectedSession = sessionIdRef.current) => {
    const sessionId = sessionIdRef.current
    if (!sessionId || sessionId !== expectedSession || finishedRef.current) return
    finishedRef.current = true
    const stopSec = audioEngine.time // Keep actual boundary overshoot in capture metadata.
    audioEngine.pause()
    const mic = micRef.current
    mic?.pauseCapture()
    micRef.current = null
    micOpeningRef.current = null
    playingRef.current = false
    setPlaying(false)
    phaseRef.current = 'saving'
    setPhase('saving')
    shellRef.current?.classList.remove('idle')
    const config = configRef.current
    if (config) audioEngine.seek(Math.min(stopSec, config.range.stopSec))
    const started = recStartedRef.current
    recStartedRef.current = null
    const recordingRequested = recOnRef.current
    const discard = !recordingRequested || !started
    recOnRef.current = false
    setRecOn(false)
    setPerformanceStatus(sessionId, 'saving')
    const current = () => mountedRef.current && sessionIdRef.current === sessionId && useAppStore.getState().performanceSession?.id === sessionId
    void (async () => {
      let take: Take | null = null
      let storageError: string | null = null
      try {
        const recording = mic ? await mic.stop() : null
        if (!current()) {
          if (recording) URL.revokeObjectURL(recording.url)
          return
        }
        if (!discard && recording && started) {
          if (recording.silent) showToast('录音电平接近 0，请检查麦克风/系统输入设备')
          take = {
            sessionId, songId: song.id, startedAt: started.wall,
            durationSec: Math.max(0, stopSec - started.t), audioUrl: recording.url,
            audioBlob: recording.blob, mimeType: recording.mime,
            startSec: started.t, stopSec, pitchTrack: null, stats: null,
            practice: {
              songVersion: versionRef.current, scoringVersion: SCORING_VERSION,
              range: config?.range ?? null, groupId: groupRef.current,
              round: roundRef.current, rounds: config?.rounds ?? 1,
              scoredNotesKey: scoredNotesKey(timelineRef.current!, started.t, stopSec),
            },
          }
          // Old in-memory R1 Takes have no Blob; all real recorder results do.
          if (recording.blob) {
            try { await savePractice(take, recording.blob) }
            catch (error) { storageError = `录音未保存：${error instanceof Error ? error.message : String(error)}。请先下载录音再离开。` }
          }
          if (!current()) { URL.revokeObjectURL(take.audioUrl); return }
          if (!completePerformance(sessionId, take)) { URL.revokeObjectURL(take.audioUrl); return }
          if (storageError) useAppStore.setState({ storageError })
        } else {
          if (recording) URL.revokeObjectURL(recording.url)
          setPerformanceStatus(sessionId, 'no-recording', recordingRequested ? '麦克风不可用，本次演奏没有录音。' : '本次演奏未开启录音。')
        }
        if (automatic && !storageError && config && roundRef.current < config.rounds) {
          roundRef.current += 1
          setRound(roundRef.current)
          sessionIdRef.current = beginPerformance(song.id)
          finishedRef.current = false
          startPendingRef.current = false
          resumePendingRef.current = false
          countdownNextRef.current()
        } else {
          phaseRef.current = 'ended'
          setPhase('ended')
          go('result')
        }
      } catch (error) {
        if (!current()) return
        const message = error instanceof Error ? error.message : String(error)
        setPerformanceStatus(sessionId, discard ? 'no-recording' : 'failed', discard ? '本次演奏未开启录音。' : `录音保存失败：${message}`)
        go('result')
      }
    })()
  }, [beginPerformance, completePerformance, go, setPerformanceStatus, showToast, song.id])

  // 进入即装配：曲谱解析 → 伴奏装入（真实伴奏优先，缺省合成） → 装入主时钟（就绪前由浮层遮罩）
  useEffect(() => {
    let alive = true
    mountedRef.current = true
    sessionIdRef.current = beginPerformance(song.id)
    groupRef.current = sessionIdRef.current
    const firstSession = sessionIdRef.current
    audioEngine.onEnd = () => finish(true, firstSession)
    ;(async () => {
      try {
        const { xml: x, timeline: t } = await loadSong(song)
        if (!alive) return
        setXml(x)
        setTimeline(t)
        timelineRef.current = t
        versionRef.current = songVersion(x, t)
        if (requestedConfig?.songId === song.id) {
          const range = practiceRange(t, requestedConfig.range.startMeasure, requestedConfig.range.endMeasure)
          if (!range || requestedConfig.rounds < 1 || requestedConfig.rounds > 5 || !Number.isInteger(requestedConfig.rounds)) throw new Error('练习区间不可用，请返回预览重新选择。')
          configRef.current = { ...requestedConfig, range }
        }
        if (timeEl.current) timeEl.current.textContent = `0:00 / ${fmt(t.durationSec)}`
        const { buffer, synthesized } = await loadAccompaniment(song, t)
        if (!alive) return
        await audioEngine.load(buffer)
        if (!alive) return
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
      sessionIdRef.current = null
      startPendingRef.current = false
      resumePendingRef.current = false
      cancelPendingAccompaniment(song.id)
      audioEngine.onEnd = undefined
      audioEngine.pause()
      clearTimeout(idleTimer.current)
      clearTimeout(toastTimer.current)
      // 中途退出：整个麦克风会话作废（含未封存的录音）
      const mic = micRef.current
      micRef.current = null
      if (mic) mic.release()
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

  const scheduleCountdown = useCallback(() => {
    const tl = timelineRef.current
    if (!tl) return
    const sessionId = sessionIdRef.current
    audioEngine.onEnd = () => { if (phaseRef.current === 'performing') finish(true, sessionId) }
    phaseRef.current = 'countdown'
    // 麦克风在倒数期间申请（权限弹窗时间被倒数盖住）；失败不阻断演奏
    ensureMic().catch(() => {
      if (mountedRef.current && sessionIdRef.current === sessionId) showToast('麦克风不可用，实时音准与录音不可用')
    })
    scoreRef.current?.resetCursor()
    scoreRef.current?.showCursor()
    liveTrackerRef.current.reset()
    pitchMeterRef.current?.reset()
    lastFollowedMeasureRef.current = 0
    const beat = 60 / tl.tempo
    const t0 = audioEngine.ctxTime + 0.12
    for (let k = 0; k < COUNT_BEATS; k++) {
      // 末拍高八度，提示即将起奏
      audioEngine.scheduleTick(t0 + k * beat, k === COUNT_BEATS - 1 ? 1174.66 : 880, 0.09, 0.22)
    }
    countdownRef.current = { t0, beat }
    setPhase('countdown')
  }, [ensureMic, finish, showToast])
  countdownNextRef.current = scheduleCountdown

  /** 就绪 → 用户手势起奏：恢复音频上下文 + 预开麦克风 + 调度 4 拍节拍音 */
  const start = useCallback(async () => {
    if (phaseRef.current !== 'ready' || startPendingRef.current) return
    const tl = timelineRef.current
    if (!tl) return
    startPendingRef.current = true
    try {
      await audioEngine.resume()
    } catch {
      startPendingRef.current = false
      if (mountedRef.current) showToast('音频无法启动，请重试')
      return
    }
    if (!mountedRef.current || phaseRef.current !== 'ready') {
      startPendingRef.current = false
      return
    }
    startPendingRef.current = false
    countdownNextRef.current()
  }, [showToast])

  // 倒数：以 ctx.currentTime 为准（与节拍音同源），归零瞬间 play(0)
  useEffect(() => {
    if (phase !== 'countdown') return
    let raf = 0
    let alive = true
    const step = () => {
      const { t0, beat } = countdownRef.current
      const remain = t0 + beat * COUNT_BEATS - audioEngine.ctxTime
      if (remain <= 0) {
        void (async () => {
          const started = await audioEngine.play(configRef.current?.range.startSec ?? 0)
          if (!alive || phaseRef.current !== 'countdown') return
          if (!started) {
            phaseRef.current = 'ready'
            setPhase('ready')
            showToast('伴奏无法开始，请重试')
            return
          }
          phaseRef.current = 'performing'
          playingRef.current = true
          setPlaying(true)
          setPhase('performing')
          // 默认开录（录音开着才封存 Take）；麦克风没就绪时等它就绪后补开。
          const REC_ON_TOAST = '🎙️ 录音已开启，结束后可在回放页查看'
          recOnRef.current = recChoiceRef.current
          setRecOn(recChoiceRef.current)
          const sessionId = sessionIdRef.current
          if (sessionId) setPerformanceStatus(sessionId, 'recording')
          if (!recOnRef.current) return
          if (micRef.current && startCapture(audioEngine.time, false)) showToast(REC_ON_TOAST)
          else void ensureMic().then((mic) => {
            if (
              mountedRef.current &&
              sessionIdRef.current === sessionId &&
              phaseRef.current === 'performing' &&
              recOnRef.current &&
              micRef.current === mic &&
              !recStartedRef.current
            )
              if (startCapture(audioEngine.time, !playingRef.current)) showToast(REC_ON_TOAST)
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
  }, [phase, ensureMic, setPerformanceStatus, showToast, startCapture])

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
        if (t >= (configRef.current?.range.stopSec ?? Math.min(tl.durationSec + TAIL_GRACE, audioEngine.duration))) {
          finish(true)
          return
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [phase, finish])

  const toggle = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    if (audioEngine.playing) {
      audioEngine.pause()
      micRef.current?.pauseCapture() // 采集随伴奏暂停，时间轴保持对齐
      playingRef.current = false
      setPlaying(false)
      shellRef.current?.classList.remove('idle')
    } else if (!resumePendingRef.current) {
      resumePendingRef.current = true
      const sessionId = sessionIdRef.current
      void (async () => {
        let started = false
        try {
          started = await audioEngine.play()
        } catch {
          // 下方按 started=false 统一保留暂停态并提示
        }
        if (sessionIdRef.current !== sessionId) return
        resumePendingRef.current = false
        if (!mountedRef.current || finishedRef.current || phaseRef.current !== 'performing') return
        if (!started) {
          showToast('伴奏无法继续，请重试')
          return
        }
        const mic = micRef.current
        if (recOnRef.current && mic) {
          if (recStartedRef.current) mic.resumeCapture()
          else startCapture(audioEngine.time, false)
        }
        playingRef.current = true
        setPlaying(true)
        wake()
      })()
    }
  }, [showToast, startCapture, wake])

  /** 停止演奏：走与自然结束相同的 finish() 封存流程（伴奏停在点击时刻、
   *  Take.durationSec 截断为该时刻，回放页按截断口径统计与播放） */
  const stop = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    finish()
  }, [finish])

  /** 回开头：seek 0 + 光标 reset + 录音开着则丢弃旧段重录（录音起点回到 0） */
  const restart = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    const startSec = configRef.current?.range.startSec ?? 0
    audioEngine.seek(startSec)
    scoreRef.current?.resetCursor()
    liveTrackerRef.current.reset()
    pitchMeterRef.current?.reset()
    if (recOnRef.current) {
      startCapture(startSec, !audioEngine.playing)
      showToast('已回开头，重新录音')
    }
    const p = audioEngine.playing
    playingRef.current = p
    setPlaying(p)
    wake()
  }, [wake, startCapture, showToast])

  /** 跳转到伴奏时间 t（t_b22f5467 项 4）：
   *  - OSMD 光标只前进：先 resetCursor，下一帧 syncToTime 从头快进到新位置
   *  - 当前 Take 作废重开（与「回开头重录」同语义）：录音起点跟到新位置 */
  const seekTo = useCallback(
    (t: number) => {
      if (phaseRef.current !== 'performing') return
      const tl = timelineRef.current
      if (!tl) return
      const lower = configRef.current?.range.startSec ?? 0
      const stop = Math.min(configRef.current?.range.stopSec ?? tl.durationSec, audioEngine.duration)
      // AudioEngine.play(buffer.duration) wraps to zero; seek inside the final instant.
      const upper = Math.max(lower, stop - Math.min(0.001, (stop - lower) / 2))
      const clamped = Math.max(lower, Math.min(t, upper))
      audioEngine.seek(clamped)
      scoreRef.current?.resetCursor()
      liveTrackerRef.current.reset()
      pitchMeterRef.current?.reset()
      if (recOnRef.current) {
        startCapture(clamped, !audioEngine.playing)
        showToast('已跳转，本段重新录音')
      }
      playingRef.current = audioEngine.playing
      setPlaying(audioEngine.playing)
      wake()
    },
    [startCapture, showToast, wake],
  )

  // 进度轨点击/拖拽：rAF 节流，拖拽全程每帧至多 seek 一次
  const railRef = useRef<HTMLDivElement>(null)
  const railRafRef = useRef(0)
  const onRailDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (phaseRef.current !== 'performing') return
      const tl = timelineRef.current
      const rail = railRef.current
      if (!tl || !rail) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const seekFromX = (clientX: number) => {
        const rect = rail.getBoundingClientRect()
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        seekTo(ratio * tl.durationSec)
      }
      seekFromX(e.clientX)
      const move = (ev: PointerEvent) => {
        cancelAnimationFrame(railRafRef.current)
        railRafRef.current = requestAnimationFrame(() => seekFromX(ev.clientX))
      }
      const up = () => {
        cancelAnimationFrame(railRafRef.current)
        rail.removeEventListener('pointermove', move)
        rail.removeEventListener('pointerup', up)
        rail.removeEventListener('pointercancel', up)
      }
      rail.addEventListener('pointermove', move)
      rail.addEventListener('pointerup', up)
      rail.addEventListener('pointercancel', up)
    },
    [seekTo],
  )

  /** 录音开关：只控采集支路，实时音准反馈不受影响；关=丢当前段，开=从头录这段 */
  const toggleRec = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    const next = !recOnRef.current
    recChoiceRef.current = next
    recOnRef.current = next
    setRecOn(next)
    if (!next) {
      micRef.current?.discardCapture()
      recStartedRef.current = null
      showToast('录音已关闭')
    } else if (!startCapture(audioEngine.time, !audioEngine.playing)) {
      showToast('麦克风不可用，无法录音')
      recOnRef.current = false
      setRecOn(false)
    }
  }, [startCapture, showToast])

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
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.code === 'Escape') {
        exit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, exit])

  // 沉浸控件：任意交互唤醒，静置隐藏
  useEffect(() => {
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'touchstart', 'wheel']
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, wake))
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
            {configRef.current && <span className="loop-progress" role="status">第 {round} / {configRef.current.rounds} 轮 · 第 {configRef.current.range.startMeasure}–{configRef.current.range.endMeasure} 小节{phase === 'performing' && !recOn && ' · 听练（无录音）'}</span>}
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

      <div className="perform-stage">
        {xml && timeline && (
          <ScoreSheet
            xml={xml}
            timeline={timeline}
            accent={song.accent}
            scoreRef={scoreRef}
            onMeasureChange={handleMeasure}
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
        onPointerDown={onRailDown}
      >
        <span className="played" ref={playedEl} />
      </div>

      <PitchMeter handleRef={pitchMeterRef} />

      <div className="perform-hud hud-bottom">
        <ControlBar
          playing={playing}
          ended={phase === 'ended'}
          active={phase === 'performing'}
          recOn={recOn}
          volume={volume}
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

      {phase === 'ready' && (
        <div className="perform-overlay">
          <div className="ov-card">
            <div className="ov-kicker">{song.tags.join(' · ')}</div>
            <h2 className="ov-title big">{song.title}</h2>
            <div className="ov-sub">
              {song.composer} · {song.bpm} BPM · {song.durationLabel}
            </div>
            {synthesizedAccompaniment && <div className="ov-sub" role="status">
              {song.accompanimentUrl ? '原始伴奏暂不可用，已准备合成伴奏。' : '已准备合成伴奏。'}
            </div>}
            <button className="ov-start" onClick={() => void start()}>
              ▶ 开始演奏
            </button>
            <div className="ov-tips">4 拍倒数起奏 · 空格 暂停/继续 · ⏺ 录音开关 · Esc 停止并进回放</div>
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

      {(phase === 'ended' || phase === 'saving') && (
        <div className="perform-overlay">
          <div className="ov-card">
            <div className="ov-title big">{phase === 'saving' ? '正在保存本轮录音…' : '演奏完成 ♪'}</div>
            <div className="ov-sub">{phase === 'saving' ? '保存完成后继续，请稍候' : '正在前往回放…'}</div>
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

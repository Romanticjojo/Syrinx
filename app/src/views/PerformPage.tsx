import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { openMic, type MicSession } from '../audio/recorder'
import { synthAccompaniment } from '../audio/synth'
import { LumiereScene } from '../background/LumiereScene'
import ControlBar from '../components/ControlBar'
import PitchMeter, { type PitchMeterHandle } from '../components/PitchMeter'
import { noteAt } from '../pitch/compare'
import { LivePitchTracker } from '../pitch/live'
import { yinDetect } from '../pitch/yin'
import ScoreSheet from '../components/ScoreSheet'
import type { OSMDScore } from '../score/OSMDScore'
import { getSong, loadSong, SONGS } from '../songs'
import { useAppStore } from '../store'
import type { Timeline } from '../types'
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
}

export default function PerformPage() {
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const song = getSong(songId) ?? SONGS[0]

  const [phase, setPhase] = useState<Phase>('loading')
  const [playing, setPlaying] = useState(false)
  const [recOn, setRecOn] = useState(false)
  const [volume, setVolume] = useState(1)
  const [errorMsg, setErrorMsg] = useState('')
  const [xml, setXml] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // rAF 循环用的 ref 镜像（避开闭包过期）
  const timelineRef = useRef<Timeline | null>(null)
  const phaseRef = useRef<Phase>('loading')
  const playingRef = useRef(false)
  const finishedRef = useRef(false)
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
      micOpeningRef.current = openMic(audioEngine.audioCtx)
        .then((mic) => {
          micRef.current = mic
          micOpeningRef.current = null
          return mic
        })
        .catch((e: unknown) => {
          micOpeningRef.current = null
          throw e
        })
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

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    audioEngine.pause()
    playingRef.current = false
    setPlaying(false)
    shellRef.current?.classList.remove('idle')
    setPhase('ended')

    // 停麦克风并封存 Take（音高分析在回放页按需进行）；录音关着则丢弃采集
    const mic = micRef.current
    micRef.current = null
    micOpeningRef.current = null
    const started = recStartedRef.current
    recStartedRef.current = null
    const discard = !recOnRef.current || !started
    recOnRef.current = false
    setRecOn(false)
    const durationSec = audioEngine.time
    if (mic) {
      mic
        .stop()
        .then((r) => {
          if (discard) {
            URL.revokeObjectURL(r.url)
            return
          }
          const prev = useAppStore.getState().lastTake
          if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl)
          useAppStore.getState().setTake({
            songId: song.id,
            startedAt: started!.wall,
            durationSec,
            audioUrl: r.url,
            mimeType: r.mime,
            startSec: started!.t,
            pitchTrack: null,
            stats: null,
          })
        })
        .catch(() => {
          if (!discard) showToast('录音保存失败，回放页将无录音')
        })
    } else if (!discard) {
      showToast('麦克风不可用，本次演奏无录音')
    }
    window.setTimeout(() => go('result'), 1200)
  }, [go, showToast, song.id])

  // 进入即装配：曲谱解析 → 伴奏装入（真实伴奏优先，缺省合成） → 装入主时钟（就绪前由浮层遮罩）
  useEffect(() => {
    let alive = true
    audioEngine.onEnd = finish
    ;(async () => {
      try {
        const { xml: x, timeline: t } = await loadSong(song)
        if (!alive) return
        setXml(x)
        setTimeline(t)
        timelineRef.current = t
        // 真实伴奏优先：Song Pack 有音频文件时解码装入；缺文件或解码失败回退程序化合成
        let buffer: AudioBuffer | null = null
        if (song.accompanimentUrl) {
          try {
            const res = await fetch(song.accompanimentUrl)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            buffer = await audioEngine.decode(await res.arrayBuffer())
          } catch (e: unknown) {
            console.warn(`[luv] 伴奏加载失败，回退程序化合成：${e instanceof Error ? e.message : e}`)
            buffer = null
          }
        }
        if (!buffer) buffer = await synthAccompaniment(t)
        if (!alive) return
        await audioEngine.load(buffer)
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
      audioEngine.onEnd = undefined
      audioEngine.pause()
      clearTimeout(idleTimer.current)
      clearTimeout(toastTimer.current)
      // 中途退出：整个麦克风会话作废（含未封存的录音）
      const mic = micRef.current
      micRef.current = null
      micOpeningRef.current = null
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
    v.src = song.backgroundVideoUrl
    v.play().catch(() => {})
    return () => {
      v.pause()
      v.removeAttribute('src')
    }
  }, [song.backgroundVideoUrl])

  // three.js 主题背景：挂载即渲染，伴奏 analyser 驱动呼吸，卸载全量释放（有视频时跳过）
  useEffect(() => {
    if (song.backgroundVideoUrl) return
    const canvas = bgCanvasRef.current
    if (!canvas) return
    const scene = new LumiereScene(canvas, song.accent)
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

  // 光标小节回调 → 直写 HUD。回调必须随 ScoreSheet 实例一起挂/摘（传 prop 由
  // ScoreSheet 挂接）：演奏页侧自己往 scoreRef 挂会错过 StrictMode remount 换出的
  // 新实例，HUD 永远停在 -- / --（t_b22f5467 项 3 根因）
  const handleMeasure = useCallback((m: number, total: number) => {
    if (measureEl.current)
      measureEl.current.textContent = `${String(m).padStart(2, '0')} / ${total}`
  }, [])

  /** 就绪 → 用户手势起奏：恢复音频上下文 + 预开麦克风 + 调度 4 拍节拍音 */
  const start = useCallback(async () => {
    if (phaseRef.current !== 'ready') return
    const tl = timelineRef.current
    if (!tl) return
    await audioEngine.resume()
    // 麦克风在倒数期间申请（权限弹窗时间被倒数盖住）；失败不阻断演奏
    ensureMic().catch(() => showToast('麦克风不可用，实时音准与录音不可用'))
    scoreRef.current?.showCursor()
    const beat = 60 / tl.tempo
    const t0 = audioEngine.ctxTime + 0.12
    for (let k = 0; k < COUNT_BEATS; k++) {
      // 末拍高八度，提示即将起奏
      audioEngine.scheduleTick(t0 + k * beat, k === COUNT_BEATS - 1 ? 1174.66 : 880, 0.09, 0.22)
    }
    countdownRef.current = { t0, beat }
    setPhase('countdown')
  }, [ensureMic, showToast])

  // 倒数：以 ctx.currentTime 为准（与节拍音同源），归零瞬间 play(0)
  useEffect(() => {
    if (phase !== 'countdown') return
    let raf = 0
    const step = () => {
      const { t0, beat } = countdownRef.current
      const remain = t0 + beat * COUNT_BEATS - audioEngine.ctxTime
      if (remain <= 0) {
        audioEngine.play(0)
        playingRef.current = true
        setPlaying(true)
        setPhase('performing')
        // 默认开录（录音开着才封存 Take）；麦克风没就绪时等它就绪后补开。
        // 一次性提示采集确实开起来了（t_b22f5467 项 2）
        const REC_ON_TOAST = '🎙️ 录音已开启，结束后可在回放页查看'
        recOnRef.current = true
        setRecOn(true)
        if (micRef.current && startCapture(0, false)) showToast(REC_ON_TOAST)
        else void ensureMic().then((mic) => {
          if (playingRef.current && recOnRef.current && micRef.current === mic && !recStartedRef.current)
            if (startCapture(0, false)) showToast(REC_ON_TOAST)
        }).catch(() => {})
        return
      }
      if (countEl.current)
        countEl.current.textContent = String(Math.max(1, Math.ceil(remain / beat)))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [phase, ensureMic, startCapture])

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
    if (phaseRef.current !== 'performing') return
    if (audioEngine.playing) {
      audioEngine.pause()
      micRef.current?.pauseCapture() // 采集随伴奏暂停，时间轴保持对齐
      playingRef.current = false
      setPlaying(false)
      shellRef.current?.classList.remove('idle')
    } else {
      audioEngine.play()
      micRef.current?.resumeCapture()
      playingRef.current = true
      setPlaying(true)
      wake()
    }
  }, [wake])

  /** 回开头：seek 0 + 光标 reset + 录音开着则丢弃旧段重录（录音起点回到 0） */
  const restart = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    audioEngine.seek(0)
    scoreRef.current?.resetCursor()
    liveTrackerRef.current.reset()
    pitchMeterRef.current?.reset()
    if (recOnRef.current) {
      startCapture(0, !audioEngine.playing)
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
      const clamped = Math.max(0, Math.min(t, tl.durationSec))
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

  /** 点谱面小节 → 从该小节头继续：小节号经 measureTimes（伴奏锚点表）反查时间。
   *  终点标记的 measure 号是虚构的末小节+1，点击反查不会命中，无需特判 */
  const seekToMeasure = useCallback(
    (m: number) => {
      if (phaseRef.current !== 'performing') return
      const tl = timelineRef.current
      if (!tl) return
      const entry = tl.measureTimes.find((e) => e.measure === m)
      if (!entry) return
      seekTo(entry.time)
    },
    [seekTo],
  )

  /** 录音开关：只控采集支路，实时音准反馈不受影响；关=丢当前段，开=从头录这段 */
  const toggleRec = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    const next = !recOnRef.current
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

  const exit = useCallback(() => go('home'), [go])

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

  return (
    <div
      className="perform"
      ref={shellRef}
      style={{ '--song-accent': song.accent } as React.CSSProperties}
    >
      <canvas className="perform-bg" ref={bgCanvasRef} aria-hidden="true" />
      <video className="perform-bg" ref={bgVideoRef} muted loop playsInline autoPlay aria-hidden="true" style={{ display: song.backgroundVideoUrl ? 'block' : 'none' }} />
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

      <div className="perform-stage">
        {xml && timeline && (
          <ScoreSheet
            xml={xml}
            timeline={timeline}
            accent={song.accent}
            scoreRef={scoreRef}
            onMeasureChange={handleMeasure}
            onMeasureClick={seekToMeasure}
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
          recOn={recOn}
          volume={volume}
          onToggle={toggle}
          onRecToggle={toggleRec}
          onRestart={restart}
          onVolume={changeVolume}
          onExit={exit}
        />
      </div>

      {phase === 'loading' && (
        <div className="perform-overlay" role="status" aria-label="正在准备">
          <div className="ov-card">
            <div className="ov-glyph">𝄞</div>
            <div className="ov-title">正在准备伴奏…</div>
            <div className="ov-sub">解析曲谱 · 程序化合成 · 对齐主时钟</div>
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
            <button className="ov-start" onClick={() => void start()}>
              ▶ 开始演奏
            </button>
            <div className="ov-tips">4 拍倒数起奏 · 空格 暂停/继续 · ⏺ 录音开关 · Esc 退出</div>
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

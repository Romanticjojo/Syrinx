import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { synthAccompaniment } from '../audio/synth'
import ControlBar from '../components/ControlBar'
import ScoreSheet from '../components/ScoreSheet'
import type { OSMDScore } from '../score/OSMDScore'
import { getSong, loadSong, SONGS } from '../songs'
import { useAppStore } from '../store'
import type { Timeline } from '../types'
import './PerformPage.css'

/**
 * 页内阶段机：加载 → 就绪 → 倒数 → 演奏（含暂停）→ 结束。
 * 高频数据（当前时间/小节/进度）由 rAF 直写 DOM，不进 store（已定决策 5）。
 */
type Phase = 'loading' | 'ready' | 'countdown' | 'performing' | 'ended' | 'error'

const IDLE_MS = 3200
const COUNT_BEATS = 4
const TAIL_GRACE = 0.6 // 末音后留给混响的余韵再收

const fmt = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export default function PerformPage() {
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const song = getSong(songId) ?? SONGS[0]

  const [phase, setPhase] = useState<Phase>('loading')
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [volume, setVolume] = useState(1)
  const [errorMsg, setErrorMsg] = useState('')
  const [xml, setXml] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)

  // rAF 循环用的 ref 镜像（避开闭包过期）
  const timelineRef = useRef<Timeline | null>(null)
  const phaseRef = useRef<Phase>('loading')
  const playingRef = useRef(false)
  const finishedRef = useRef(false)
  const countdownRef = useRef({ t0: 0, beat: 0.7 })
  const idleTimer = useRef(0)

  const scoreRef = useRef<OSMDScore | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
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

  /** 演奏结束：收音、出结束浮层、稍候去回放页 */
  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    audioEngine.pause()
    playingRef.current = false
    setPlaying(false)
    shellRef.current?.classList.remove('idle')
    setPhase('ended')
    window.setTimeout(() => go('result'), 1200)
  }, [go])

  // 进入即装配：曲谱解析 → 伴奏合成 → 装入主时钟（就绪前由浮层遮罩）
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
        const buffer = await synthAccompaniment(t)
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
    }
    // song 由 currentSongId 派生，进入本页才加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 光标小节回调 → 直写 HUD（ScoreSheet 挂载先于本 effect，scoreRef 已就绪）
  useEffect(() => {
    const score = scoreRef.current
    if (!score) return
    score.onMeasureChange = (m, total) => {
      if (measureEl.current)
        measureEl.current.textContent = `${String(m).padStart(2, '0')} / ${total}`
    }
    return () => {
      score.onMeasureChange = undefined
    }
  }, [])

  /** 就绪 → 用户手势起奏：恢复音频上下文 + 调度 4 拍节拍音 */
  const start = useCallback(async () => {
    if (phaseRef.current !== 'ready') return
    const tl = timelineRef.current
    if (!tl) return
    await audioEngine.resume()
    scoreRef.current?.showCursor()
    const beat = 60 / tl.tempo
    const t0 = audioEngine.ctxTime + 0.12
    for (let k = 0; k < COUNT_BEATS; k++) {
      // 末拍高八度，提示即将起奏
      audioEngine.scheduleTick(t0 + k * beat, k === COUNT_BEATS - 1 ? 1174.66 : 880, 0.09, 0.22)
    }
    countdownRef.current = { t0, beat }
    setPhase('countdown')
  }, [])

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
        return
      }
      if (countEl.current)
        countEl.current.textContent = String(Math.max(1, Math.ceil(remain / beat)))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  // 演奏主循环：唯一时间源 audioEngine.time → 光标推进 + HUD 直写 + 结束判定
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
      playingRef.current = false
      setPlaying(false)
      shellRef.current?.classList.remove('idle')
    } else {
      audioEngine.play()
      playingRef.current = true
      setPlaying(true)
      wake()
    }
  }, [wake])

  /** 回开头：seek 0 + 光标 reset（下一帧 syncToTime 重新拉齐小节显示） */
  const restart = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    audioEngine.seek(0)
    scoreRef.current?.resetCursor()
    const p = audioEngine.playing
    playingRef.current = p
    setPlaying(p)
    wake()
  }, [wake])

  const exit = useCallback(() => go('preview'), [go])

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

  const changeZoom = (delta: number) => {
    setZoom((z) => {
      const next = Math.min(1.6, Math.max(0.6, Math.round((z + delta) * 10) / 10))
      scoreRef.current?.setZoom(next)
      return next
    })
  }

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
      <header className="perform-hud hud-top">
        <div className="hud-song">
          <b>{song.title}</b>
          <span>{song.composer}</span>
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
          <ScoreSheet xml={xml} timeline={timeline} accent={song.accent} scoreRef={scoreRef} />
        )}
      </div>

      <div className="progress-rail" aria-hidden="true">
        <span className="played" ref={playedEl} />
      </div>

      <div className="perform-hud hud-bottom">
        <ControlBar
          playing={playing}
          ended={phase === 'ended'}
          zoom={zoom}
          volume={volume}
          onToggle={toggle}
          onRestart={restart}
          onZoom={changeZoom}
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
            <div className="ov-tips">4 拍倒数起奏 · 空格 暂停/继续 · Esc 退出 · 静置自动隐藏控件</div>
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
    </div>
  )
}

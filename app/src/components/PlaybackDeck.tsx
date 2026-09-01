import { useEffect, useRef, useState, type RefObject } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { ensureRecGain } from '../audio/recGraph'
import { volToGain } from '../audio/volCurve'

interface Props {
  src: string
  /** 强调色（进度条填充） */
  accent: string
  /** 录音 <audio> 元素由调用方持有（对照播放共用同一元素） */
  audioRef: RefObject<HTMLAudioElement | null>
  /** 纯录音时长未知时的兜底显示（秒） */
  fallbackDurationSec?: number
  /** 伴奏滑杆仅在对照播放时需要（t_5957a725）：false/缺省不渲染、也不写
   *  audioEngine（伴奏增益与演奏页背景伴奏共用，只回听录音不该动它） */
  showAccVol?: boolean
}

const fmt = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

/** 自绘回放卡：播放/暂停 + 可点击/拖拽进度条（带滑块指示）+ 时间显示
 * + 录音/伴奏双音量（t_2264e5ba）。录音经 WebAudio 增益补偿直采电平偏低，
 * 伴奏直接走 audioEngine 音量（对照播放页间共享，演奏页调过则无缝衔接）。
 * MediaRecorder webm 在 <audio> 里 duration 常为 Infinity，
 * loadedmetadata 后用「先 seek 大时间再归零」逼出真实时长。 */
export default function PlaybackDeck({ src, accent, audioRef, fallbackDurationSec = 0, showAccVol = false }: Props) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackDurationSec)
  // 录音音量滑杆 0-1（经感知曲线映射到 0..x3 增益，满格即最大声）
  const [recVol, setRecVol] = useState(1)
  // 伴奏音量：初始接住演奏页/上次设置（audioEngine 是全局单例）
  const [accVol, setAccVol] = useState(() => audioEngine.getVolume())
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    setTime(0)
    setPlaying(false)
    setDuration(fallbackDurationSec)
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration)
        return
      }
      // webm 无 duration 元数据：seek 到远端触发时长计算
      const onSeek = () => {
        el.removeEventListener('timeupdate', onSeek)
        setDuration(Number.isFinite(el.duration) ? el.duration : fallbackDurationSec)
        el.currentTime = 0
      }
      el.addEventListener('timeupdate', onSeek)
      el.currentTime = 1e6
    }
    const onTime = () => setTime(el.currentTime)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      setTime(0)
      el.currentTime = 0
    }
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
    }
  }, [audioRef, src, fallbackDurationSec])

  // 录音音量：优先 WebAudio 增益（element.volume 上限 1 不够补偿直采电平），
  // 接线失败回退 element.volume 直控；元素音量固定 1，响度全由滑杆曲线决定
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const gain = ensureRecGain(el, audioEngine.audioCtx)
    if (gain) {
      el.volume = 1
      el.muted = false
      gain.gain.value = volToGain(recVol)
    } else {
      el.volume = recVol
      el.muted = false
    }
  }, [audioRef, recVol])

  // 伴奏音量：仅在滑杆显示（对照播放开启）时接管引擎增益（t_5957a725）。
  // 取舍：accVol 初值本就取自引擎，显隐切换时写入幂等无害；但隐藏时彻底
  // 不写更简单也更稳——回放页挂载不再可能污染演奏页的伴奏音量。
  useEffect(() => {
    if (!showAccVol) return
    audioEngine.setVolume(accVol)
  }, [accVol, showAccVol])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    // 录音已接进 audioEngine 的 AudioContext：suspended 下元素出声走不到输出，
    // 播放手势里顺手恢复（对照播放路径在 ResultPage 已各自 resume）
    void audioEngine.resume()
    if (el.paused) void el.play()
    else el.pause()
  }

  const seekFromClientX = (clientX: number) => {
    const el = audioRef.current
    const track = trackRef.current
    if (!el || !track || duration <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    el.currentTime = ratio * duration
    setTime(el.currentTime)
  }

  // 进度轨点击/拖拽：pointer capture 全程跟手
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const track = e.currentTarget
    track.setPointerCapture(e.pointerId)
    seekFromClientX(e.clientX)
    const move = (ev: PointerEvent) => seekFromClientX(ev.clientX)
    const up = () => {
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
      track.removeEventListener('pointercancel', up)
    }
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)
  }

  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0

  return (
    <div className="pdeck">
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="pdeck-row">
        <button
          className="pdeck-btn"
          style={playing ? { background: accent, color: '#06130d', borderColor: 'transparent' } : undefined}
          onClick={toggle}
          aria-label={playing ? '暂停录音' : '播放录音'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <div
          ref={trackRef}
          className="pdeck-track"
          role="slider"
          aria-label="录音进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          onPointerDown={onTrackPointerDown}
        >
          <div className="pdeck-fill" style={{ width: `${pct}%`, background: accent }} />
        </div>
        <span className="pdeck-time">
          {fmt(time)} / {fmt(duration)}
        </span>
      </div>
      <div className="pdeck-vols">
        <label className="pdeck-vol">
          <span className="pdeck-vol-label">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <rect x="6" y="1.5" width="4" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4 7v1a4 4 0 0 0 8 0V7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <path d="M8 12v2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            录音
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={recVol}
            onChange={(e) => setRecVol(Number(e.target.value))}
            aria-label="录音音量"
            title="录音音量（含增益补偿）"
          />
        </label>
        {showAccVol && (
          <label className="pdeck-vol">
            <span className="pdeck-vol-label">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M6 12.5V3.5l7-1.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <circle cx="4" cy="12.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="11" cy="11" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              伴奏
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={accVol}
              onChange={(e) => setAccVol(Number(e.target.value))}
              aria-label="伴奏音量"
              title="伴奏音量（对照播放时生效）"
            />
          </label>
        )}
      </div>
    </div>
  )
}

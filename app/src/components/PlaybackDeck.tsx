import { useEffect, useRef, useState, type RefObject } from 'react'

interface Props {
  src: string
  /** 强调色（进度条填充） */
  accent: string
  /** 录音 <audio> 元素由调用方持有（对照播放共用同一元素） */
  audioRef: RefObject<HTMLAudioElement | null>
  /** 纯录音时长未知时的兜底显示（秒） */
  fallbackDurationSec?: number
}

const fmt = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

/** 自绘回放卡：播放/暂停 + 可点击进度条 + 时间显示。
 * MediaRecorder webm 在 <audio> 里 duration 常为 Infinity，
 * loadedmetadata 后用「先 seek 大时间再归零」逼出真实时长。 */
export default function PlaybackDeck({ src, accent, audioRef, fallbackDurationSec = 0 }: Props) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackDurationSec)
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

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const seek = (e: React.MouseEvent) => {
    const el = audioRef.current
    const track = trackRef.current
    if (!el || !track || duration <= 0) return
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    el.currentTime = ratio * duration
    setTime(el.currentTime)
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
          onClick={seek}
        >
          <div className="pdeck-fill" style={{ width: `${pct}%`, background: accent }} />
        </div>
        <span className="pdeck-time">
          {fmt(time)} / {fmt(duration)}
        </span>
      </div>
    </div>
  )
}

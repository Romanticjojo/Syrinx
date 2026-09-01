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

/** 自绘回放卡：播放/暂停 + 可点击/拖拽进度条（带滑块指示）+ 时间显示 + 音量调节。
 * MediaRecorder webm 在 <audio> 里 duration 常为 Infinity，
 * loadedmetadata 后用「先 seek 大时间再归零」逼出真实时长。 */
export default function PlaybackDeck({ src, accent, audioRef, fallbackDurationSec = 0 }: Props) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(fallbackDurationSec)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
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

  // 音量/静音应用到录音元素（只影响录音回放；伴奏对照走 audioEngine 自己的音量）
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.volume = volume
    el.muted = muted
  }, [audioRef, volume, muted])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const toggleMute = () => setMuted((m) => !m)

  const changeVolume = (v: number) => {
    setVolume(v)
    if (v > 0) setMuted(false)
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
        <div className="pdeck-vol">
          <button
            className="pdeck-mute"
            onClick={toggleMute}
            aria-label={muted ? '取消静音' : '静音'}
            title={muted ? '取消静音' : '静音'}
          >
            {muted || volume === 0 ? '🔇' : '♪'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="录音音量"
            title="录音音量"
          />
        </div>
      </div>
    </div>
  )
}

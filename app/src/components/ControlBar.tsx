import './ControlBar.css'

interface Props {
  playing: boolean
  ended: boolean
  zoom: number
  volume: number
  onToggle: () => void
  onRestart: () => void
  onZoom: (delta: number) => void
  onVolume: (v: number) => void
  onExit: () => void
}

/** 演奏页底部控制条：播放/暂停、回开头、缩放、伴奏音量、退出（低频状态走 React，时间显示由演奏页 rAF 直写 DOM） */
export default function ControlBar({
  playing,
  ended,
  zoom,
  volume,
  onToggle,
  onRestart,
  onZoom,
  onVolume,
  onExit,
}: Props) {
  return (
    <div className="control-bar" role="toolbar" aria-label="演奏控制">
      <button
        className={`ctl main${playing ? ' pause' : ''}`}
        onClick={onToggle}
        disabled={ended}
        aria-label={playing ? '暂停' : '播放'}
        title={playing ? '暂停（空格）' : '播放（空格）'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="ctl" onClick={onRestart} aria-label="回开头" title="回开头">
        ↺
      </button>

      <div className="ctl-group" aria-label="谱面缩放">
        <button className="ctl" onClick={() => onZoom(-0.1)} aria-label="缩小谱面">
          A−
        </button>
        <span className="zoom-read">{Math.round(zoom * 100)}%</span>
        <button className="ctl" onClick={() => onZoom(0.1)} aria-label="放大谱面">
          A+
        </button>
      </div>

      <label className="ctl-volume" aria-label="伴奏音量">
        <span className="vol-icon">♪</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </label>

      <button className="ctl exit" onClick={onExit} aria-label="退出演奏" title="退出演奏">
        ✕
      </button>
    </div>
  )
}

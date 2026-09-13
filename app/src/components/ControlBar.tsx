import './ControlBar.css'
import TempoControl from './TempoControl'

export type CaptureIndicator = 'idle' | 'waiting' | 'preparing' | 'ready' | 'error'

interface Props {
  playing: boolean
  ended: boolean
  /** 处于演奏阶段（含播放与暂停）：停止键的可用窗口（t_c10d648d 后续：暂停也可停止进回放） */
  active: boolean
  /** 录音采集开关状态（只控采集，实时音准反馈不受其影响） */
  recOn: boolean
  captureIndicator: CaptureIndicator
  volume: number
  bpm: number
  recommendedBpm: number
  tempoDisabled: boolean
  tempoPending: boolean
  onTempo: (bpm: number) => void
  onToggle: () => void
  onRecToggle: () => void
  onRestart: () => void
  /** 停止演奏：封存本段 Take 并进入回放（t_53aa8b7a） */
  onStop: () => void
  onVolume: (v: number) => void
  onExit: () => void
}

/** 演奏页底部控制条：播放/暂停、录音开关、回开头、伴奏音量、退出（低频状态走 React，时间显示由演奏页 rAF 直写 DOM） */
export default function ControlBar({
  playing,
  ended,
  active,
  recOn,
  captureIndicator,
  volume,
  bpm,
  recommendedBpm,
  tempoDisabled,
  tempoPending,
  onTempo,
  onToggle,
  onRecToggle,
  onRestart,
  onStop,
  onVolume,
  onExit,
}: Props) {
  const recording = recOn && captureIndicator === 'ready' && playing
  const recAction = recOn ? '关闭录音' : '开启录音'
  const recStatus = captureIndicator === 'error' ? '录音不可用'
    : recOn && captureIndicator === 'waiting' ? '等待麦克风授权'
    : recOn && captureIndicator === 'preparing' ? '正在准备录音'
    : ''
  return (
    <div className="control-bar" role="toolbar" aria-label="演奏控制">
      <button
        className={`ctl main${playing ? ' pause' : ''}`}
        onClick={onToggle}
        disabled={ended || tempoPending}
        aria-label={playing ? '暂停' : '播放'}
        title={playing ? '暂停（空格）' : '播放（空格）'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        className={`ctl rec${recording ? ' on' : ''}`}
        onClick={onRecToggle}
        disabled={ended || tempoPending}
        aria-label={recStatus ? `${recStatus}，${recAction}` : recAction}
        aria-pressed={recOn}
        title={recStatus ? `${recStatus}，尚未录音；${recAction}` : recOn ? (recording ? '正在录音，关闭后保留当前段' : '录音已开启，播放后继续采集') : '开启录音，从当前位置录制新段'}
      >
        <svg className="rec-mic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20M9 20h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        {recording && <span className="rec-badge">REC</span>}
      </button>
      <button className="ctl" onClick={onRestart} aria-label="回开头" title="回开头">
        ↺
      </button>
      <button
        className="ctl stop"
        onClick={onStop}
        disabled={ended || !active}
        aria-label="停止演奏"
        title="停止演奏并进入回放"
      >
        ■
      </button>

      {/* 运输组（▶/rec/↺/■）与音量+✕ 分组：分隔线防 ✕ 被误认成停止（t_c10d648d） */}
      <span className="ctl-sep" aria-hidden="true" />

      <TempoControl bpm={bpm} recommended={recommendedBpm} disabled={tempoDisabled} pending={tempoPending} onChange={onTempo} />

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

      {/* 语义随演奏状态走（t_c10d648d）：演奏中点 ✕ = 停止并保存进回放（PerformPage 侧实现） */}
      <button
        className="ctl exit"
        onClick={onExit}
        aria-label={playing ? '停止并保存，进入回放' : '退出演奏'}
        title={playing ? '停止并保存，进入回放' : '退出演奏'}
      >
        ✕
      </button>
    </div>
  )
}

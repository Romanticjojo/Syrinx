import './ControlBar.css'
import TempoControl from './TempoControl'
import { useT } from '../i18n'

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
  const t = useT()
  const recording = recOn && captureIndicator === 'ready' && playing
  const recAction = recOn ? t('control.recOff') : t('control.recOn')
  const recStatus = captureIndicator === 'error' ? t('control.recUnavailable')
    : recOn && captureIndicator === 'waiting' ? t('control.recWaiting')
    : recOn && captureIndicator === 'preparing' ? t('control.recPreparing')
    : ''
  return (
    <div className="control-bar" role="toolbar" aria-label={t('control.toolbar')}>
      <button
        className={`ctl main${playing ? ' pause' : ''}`}
        onClick={onToggle}
        disabled={ended || tempoPending}
        aria-label={playing ? t('control.pause') : t('control.play')}
        title={playing ? t('control.pauseTitle') : t('control.playTitle')}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        className={`ctl rec${recording ? ' on' : ''}`}
        onClick={onRecToggle}
        disabled={ended || tempoPending}
        aria-label={recStatus ? t('control.recAriaCombo', { status: recStatus, action: recAction }) : recAction}
        aria-pressed={recOn}
        title={recStatus ? t('control.recTitleWaiting', { status: recStatus, action: recAction }) : recOn ? (recording ? t('control.recTitleRecording') : t('control.recTitleOn')) : t('control.recTitleOff')}
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
      <button className="ctl" onClick={onRestart} aria-label={t('control.restart')} title={t('control.restart')}>
        ↺
      </button>
      <button
        className="ctl stop"
        onClick={onStop}
        disabled={ended || !active}
        aria-label={t('control.stop')}
        title={t('control.stopTitle')}
      >
        ■
      </button>

      {/* 运输组（▶/rec/↺/■）与音量+✕ 分组：分隔线防 ✕ 被误认成停止（t_c10d648d） */}
      <span className="ctl-sep" aria-hidden="true" />

      <TempoControl bpm={bpm} recommended={recommendedBpm} disabled={tempoDisabled} pending={tempoPending} onChange={onTempo} />

      <label className="ctl-volume" aria-label={t('control.volume')}>
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
        aria-label={playing ? t('control.exitPlaying') : t('control.exit')}
        title={playing ? t('control.exitPlaying') : t('control.exit')}
      >
        ✕
      </button>
    </div>
  )
}

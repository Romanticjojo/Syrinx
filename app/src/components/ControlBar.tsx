import './ControlBar.css'

interface Props {
  playing: boolean
  ended: boolean
  /** 录音采集开关状态（只控采集，实时音准反馈不受其影响） */
  recOn: boolean
  volume: number
  onToggle: () => void
  onRecToggle: () => void
  onRestart: () => void
  onVolume: (v: number) => void
  onExit: () => void
}

/** 演奏页底部控制条：播放/暂停、录音开关、回开头、伴奏音量、退出（低频状态走 React，时间显示由演奏页 rAF 直写 DOM） */
export default function ControlBar({
  playing,
  ended,
  recOn,
  volume,
  onToggle,
  onRecToggle,
  onRestart,
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
      <button
        className={`ctl rec${recOn ? ' on' : ''}`}
        onClick={onRecToggle}
        disabled={ended}
        aria-label={recOn ? '关闭录音' : '开启录音'}
        aria-pressed={recOn}
        title={recOn ? '关闭录音（丢弃当前段，重新开启即重录）' : '开启录音（从头重录）'}
      >
        <i className="rec-dot" aria-hidden="true" />
      </button>
      <button className="ctl" onClick={onRestart} aria-label="回开头" title="回开头">
        ↺
      </button>

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

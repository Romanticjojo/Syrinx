import { useEffect, useRef } from 'react'
import { midiToNoteName, type LiveFeedback } from '../pitch/live'
import './PitchMeter.css'

/** 演奏页 rAF 直写 DOM 的句柄（高频更新不进 React/不进 store） */
export interface PitchMeterHandle {
  update(fb: LiveFeedback): void
  reset(): void
}

interface Props {
  handleRef: React.RefObject<PitchMeterHandle | null>
}

const IN_TUNE_CENTS = 50

/** 音分偏差 → 指针在量规上的位移百分比（±50 音分映射到 ±45%，留边距） */
function needlePct(cents: number): number {
  const clamped = Math.max(-IN_TUNE_CENTS, Math.min(IN_TUNE_CENTS, cents))
  return (clamped / IN_TUNE_CENTS) * 45
}

/**
 * 实时音准表：期望音名 + ±50 音分量规指针 + 实测偏差。
 * 每帧由演奏页 rAF 直接改 DOM（textContent/类名/位移），不触发 React 渲染。
 * 准（±50 内）用点缀色，偏（超 ±50）用警示红，与回放页配色语义一致。
 */
export default function PitchMeter({ handleRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const noteEl = useRef<HTMLSpanElement>(null)
  const needleEl = useRef<HTMLSpanElement>(null)
  const centsEl = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    handleRef.current = {
      update(fb) {
        const root = rootRef.current
        if (!root) return
        if (fb.midi === null) {
          root.classList.remove('active')
          return
        }
        root.classList.add('active')
        if (noteEl.current) noteEl.current.textContent = midiToNoteName(fb.midi)
        if (fb.cents === null) {
          root.classList.remove('good', 'off')
          if (needleEl.current) needleEl.current.style.transform = 'translateX(-50%)'
          if (centsEl.current) centsEl.current.textContent = '···'
          return
        }
        root.classList.toggle('off', !fb.inTune)
        root.classList.toggle('good', fb.inTune === true)
        if (needleEl.current)
          needleEl.current.style.transform = `translateX(calc(-50% + ${needlePct(fb.cents).toFixed(1)}%))`
        if (centsEl.current) {
          const v = Math.round(fb.cents)
          centsEl.current.textContent = `${v > 0 ? '+' : ''}${v}¢`
        }
      },
      reset() {
        const root = rootRef.current
        if (!root) return
        root.classList.remove('active', 'good', 'off')
        if (needleEl.current) needleEl.current.style.transform = 'translateX(-50%)'
        if (centsEl.current) centsEl.current.textContent = '···'
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef])

  return (
    <div className="pitch-meter" ref={rootRef} role="status" aria-label="实时音准">
      <span className="pm-note" ref={noteEl}>
        --
      </span>
      <span className="pm-gauge" aria-hidden="true">
        <i className="pm-zone" />
        <span className="pm-needle" ref={needleEl} />
      </span>
      <span className="pm-cents" ref={centsEl}>
        ···
      </span>
    </div>
  )
}

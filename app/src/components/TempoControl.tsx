import { useState } from 'react'
import { createPortal } from 'react-dom'
import Dialog from './Dialog'
import './TempoControl.css'

interface Props {
  bpm: number
  recommended: number
  disabled: boolean
  pending: boolean
  onChange: (bpm: number) => void
}

export default function TempoControl({ bpm, recommended, disabled, pending, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(bpm))
  const min = Math.max(1, Math.ceil(recommended * 0.5))
  const max = Math.max(min, Math.floor(recommended * 1.5))
  const value = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(value) && value >= min && value <= max
  const step = (delta: number) => setDraft(String(Math.max(min, Math.min(max, (valid ? value : bpm) + delta))))
  return <>
    <button className="tempo-trigger" type="button" aria-label="调整演奏速度" aria-haspopup="dialog"
      disabled={disabled} aria-disabled={pending || disabled} onClick={() => { if (pending) return; setDraft(String(bpm)); setOpen(true) }}>
      <span aria-hidden="true">♩</span><b>{bpm}</b><span>{pending ? '准备中' : 'BPM'}</span>
    </button>
    {open && createPortal(<Dialog title="演奏速度" onClose={() => setOpen(false)}>
      <div className="tempo-panel">
        <div className="tempo-stepper">
          <button type="button" aria-label="降低 BPM" onClick={() => step(-1)} disabled={valid && value <= min}>−</button>
          <label className="tempo-number"><input aria-label="演奏 BPM" inputMode="numeric" type="number" min={min} max={max} step={1}
            value={draft} onChange={event => setDraft(event.target.value)} aria-invalid={!valid} /><span>BPM</span></label>
          <button type="button" aria-label="提高 BPM" onClick={() => step(1)} disabled={valid && value >= max}>+</button>
        </div>
        <input className="tempo-slider" aria-label="演奏速度范围" type="range" min={min} max={max} step={1}
          value={valid ? value : bpm} onChange={event => setDraft(event.target.value)} />
        <div className="tempo-scale"><span>{min}</span><button type="button" onClick={() => setDraft(String(Math.round(recommended)))}>还原推荐 · {Math.round(recommended)} BPM</button><span>{max}</span></div>
        <p>伴奏保持原调，原谱的速度变化按比例保留。演奏中应用后，倒数并继续录制新段。</p>
        {!valid && <p className="tempo-error" role="alert">请输入 {min}–{max} 之间的整数 BPM。</p>}
        <button type="button" className="tempo-apply" disabled={!valid} onClick={() => { onChange(value); setOpen(false) }}>应用速度</button>
      </div>
    </Dialog>, document.body)}
  </>
}

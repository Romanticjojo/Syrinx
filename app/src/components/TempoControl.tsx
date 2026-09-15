import { useState } from 'react'
import { createPortal } from 'react-dom'
import Dialog from './Dialog'
import { useT } from '../i18n'
import './TempoControl.css'

interface Props {
  bpm: number
  recommended: number
  disabled: boolean
  pending: boolean
  onChange: (bpm: number) => void
}

export default function TempoControl({ bpm, recommended, disabled, pending, onChange }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(bpm))
  const min = Math.max(1, Math.ceil(recommended * 0.5))
  const max = Math.max(min, Math.floor(recommended * 1.5))
  const value = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(value) && value >= min && value <= max
  const step = (delta: number) => setDraft(String(Math.max(min, Math.min(max, (valid ? value : bpm) + delta))))
  return <>
    <button className="tempo-trigger" type="button" aria-label={t('tempo.triggerAria')} aria-haspopup="dialog"
      disabled={disabled} aria-disabled={pending || disabled} onClick={() => { if (pending) return; setDraft(String(bpm)); setOpen(true) }}>
      <span aria-hidden="true">♩</span><b>{bpm}</b><span>{pending ? t('tempo.preparing') : 'BPM'}</span>
    </button>
    {open && createPortal(<Dialog title={t('tempo.dialogTitle')} onClose={() => setOpen(false)}>
      <div className="tempo-panel">
        <div className="tempo-stepper">
          <button type="button" aria-label={t('tempo.lower')} onClick={() => step(-1)} disabled={valid && value <= min}>−</button>
          <label className="tempo-number"><input aria-label={t('tempo.bpmInput')} inputMode="numeric" type="number" min={min} max={max} step={1}
            value={draft} onChange={event => setDraft(event.target.value)} aria-invalid={!valid} /><span>BPM</span></label>
          <button type="button" aria-label={t('tempo.higher')} onClick={() => step(1)} disabled={valid && value >= max}>+</button>
        </div>
        <input className="tempo-slider" aria-label={t('tempo.rangeAria')} type="range" min={min} max={max} step={1}
          value={valid ? value : bpm} onChange={event => setDraft(event.target.value)} />
        <div className="tempo-scale"><span>{min}</span><button type="button" onClick={() => setDraft(String(Math.round(recommended)))}>{t('tempo.reset', { bpm: Math.round(recommended) })}</button><span>{max}</span></div>
        <p>{t('tempo.note')}</p>
        {!valid && <p className="tempo-error" role="alert">{t('tempo.rangeError', { min, max })}</p>}
        <button type="button" className="tempo-apply" disabled={!valid} onClick={() => { onChange(value); setOpen(false) }}>{t('tempo.apply')}</button>
      </div>
    </Dialog>, document.body)}
  </>
}

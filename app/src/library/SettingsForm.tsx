import type { ScoreInspection, ScoreSettings } from './types'

export default function SettingsForm({ info, value, onChange }: { info: ScoreInspection; value: ScoreSettings; onChange: (settings: ScoreSettings) => void }) {
  const pianoParts = info.parts.filter(part => part.isPiano)
  const change = (patch: Partial<ScoreSettings>) => onChange({ ...value, ...patch })
  return <div className="library-settings">
    <label className="library-field">主旋律声部<select value={value.melodyPartId} onChange={event => change({ melodyPartId: event.target.value })}>{info.parts.map(part => <option key={part.id} value={part.id}>{part.name} · {part.noteCount} 个音符</option>)}</select></label>
    {!pianoParts.length ? <p className="field-hint">这份乐谱没有钢琴声部，仅用于电子阅谱，不生成音频。</p> : <>
      <fieldset className="mode-fieldset"><legend>阅读与伴奏</legend><div className="mode-options">
        {([['none', '仅阅谱', '翻阅原谱，不生成音频'], ['original', '钢琴伴奏', '使用一份原谱钢琴']] as const).map(([mode, label, hint]) => <label className={`mode-option${value.mode === mode ? ' selected' : ''}`} key={mode}>
          <input type="radio" name="accompaniment-mode" value={mode} checked={value.mode === mode} onChange={() => change({ mode, pianoPartIds: mode === 'original' ? [pianoParts.find(part => part.id === value.pianoPartIds[0])?.id || pianoParts[0].id] : [] })} /><strong>{label}</strong><span>{hint}</span>
        </label>)}
      </div></fieldset>
      {value.mode === 'original' && <><label className="library-field">钢琴声部<select value={value.pianoPartIds[0] || pianoParts[0].id} onChange={event => change({ pianoPartIds: [event.target.value] })}>{pianoParts.map((part, index) => <option key={part.id} value={part.id}>钢琴 {index + 1} · {part.name} · {part.noteCount} 个音符</option>)}</select></label><p className="field-hint">只使用这一份钢琴声部，同一声部的左右手一起播放。音色为本机合成钢琴。</p></>}
    </>}
  </div>
}

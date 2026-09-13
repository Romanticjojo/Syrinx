import type { ScoreInspection, ScoreSettings } from './types'

export function initialSettings(info: ScoreInspection): ScoreSettings {
  const piano = info.parts.find(part => part.isPiano)
  return { melodyPartId: info.defaultMelodyPartId, pianoPartIds: piano ? [piano.id] : [], mode: piano ? 'original' : 'none', style: 'block', tonic: null, minor: info.keyMode === 'minor' }
}

/** Narrow legacy generated/multi-part settings; preserve explicit reading choices. */
export function normaliseSettings(info: ScoreInspection, saved: ScoreSettings): ScoreSettings {
  const defaults = initialSettings(info)
  const melodyPartId = info.parts.some(part => part.id === saved.melodyPartId) ? saved.melodyPartId : defaults.melodyPartId
  const piano = saved.pianoPartIds.map(id => info.parts.find(part => part.id === id && part.isPiano)).find(Boolean) || info.parts.find(part => part.isPiano)
  const mode = saved.mode === 'none' || !piano ? 'none' : 'original'
  return { ...defaults, melodyPartId, mode, pianoPartIds: mode === 'original' ? [piano!.id] : [] }
}

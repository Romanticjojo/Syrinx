import type { Timeline } from '../types'

export type AccompanimentMode = 'original' | 'generated' | 'none'
export type PianoStyle = 'block' | 'arpeggio' | 'waltz'

export interface ScoreSettings {
  melodyPartId: string
  pianoPartIds: string[]
  mode: AccompanimentMode
  style: PianoStyle
  /** Null uses the score key; 0=C, 1=C#, ... 11=B. */
  tonic: number | null
  minor: boolean
}

export interface PersonalScore {
  id: string
  fingerprint: string
  originalXml: string
  title: string
  composer: string
  tags: string[]
  favorite: boolean
  createdAt: number
  updatedAt: number
  lastOpenedAt: number | null
  settings: ScoreSettings
  folderId?: string | null
  coverImage?: string | null
}

export type PersonalScoreSummary = Omit<PersonalScore, 'originalXml' | 'coverImage'> & {
  hasCover: boolean
}

export interface ScoreFolder {
  id: string
  name: string
  createdAt: number
}

export interface LibrarySnapshot {
  records: PersonalScore[]
  folders: ScoreFolder[]
}

export interface ScorePart {
  id: string
  name: string
  isPiano: boolean
  noteCount: number
}

export interface ScoreInspection {
  title: string
  composer: string
  parts: ScorePart[]
  defaultMelodyPartId: string
  defaultPianoPartIds: string[]
  keyFifths: number
  keyMode: 'major' | 'minor'
  beats: number
  beatType: number
  tempo: number
  warnings: string[]
}

export interface PreparedScore {
  /** Full original score, suitable for reading. */
  displayXml: string
  /** Selected melody in the exact playback order. */
  melodyXml: string
  pianoXml: string | null
  timeline: Timeline
  accompanimentTimeline: Timeline
  warnings: string[]
  mode: AccompanimentMode
}

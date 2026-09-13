import type { SongManifest, Timeline } from '../types'

/** A single active local source keeps originals and generated audio out of the curated catalog. */
export interface RuntimeSong {
  manifest: SongManifest
  xml: string
  timeline: Timeline
  loadAudio: () => Promise<AudioBuffer>
  cancelAudio: () => void
}

let active: RuntimeSong | undefined

export function registerRuntimeSong(song: RuntimeSong): void {
  if (song.manifest.source !== 'personal' || !song.manifest.id.startsWith('personal:')) {
    throw new Error('个人乐谱标识无效')
  }
  active?.cancelAudio()
  active = song
}

export const getRuntimeSong = (id: string | null | undefined): RuntimeSong | undefined =>
  active?.manifest.id === id ? active : undefined

export function clearRuntimeSong(): void {
  active?.cancelAudio()
  active = undefined
}

import type { SongManifest, Timeline } from '../types'
import { assetUrl } from '../lib/assetUrl'

export interface LoadedAccompaniment {
  buffer: AudioBuffer
  synthesized: boolean
}

export interface AccompanimentDependencies {
  download: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>
  synth: (timeline: Timeline) => Promise<AudioBuffer>
  resolveUrl: (url: string) => string
}

export interface AccompanimentLoader {
  load: (song: SongManifest, timeline?: Timeline) => Promise<LoadedAccompaniment>
  cancel: (songId?: string) => void
  cancelPending: (songId?: string) => void
}

interface CacheEntry {
  key: string
  songId: string
  controller: AbortController
  promise: Promise<LoadedAccompaniment>
  result?: LoadedAccompaniment
}

const abortError = () => {
  const error = new Error('伴奏加载已取消')
  error.name = 'AbortError'
  return error
}

const ensureCurrent = (entry: CacheEntry, current: CacheEntry | null) => {
  if (entry.controller.signal.aborted || current !== entry) throw abortError()
}

export function createAccompanimentLoader(dependencies: AccompanimentDependencies): AccompanimentLoader {
  let current: CacheEntry | null = null

  const cancel = (songId?: string) => {
    if (!current || (songId !== undefined && current.songId !== songId)) return
    current.controller.abort()
    current = null
  }

  const cancelPending = (songId?: string) => {
    if (current?.result) return
    cancel(songId)
  }

  const load = (song: SongManifest, timeline?: Timeline): Promise<LoadedAccompaniment> => {
    const resolvedUrl = song.accompanimentUrl ? dependencies.resolveUrl(song.accompanimentUrl) : undefined
    const key = resolvedUrl
      ? `${song.id}|audio|${resolvedUrl}`
      : `${song.id}|synth|${song.scoreUrl}|${timeline?.durationSec ?? 'missing'}`

    if (current?.key === key) {
      return current.result ? Promise.resolve(current.result) : current.promise
    }

    cancel()
    const controller = new AbortController()
    let entry!: CacheEntry
    const promise = (async (): Promise<LoadedAccompaniment> => {
      if (resolvedUrl) {
        try {
          const data = await dependencies.download(resolvedUrl, controller.signal)
          ensureCurrent(entry, current)
          const decoded = await dependencies.decode(data)
          ensureCurrent(entry, current)
          return { buffer: decoded, synthesized: false }
        } catch (error) {
          if (controller.signal.aborted || current !== entry) throw abortError()
          if (!timeline) throw error
        }
      }

      if (!timeline) throw new Error(`伴奏不可用：${song.title} 缺少可合成的曲谱时间轴`)
      const synthesized = await dependencies.synth(timeline)
      ensureCurrent(entry, current)
      return { buffer: synthesized, synthesized: true }
    })()

    entry = { key, songId: song.id, controller, promise }
    current = entry
    void promise.then(
      (result) => {
        if (current === entry) entry.result = result
      },
      () => {
        if (current === entry) current = null
      },
    )
    return promise
  }

  return { load, cancel, cancelPending }
}

const sharedLoader = createAccompanimentLoader({
  resolveUrl: assetUrl,
  download: async (url, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`伴奏加载失败：HTTP ${response.status}`)
    return response.arrayBuffer()
  },
  decode: async (data) => {
    const { audioEngine } = await import('./AudioEngine')
    return audioEngine.decode(data)
  },
  synth: async (timeline) => {
    const { synthAccompaniment } = await import('./synth')
    return synthAccompaniment(timeline)
  },
})

/** Download/decode the selected song without mutating the playback engine. */
export const loadAccompaniment = (song: SongManifest, timeline?: Timeline) =>
  sharedLoader.load(song, timeline)

/** Preview uses the same shared work as the perform page. */
export const preloadAccompaniment = loadAccompaniment

export const cancelAccompaniment = (songId?: string) => sharedLoader.cancel(songId)

export const cancelPendingAccompaniment = (songId?: string) => sharedLoader.cancelPending(songId)

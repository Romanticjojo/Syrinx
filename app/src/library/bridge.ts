import { registerRuntimeSong, type RuntimeSong } from '../songs/runtime'
import type { SongManifest } from '../types'
import { synthesizePiano } from './piano'
import type { PersonalScore, PreparedScore } from './types'
import { inspectScore } from './score'

/** Generated audio belongs to this exact original/settings snapshot, never to a filename. */
export function activatePersonalScore(record: PersonalScore, prepared: PreparedScore): RuntimeSong {
  if (record.settings.mode !== 'original' || prepared.mode !== 'original') throw new Error('这份乐谱仅阅谱；只有原谱钢琴伴奏可以启动音频')
  if (record.settings.pianoPartIds.length !== 1) throw new Error('请选择一份原谱钢琴声部')
  const pianoId = record.settings.pianoPartIds[0]
  if (!inspectScore(record.originalXml).parts.some(part => part.id === pianoId && part.isPiano)) throw new Error('请选择有效的钢琴声部')
  const seconds = Math.ceil(prepared.timeline.durationSec)
  const manifest: SongManifest = {
    id: `personal:${record.id}`, source: 'personal', title: record.title, composer: record.composer,
    difficulty: 1, durationLabel: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    keyLabel: '个人乐谱', description: '本机合成原谱钢琴伴奏',
    tags: record.tags, scoreUrl: `personal:${record.id}`, accent: '#5fb8a8',
    backgroundTheme: 'lumiere', bpm: prepared.timeline.tempo, cursorMode: 'score',
  }
  let rendered: AudioBuffer | undefined
  let job: { controller: AbortController; promise: Promise<AudioBuffer> } | undefined
  const source: RuntimeSong = {
    manifest, xml: prepared.melodyXml, timeline: prepared.timeline,
    loadAudio: () => {
      if (rendered) return Promise.resolve(rendered)
      if (job) return job.promise
      const controller = new AbortController()
      const promise = synthesizePiano(prepared.accompanimentTimeline, controller.signal).then((buffer) => {
        if (controller.signal.aborted) throw new DOMException('伴奏准备已取消', 'AbortError')
        rendered = buffer
        return buffer
      }).finally(() => { if (job?.controller === controller) job = undefined })
      job = { controller, promise }
      return promise
    },
    cancelAudio: () => {
      job?.controller.abort()
      job = undefined
    },
  }
  registerRuntimeSong(source)
  return source
}

import type { SongManifest } from '../types'
import { SONGS } from './index'

/**
 * 同步微调工作台曲库（/sync-tune 歌曲切换器数据源）：
 * 内置曲库中只有带伴奏锚点（beatsUrl）的曲目才可同步微调——
 * 没有锚点就没有可调的 beatAnchors 控制点。过滤保序，顺序与曲库一致。
 */
export function syncSongList(): SongManifest[] {
  return SONGS.filter((s) => !!s.beatsUrl)
}

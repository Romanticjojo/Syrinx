import { describe, expect, it } from 'vitest'
import { SONGS } from './index'
import { syncSongList } from './syncList'

/** 同步微调曲库（R3 歌曲切换器数据源）：只保留有伴奏锚点（beatsUrl）的内置曲，
 *  无锚点曲目没有可调的 beatAnchors，进列表只会装配失败。 */

describe('syncSongList', () => {
  const list = syncSongList()

  it('每首都有 beatsUrl；lumiere / aurora-scale（无 beats）不在列表', () => {
    expect(list.every((s) => !!s.beatsUrl)).toBe(true)
    const ids = list.map((s) => s.id)
    expect(ids).not.toContain('lumiere')
    expect(ids).not.toContain('aurora-scale')
  })

  it('顺序与 SONGS 一致（过滤保序，不做重排）', () => {
    expect(list.map((s) => s.id)).toEqual(SONGS.filter((s) => !!s.beatsUrl).map((s) => s.id))
  })

  it('字段映射：id/title/difficulty/accent 与 SONGS 同源同值', () => {
    const byId = new Map(SONGS.map((s) => [s.id, s]))
    for (const s of list) {
      const src = byId.get(s.id)!
      expect(s.title).toBe(src.title)
      expect(s.difficulty).toBe(src.difficulty)
      expect(s.accent).toBe(src.accent)
    }
  })

  it('当前曲库现实：恰为 5 首有 beats 的曲（新增曲目时更新此清单）', () => {
    expect([...list.map((s) => s.id)].sort()).toEqual(
      ['birds-poem', 'expedition-33', 'flower-dance', 'luv-letter', 'river-flows-in-you'].sort(),
    )
  })
})

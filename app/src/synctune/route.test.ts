import { describe, expect, it } from 'vitest'
import { resolveSyncRoute, syncTunePath, SYNC_TUNE_DEFAULT_ID } from './route'

/** 同步页路由解析（R3）：裸 /sync-tune 落默认曲并要求 replaceState 补全 URL；
 *  带 id 原样透传（未知曲由页面显示装配失败态，不在路由层拦截）。 */

describe('resolveSyncRoute', () => {
  it('非本页路径返回 null（渲染 App）', () => {
    expect(resolveSyncRoute('/')).toBeNull()
    expect(resolveSyncRoute('/perform/luv-letter')).toBeNull()
    expect(resolveSyncRoute('/sync-tunex')).toBeNull()
  })

  it('裸 /sync-tune（含尾斜杠）→ 默认曲 + needsReplace', () => {
    expect(resolveSyncRoute('/sync-tune')).toEqual({
      songId: SYNC_TUNE_DEFAULT_ID,
      needsReplace: true,
    })
    expect(resolveSyncRoute('/sync-tune/')).toEqual({
      songId: SYNC_TUNE_DEFAULT_ID,
      needsReplace: true,
    })
  })

  it('带 id → 原样透传、无需 replace（未知 id 也放行，页面报装配失败）', () => {
    expect(resolveSyncRoute('/sync-tune/luv-letter')).toEqual({
      songId: 'luv-letter',
      needsReplace: false,
    })
    expect(resolveSyncRoute('/sync-tune/flower-dance/')).toEqual({
      songId: 'flower-dance',
      needsReplace: false,
    })
    expect(resolveSyncRoute('/sync-tune/not-a-song')).toEqual({
      songId: 'not-a-song',
      needsReplace: false,
    })
  })

  it('id 只认 [\\w-]（空格等非法字符不进同步页）', () => {
    expect(resolveSyncRoute('/sync-tune/luv letter')).toBeNull()
  })

  it('syncTunePath 生成 /sync-tune/<id>', () => {
    expect(syncTunePath('luv-letter')).toBe('/sync-tune/luv-letter')
  })
})

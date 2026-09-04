/**
 * 同步调试页路由约定（/sync-tune/:songId）。
 * 纯函数供 main.tsx 首挂载分流、页面 popstate 回退与单测共用；
 * 不做 launcher 页（决策 1）：裸 /sync-tune 直接落默认曲。
 */

/** 缺省曲目：直入 /sync-tune（无 id）时的重定向目标 */
export const SYNC_TUNE_DEFAULT_ID = 'luv-letter'

/** 生成 /sync-tune/<id> 路径（pushState 用） */
export function syncTunePath(songId: string): string {
  return `/sync-tune/${songId}`
}

/** 解析同步页路径：非本页路径返回 null；裸 /sync-tune 视为默认曲
 *  （needsReplace=true，调用方 replaceState 补全 URL，刷新可保持）。
 *  未知 id 原样放行——由页面显示装配失败态，路由层不拦曲目合法性。 */
export function resolveSyncRoute(pathname: string): { songId: string; needsReplace: boolean } | null {
  const m = /\/sync-tune(\/([\w-]+))?\/?$/.exec(pathname)
  if (!m) return null
  const id = m[2]
  if (id) return { songId: id, needsReplace: false }
  return { songId: SYNC_TUNE_DEFAULT_ID, needsReplace: true }
}

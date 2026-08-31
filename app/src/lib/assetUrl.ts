// 运行时资源 URL 解析：Vite base='./' 构建后，页面以相对路径引用 bundle，
// 但 manifest 里的 /songs/... 仍是绝对路径。打包（file://）时 window.location.origin
// 为 "file://"，fetch('/songs/..') 会指向盘符根 —— 统一在此折算：
// - http(s) 部署：origin + path（行为与现在一致）
// - file://（Electron 打包）：相对 index.html 的 ./songs/... 路径
export function assetUrl(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path
  if (!path.startsWith('/')) return path
  if (window.location.protocol === 'file:') {
    // index.html 位于 dist 根，songs/ 也拷贝在 dist 根，故剥掉开头斜杠即可
    return path.slice(1)
  }
  return window.location.origin + path
}

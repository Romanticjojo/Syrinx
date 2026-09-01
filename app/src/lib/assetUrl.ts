// 运行时资源 URL 解析：manifest 里的 /songs/... 是绝对路径，
// 部署在子路径或以相对 base 构建时需要折算回站点根：
// - http(s)：origin + path（站点根部署时与原路径一致）
// - 相对路径 / 非 http 协议：原样返回
export function assetUrl(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path
  if (!path.startsWith('/')) return path
  return window.location.origin + path
}

/** 主题：深浅双主题变量（index.css）+ localStorage 记忆 */
export type ThemeName = 'dark' | 'light'

const KEY = 'syrinx_theme'

export function getTheme(): ThemeName {
  return (localStorage.getItem(KEY) as ThemeName) === 'light' ? 'light' : 'dark'
}

/** 应用主题到 <html data-theme>；浅色为显式声明，暗色回落 ：root 默认 */
export function applyTheme(t: ThemeName) {
  if (t === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
}

export function setTheme(t: ThemeName) {
  localStorage.setItem(KEY, t)
  applyTheme(t)
}

/** 启动即同步（main.tsx 渲染前调用，避免主题闪跳） */
export function initTheme() {
  applyTheme(getTheme())
}

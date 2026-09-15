import { create } from 'zustand'
import type { SongManifest } from '../types'
import { en } from './en'
import { zh, type Dict, type TKey } from './zh'

/**
 * 自研轻量 i18n（决策已定，不引 i18next 等库）：
 * - 默认 zh、行为零变化；localStorage(syrinx_lang) 记忆选择。
 * - 不读 navigator.language 自动切英文——默认必须 zh。
 * - 字典是唯一事实源（zh.ts），en.ts 由类型约束保证 key 集合一致。
 */

export type Lang = 'zh' | 'en'
export type TParams = Record<string, string | number>
export type { Dict, TKey }

const STORAGE_KEY = 'syrinx_lang'
// Dict 是字面量类型（zh 的 as const），en 只保证同为 string——取词按 Record 语义
const DICTS: Record<Lang, Record<TKey, string>> = { zh, en }

/** localStorage 里只有合法值才采纳，否则回 zh */
function readStoredLang(): Lang {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'en' || value === 'zh' ? value : 'zh'
  } catch {
    return 'zh'
  }
}

/** 语言 → <html lang> 属性值 */
const htmlLang = (lang: Lang): string => (lang === 'en' ? 'en' : 'zh-CN')

/** 同步 <html lang> 与 <meta name="description">（首次前调用防闪；切换时副作用） */
export function applyDocumentLang(lang: Lang): void {
  document.documentElement.lang = htmlLang(lang)
  const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (meta) meta.content = DICTS[lang]['meta.description']
}

interface LangState {
  lang: Lang
  setLang: (lang: Lang) => void
}

export const useLangStore = create<LangState>((set) => ({
  lang: readStoredLang(),
  setLang: (lang) => {
    set({ lang })
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      /* 存储被禁时静默降级：本次会话内仍可切换 */
    }
    applyDocumentLang(lang)
  },
}))

/** 启动时在首帧前调用（main.tsx 里 initTheme() 旁），防止英文用户闪中文 meta/lang */
export function initLang(): void {
  applyDocumentLang(useLangStore.getState().lang)
}

/** 取词 + `{name}` 简单插值。缺失 key 时 console.warn 并回退中文（防手误白屏）。 */
export function translate(lang: Lang, key: TKey, params?: TParams): string {
  let text: string | undefined = DICTS[lang][key]
  if (text === undefined) {
    console.warn(`[i18n] missing key "${key}" in "${lang}", falling back to zh`)
    text = zh[key]
    if (text === undefined) return String(key)
  }
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** 组件内取词：订阅 lang，切换即时重渲 */
export function useT(): (key: TKey, params?: TParams) => string {
  const lang = useLangStore((s) => s.lang)
  return (key, params) => translate(lang, key, params)
}

/** 非组件场景取词（store 回调/闭包 toast 等）：始终读当前语言，无重渲语义 */
export function tr(key: TKey, params?: TParams): string {
  return translate(useLangStore.getState().lang, key, params)
}

/** manifest 双语字段名映射（title→titleEn …） */
const EN_FIELDS = {
  title: 'titleEn',
  composer: 'composerEn',
  description: 'descriptionEn',
  keyLabel: 'keyLabelEn',
} as const

type SongTextField = keyof typeof EN_FIELDS | 'tags'

/**
 * manifest 双语展示字段取值：英文态且 *En 字段存在（非空串/非空数组）取 En，
 * 否则回落原值（title/composer 多为西文，manifest 可不提供 En 字段）。
 * 仅在渲染路径调用（配合 useT 订阅才有切换重渲）。
 */
export function pickSongText(song: SongManifest, field: 'tags'): string[]
export function pickSongText(song: SongManifest, field: Exclude<SongTextField, 'tags'>): string
export function pickSongText(song: SongManifest, field: SongTextField): string | string[] {
  if (useLangStore.getState().lang === 'en') {
    if (field === 'tags') {
      if (song.tagsEn && song.tagsEn.length > 0) return song.tagsEn
    } else {
      const value = song[EN_FIELDS[field]]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return song[field]
}

import type { SongManifest, Timeline } from '../types'
import { applyAnchorOffset, applyBeats, type BeatsFile } from '../score/anchors'
import { assetUrl } from '../lib/assetUrl'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'
import luvLetterManifest from '../../public/songs/luv-letter/manifest.json'

/**
 * 内置曲库。占位曲目 2/3 复用 lumiere 曲谱（不同主题色/难度元数据），
 * 用户按 Song Pack 格式放入 public/songs/<id>/ 并在此登记即可扩展。
 */
export const SONGS: SongManifest[] = [
  // 首首正式曲：Luv Letter（DJ OKAWARI）——真实伴奏 + 动画背景 + 封面 + 正式谱（图片谱 OMR 转换，t_54968084）
  {
    ...luvLetterManifest,
    difficulty: luvLetterManifest.difficulty as 1 | 2 | 3,
    backgroundTheme: luvLetterManifest.backgroundTheme as SongManifest['backgroundTheme'],
  },
  {
    id: 'lumiere',
    title: 'Nocturne pour Lumière',
    composer: 'Lorien Testard',
    difficulty: 2,
    durationLabel: '0:42',
    keyLabel: 'C 大调（示例谱）',
    description:
      '一首写给晨光的夜曲。旋律平缓悠长，长笛在中音区低语，随伴奏渐亮。占位示例谱，正式曲谱由用户外部提供。',
    tags: ['夜曲', '治愈', '首发曲'],
    scoreUrl: '/songs/lumiere/score.musicxml',
    accent: '#3ddfae',
    backgroundTheme: 'lumiere',
    bpm: 84,
  },
  {
    id: 'aurora-scale',
    title: '晨间音阶练习',
    composer: '传统练习曲',
    difficulty: 1,
    durationLabel: '0:42',
    keyLabel: 'C 大调',
    description: '以音阶与琶音为主的晨间热身曲，节奏平稳，适合入门者熟悉跟谱演奏。',
    tags: ['练习曲', '入门'],
    scoreUrl: '/songs/lumiere/score.musicxml',
    accent: '#6edce8',
    backgroundTheme: 'aurora',
    bpm: 84,
  },
]

export function getSong(id: string | null): SongManifest | undefined {
  return SONGS.find((s) => s.id === id)
}

/** 加载曲目：拉取 MusicXML → 反复段展开为实体小节 → 解析时间轴 → 应用伴奏锚点。
 * 展开后的 xml 同时喂给 OSMD 与 timeline，光标/变色顺序与播放序严格一致 */
export async function loadSong(manifest: SongManifest): Promise<{ xml: string; timeline: Timeline }> {
  const res = await fetch(assetUrl(manifest.scoreUrl))
  if (!res.ok) throw new Error(`曲谱加载失败：${manifest.scoreUrl}（HTTP ${res.status}）`)
  const raw = await res.text()
  // 先剥强制换行（源谱按 A4 打印版式硬编码换行，会让容器限宽失效，t_c10d648d），
  // 再展开反复段：两步都产出合法 MusicXML，谱面内容不受影响
  const xml = expandRepeats(stripForcedBreaks(raw))
  let timeline = parseMusicXml(xml)
  // 伴奏锚点（可选）：谱面缺段/假 tempo 时把逐拍时间对齐到伴奏（t_3b9cfc25）
  if (manifest.beatsUrl) {
    try {
      const beats = await fetch(assetUrl(manifest.beatsUrl))
      if (beats.ok) timeline = applyBeats(timeline, (await beats.json()) as BeatsFile)
    } catch (e: unknown) {
      console.warn(`[syrinx] 伴奏锚点加载失败，回退恒速时间轴：${e instanceof Error ? e.message : e}`)
    }
  }
  // 全局微调（可选，默认 0）：锚点残差手工校准，正 = 谱面整体延后（t_b3080db9）
  if (manifest.anchorOffsetMs) timeline = applyAnchorOffset(timeline, manifest.anchorOffsetMs / 1000)
  return { xml, timeline }
}

export const DIFFICULTY_LABEL: Record<1 | 2 | 3, string> = {
  1: '●○○ 入门',
  2: '●●○ 进阶',
  3: '●●● 演奏级',
}

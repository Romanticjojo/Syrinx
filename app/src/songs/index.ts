import type { SongManifest, Timeline } from '../types'
import { parseMusicXml } from '../score/musicxml'
import luvLetterManifest from '../../public/songs/luv-letter/manifest.json'

/**
 * 内置曲库。占位曲目 2/3 复用 lumiere 曲谱（不同主题色/难度元数据），
 * 用户按 Song Pack 格式放入 public/songs/<id>/ 并在此登记即可扩展。
 */
export const SONGS: SongManifest[] = [
  // 首首正式曲：Luv Letter（DJ OKAWARI）——真实伴奏 + 动画背景 + 封面；谱面暂为占位（图片谱 OMR 转换中）
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
  {
    id: 'ember-nocturne',
    title: '炉火夜曲',
    composer: '传统（占位）',
    difficulty: 3,
    durationLabel: '0:42',
    keyLabel: 'C 大调',
    description: '情绪更浓的夜曲式占位曲目，用于展示每曲主题色与动态背景的换肤能力。',
    tags: ['夜曲', '演奏级'],
    scoreUrl: '/songs/lumiere/score.musicxml',
    accent: '#e6a050',
    backgroundTheme: 'ember',
    bpm: 84,
  },
  {
    id: 'zephyr-etude',
    title: '微风练习曲',
    composer: '传统（占位）',
    difficulty: 1,
    durationLabel: '0:42',
    keyLabel: 'C 大调',
    description: '轻快明朗的连音热身曲占位，暖金主题色呼应「夜航晨光」设计基调。',
    tags: ['练习曲', '入门'],
    scoreUrl: '/songs/lumiere/score.musicxml',
    accent: '#d9a441',
    backgroundTheme: 'aurora',
    bpm: 84,
  },
]

export function getSong(id: string | null): SongManifest | undefined {
  return SONGS.find((s) => s.id === id)
}

/** 加载曲目：拉取 MusicXML 并解析时间轴（伴奏合成在演奏页进行） */
export async function loadSong(manifest: SongManifest): Promise<{ xml: string; timeline: Timeline }> {
  const res = await fetch(manifest.scoreUrl)
  if (!res.ok) throw new Error(`曲谱加载失败：${manifest.scoreUrl}（HTTP ${res.status}）`)
  const xml = await res.text()
  const timeline = parseMusicXml(xml)
  return { xml, timeline }
}

export const DIFFICULTY_LABEL: Record<1 | 2 | 3, string> = {
  1: '●○○ 入门',
  2: '●●○ 进阶',
  3: '●●● 演奏级',
}

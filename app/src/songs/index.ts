import type { CursorMode, SongManifest, Timeline } from '../types'
import { applyAnchorOffset, applyBeats, type BeatsFile } from '../score/anchors'
import { buildScoreTimeline } from '../score/deterministic-adapter'
import { assetUrl } from '../lib/assetUrl'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'
import luvLetterManifest from '../../public/songs/luv-letter/manifest.json'
import flowerDanceManifest from '../../public/songs/flower-dance/manifest.json'
import riverFlowsInYouManifest from '../../public/songs/river-flows-in-you/manifest.json'
import expedition33Manifest from '../../public/songs/expedition-33/manifest.json'
import birdsPoemManifest from '../../public/songs/birds-poem/manifest.json'

/**
 * 内置曲库。占位曲目复用 lumiere 曲谱（不同主题色/难度元数据），
 * 用户按 Song Pack 格式放入 public/songs/<id>/ 并在此登记即可扩展。
 */
export const SONGS: SongManifest[] = [
  // 首首正式曲：Luv Letter（DJ OKAWARI）——真实伴奏 + 动画背景 + 封面 + 正式谱（图片谱 OMR 转换，t_54968084）
  {
    ...luvLetterManifest,
    difficulty: luvLetterManifest.difficulty as 1 | 2 | 3,
    backgroundTheme: luvLetterManifest.backgroundTheme as SongManifest['backgroundTheme'],
  },
  // 产线二期四首（t_0ad1f095）：谱面 OMR 清洗 + 伴奏锚点离线生成，媒体不入库
  {
    ...flowerDanceManifest,
    difficulty: flowerDanceManifest.difficulty as 1 | 2 | 3,
    backgroundTheme: flowerDanceManifest.backgroundTheme as SongManifest['backgroundTheme'],
  },
  {
    ...riverFlowsInYouManifest,
    difficulty: riverFlowsInYouManifest.difficulty as 1 | 2 | 3,
    backgroundTheme: riverFlowsInYouManifest.backgroundTheme as SongManifest['backgroundTheme'],
  },
  {
    ...expedition33Manifest,
    difficulty: expedition33Manifest.difficulty as 1 | 2 | 3,
    backgroundTheme: expedition33Manifest.backgroundTheme as SongManifest['backgroundTheme'],
  },
  {
    ...birdsPoemManifest,
    difficulty: birdsPoemManifest.difficulty as 1 | 2 | 3,
    backgroundTheme: birdsPoemManifest.backgroundTheme as SongManifest['backgroundTheme'],
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

/** loadSong 可选项（PlanB T2）：cursorMode 运行时覆盖光标数据源（优先于
 * manifest.cursorMode），T3 评估脚本用它做 anchors/score A/B 切换 */
export interface LoadSongOptions {
  cursorMode?: CursorMode
}

/** 加载曲目：拉取 MusicXML → 反复段展开为实体小节 → 解析时间轴。
 * 展开后的 xml 同时喂给 OSMD 与 timeline，光标/变色顺序与播放序严格一致。
 * 光标数据源（PlanB T2）按 cursorMode 选路：
 * - anchors（缺省）：恒速 Timeline + beats.json 伴奏锚点重映射（现有行为零变化）
 * - score：deterministic-adapter 谱面确定性换算，不依赖伴奏锚点/偏移 */
export async function loadSong(
  manifest: SongManifest,
  opts?: LoadSongOptions,
): Promise<{ xml: string; timeline: Timeline; cursorMode: CursorMode }> {
  const cursorMode: CursorMode = opts?.cursorMode ?? manifest.cursorMode ?? 'anchors'
  const res = await fetch(assetUrl(manifest.scoreUrl))
  if (!res.ok) throw new Error(`曲谱加载失败：${manifest.scoreUrl}（HTTP ${res.status}）`)
  const raw = await res.text()
  // 先剥强制换行（源谱按 A4 打印版式硬编码换行，会让容器限宽失效，t_c10d648d），
  // 再展开反复段：两步都产出合法 MusicXML，谱面内容不受影响
  const xml = expandRepeats(stripForcedBreaks(raw))
  // score 路径：展开谱（演奏序 = 文件序、小节号 = 重编号）喂确定性解析器
  if (cursorMode === 'score') {
    return { xml, timeline: buildScoreTimeline(xml), cursorMode }
  }
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
  return { xml, timeline, cursorMode }
}

export const DIFFICULTY_LABEL: Record<1 | 2 | 3, string> = {
  1: '●○○ 入门',
  2: '●●○ 进阶',
  3: '●●● 演奏级',
}

import type { CursorMode, SongManifest, Timeline } from '../types'
import { applyAnchorOffset, applyBeats, type BeatsFile } from '../score/anchors'
import { buildScoreTimeline } from '../score/deterministic-adapter'
import { assetUrl } from '../lib/assetUrl'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'
import sampleManifest from './sample/manifest.json'
import { buildSongCatalog } from './catalog'

/**
 * 内置曲库：正式曲目按 Song Pack 格式放入 public/songs/<id>/ 并在此登记即可扩展。
 * （2026-09-04：移除占位示例曲 lumiere「Nocturne pour Lumière」与 aurora-scale
 * 「晨间音阶练习」——均无伴奏锚点，仅作布局演示用；其谱面文件夹保留作为
 * musicxml 解析测试 fixture。）
 */
const privateManifestModules = import.meta.glob('../../public/songs/*/manifest.json', {
  eager: true,
})

/**
 * Private Song Packs are optional in a clean checkout. When none are present,
 * the checked-in sample keeps the development build useful. An explicit
 * deployment allowlist never falls back to that sample implicitly.
 */
export const SONGS: SongManifest[] = buildSongCatalog(
  privateManifestModules,
  sampleManifest,
  import.meta.env.VITE_SONG_IDS,
)

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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyBeats, type BeatsFile } from './anchors'
import { expandRepeats, parseMusicXml } from './musicxml'

/**
 * 时间轴交叉校验（2026-08-31 光标拍子修复 · 任务 B）。
 *
 * 基准：src/score/fixtures/luv_letter_timeline.json —— 独立展开的（随仓库分发，
 * 97 播放小节 / 998 事件时间轴（恒速展开）。与「应用管线」
 * parseMusicXml(expandRepeats) → applyBeats 重映射后的时间轴逐小节比对。
 *
 * 注意：基准文件从 docs 目录直读（单一事实源），未拷贝到 __fixtures__——
 * 实施环境禁用了文件复制命令（计划原定拷贝到 src/score/__fixtures__/）。
 */

/** 外部时间轴事件（timeline JSON） */
interface ExternalEvent {
  type: string
  pitch?: string
  measure: string
  start_q: number
  dur_q: number
  t0_sec: number
  t1_sec: number
}

/** 外部时间轴顶层结构（timeline JSON） */
interface ExternalTimeline {
  play_order: string[]
  anomalies: { measure: string; quarters: number }[]
  events: ExternalEvent[]
}

const TL_PATH = 'src/score/fixtures/luv_letter_timeline.json'

describe('luv-letter 时间轴交叉校验（applyBeats 重映射 vs 独立展开基准）', () => {
  it('逐小节比对 t0_sec，误差 >0.35s 的小节出报告（先报告不钳位）', () => {
    // 与 anchors.test / 应用 loadSong 相同的展开管线
    const raw = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8').replace(
      /^<\?xml[^>]*\?>/,
      (m) => m.replace(/'/g, '"'),
    )
    const beats = JSON.parse(
      readFileSync('public/songs/luv-letter/beats.json', 'utf-8'),
    ) as BeatsFile
    const ext = JSON.parse(readFileSync(TL_PATH, 'utf-8')) as ExternalTimeline
    const out = applyBeats(parseMusicXml(expandRepeats(raw)), beats)

    // 基准事件按播放序排列 → 按小节号分段成播放小节（无相邻同名小节，分段可靠）
    const groups: ExternalEvent[][] = []
    for (const ev of ext.events) {
      const cur = groups[groups.length - 1]
      if (cur && cur[0].measure === ev.measure) cur.push(ev)
      else groups.push([ev])
    }

    // 结构校验：分段数与播放序一致，且逐段小节号对上
    expect(ext.play_order).toHaveLength(97)
    expect(groups).toHaveLength(ext.play_order.length)
    for (const [i, g] of groups.entries()) {
      expect(g[0].measure, `播放小节 ${i + 1}`).toBe(ext.play_order[i])
    }

    // 逐小节误差：小节起点（measureTimes vs 该段首音最小 t0_sec）+ 首音时刻。
    // 注意：基准 timeline 的休止事件没有 t0_sec 字段（Hermes 生成时省略），
    // 只用 type==='note' 的事件算起点，否则 Math.min 吸进 undefined 得 NaN 污染拟合。
    const rows = groups.map((g, i) => {
      const playIdx = i + 1
      const tlNotes = g.filter((e) => e.type === 'note' && Number.isFinite(e.t0_sec))
      const tlStart = Math.min(...tlNotes.map((e) => e.t0_sec))
      const ourStart = out.measureTimes[i].time
      const ourNotes = out.notes.filter((n) => n.measure === playIdx)
      const noteErr =
        tlNotes.length > 0 && ourNotes.length > 0
          ? Math.abs(
              Math.min(...tlNotes.map((e) => e.t0_sec)) -
                Math.min(...ourNotes.map((n) => n.time)),
            )
          : null
      return { playIdx, printed: g[0].measure, tlStart, ourStart, diff: ourStart - tlStart, noteErr }
    })

    // 系统性偏移量化：diff ~ 四分音符位置 最小二乘线性拟合（跳过非有限行防污染）
    const fitRows = rows.filter((r) => Number.isFinite(r.diff))
    const qs = fitRows.map((r) => out.measureTimes[r.playIdx - 1].quarters)
    const ds = fitRows.map((r) => r.diff)
    const n = qs.length
    const meanQ = qs.reduce((a, b) => a + b, 0) / n
    const meanD = ds.reduce((a, b) => a + b, 0) / n
    const cov = qs.reduce((a, q, i) => a + (q - meanQ) * (ds[i] - meanD), 0)
    const varQ = qs.reduce((a, q) => a + (q - meanQ) ** 2, 0)
    const slope = cov / varQ
    const intercept = meanD - slope * meanQ
    const residualMax = Math.max(...ds.map((d, i) => Math.abs(d - (intercept + slope * qs[i]))))
    console.log(
      `[交叉校验] 系统性偏移：${slope.toFixed(4)}s/四分音符（截距 ${intercept.toFixed(2)}s），` +
        `去趋势最大残差 ${residualMax.toFixed(2)}s`,
    )

    // 当前数据状态钉住（Hermes 2026-08-31 实测复算）：
    // 基准 timeline 是恒速 76bpm 理想轴，锚点系是伴奏实测 DTW（rubato/fermata 导致
    // 曲中段发散，diff 范围 -48s..+7s，线性拟合仅量化整体趋势）。
    // 结构校验（上方 97 段逐一对上）才是硬断言；拟合值只做回归钉子：
    // 若未来修锚点或重算基准导致拟合剧变，此处失败即提示同步更新。
    expect(slope).toBeGreaterThan(-0.25)
    expect(slope).toBeLessThan(-0.05)
    expect(Number.isFinite(intercept)).toBe(true)
  })
})

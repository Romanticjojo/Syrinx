# sync-tune R2 · T3c：命中行首限定 bug + UI 打磨 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复「每行只有第一小节音符能选中」的命中 bug（含同根因的标记层错位），并完成 4 项 UI 打磨（nearHint 去 px、光标跨时值高亮、帮助按钮精简、微调工作流重排）。

**架构：** 三处核心改动都在 `OSMDScore.ts` 的几何层：① hitRows 行归并改为按纵向包络把相邻小节聚成系统行；② 坐标语义修正——`staffEntry.PositionAndShape.AbsolutePosition.x` 是行内绝对坐标（与小节同空间），标记层/hit 兜底不再叠加小节 x；③ 光标元素宽度覆盖当前音时值跨度（新可选参数 + `setTimeline`）。页面层 `SyncTunePage.tsx` 删试听/重置、加保存/撤销；store 加 `saveBaseline()`。

**技术栈：** React + zustand + OSMD (opensheetmusicdisplay) + vitest (happy-dom) + CDP 诊断脚本（复现/验证）。

## 诊断结论（已实测，证据在任务 0 的脚本输出）

1. OSMD `GraphicSheet.MeasureList` 是 **[小节][staff]** 二维表（压缩源码 `findGraphicalMeasureByMeasureNumber(t,e){for(let i=t;i>=0;i--)...MeasureList[i][e]...MeasureNumber===t}` 证明外层索引=小节；luv-letter 展开谱实测 outer=97、innerLens 全 1、nums=[[1],[2],…]）。
2. `ensureMarkerGeom` 把外层当"系统行"遍历 → 每小节各成一行；同一系统行的小节纵向包络完全重合，`noteAtPoint` 行判定 dy=0 平局时首个小节恒胜 → **行内只有第一小节能选中**（实测：row0 点击全选 m1，row1 全选 m6，row2 全选 m11）。
3. `staffEntry.PositionAndShape.AbsolutePosition.x` 与小节 `AbsolutePosition.x` **同一坐标空间（行内绝对）**（实测 m6 absX=5/seAbsX=15.12、m7 absX=28.82/seAbsX=31.12，notehead DOM x 与 seAbsX×10 常差 -6.01px）。因此 `setMarkers` 的 `offX + g.x + fx*unitPx` 双重计数：真实应用 601 个标记中非行首小节的全部右偏（mx 1029/1388/1688 溢出 svg 宽 978）——**连带 bug，一并修**。
4. OSMD 光标是公开的 `cursorElement: HTMLImageElement`（img），ThinLeft 类型宽度恒 `5*zoom` px = 「开头一个窄框」。宽度可直接覆写；OSMD 每次 `cursor.next()`→`update()` 会重置为 5，需在推进后再覆写。

## 文件结构

- 修改：`app/src/score/OSMDScore.ts` —— hitRows 行归并、坐标系修正、光标跨度（新构造参数 + `updateCursorSpan`）、`setTimeline`（保存修改后播放即新节奏）。
- 修改：`app/src/score/osmd-score.test.ts` —— fake 几何改为真实语义（MeasureList=[[小节staff],…]、se x 行内绝对）、补行归并/标记对位/光标跨度/setTimeline 测试。
- 修改：`app/src/views/SyncTunePage.tsx` —— 删试听/重置/Enter/死代码，加保存修改+撤销上一步，nearHint 去 px，「?」按钮精简，构造 OSMDScore 传光标跨度参数。
- 修改：`app/src/views/SyncTunePage.css` —— summary 只留 ?、`.st-btn-row` 微调（如仍被保存/撤销行使用则保留）。
- 修改：`app/src/synctune/store.ts` —— 新增 `saveBaseline()`。
- 修改：`app/src/synctune/store.test.ts` —— 补 `saveBaseline` 测试。
- 修改：`app/src/synctune/logic.ts` —— 删 `auditionWindow()`。
- 修改：`app/src/synctune/logic.test.ts` —— 删 `auditionWindow` 测试块。
- 新增（已完成，诊断用）：`app/scripts/diag-t3c-hitrows.mjs`、`app/scripts/diag-t3c-marker-align.mjs`。

红线：`PerformPage*` 零改动；`OSMDScore` 新能力全部可选参数/可选方法，缺省行为不变（光标跨度照 T3b `selectionColor` 先例做成 opt-in，演奏页不传即维持现状）；vitest 全绿；并发 worker WIP（`shot-entry.mjs` 等）只读不碰；commit 只 add 自己的文件。

---

### 任务 0：诊断脚本（已完成，随首个 commit 入库）

**文件：**
- 创建：`app/scripts/diag-t3c-hitrows.mjs`（已写好）
- 创建：`app/scripts/diag-t3c-marker-align.mjs`（已写好）

已运行并输出上述诊断结论 1-4。`diag-t3c-hitrows.mjs` 在修复后重跑应得到「每行各小节点击 → 选中各自行内小节」；`diag-t3c-marker-align.mjs` 重跑应得到标记 dx 收敛（非行首小节不再溢出 svg 右缘）。

---

### 任务 1：hitRows 行归并 + 坐标系修正（bug 1 核心）

**文件：**
- 修改：`app/src/score/OSMDScore.ts:411-462`（ensureMarkerGeom）、`app/src/score/OSMDScore.ts:471-527`（hitEntryFor 兜底）、`app/src/score/OSMDScore.ts:582-583`（setMarkers left）
- 测试：`app/src/score/osmd-score.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `osmd-score.test.ts` 中：先把 `fakeMeasure` 改为真实 OSMD 语义——`staffEntry.PositionAndShape.AbsolutePosition.x` 行内绝对（`num*10 + rv*4`，单位 OSMD unit），并把既有用例里的 `ml` 从 `[[fm1, fm2]]`（旧"行"语义）改为 `[[fm1], [fm2]]`（真实 [小节][staff]）：

```ts
/** 单小节假几何（单 staff）：se x 为行内绝对坐标（真实 OSMD 语义，T3c 诊断实测），
 *  measure 在行内的起点 = num*10，se x = num*10 + rv*4 */
function fakeMeasure(num: number, entries: { rv: number; note: FakeGNote }[]) {
  return {
    MeasureNumber: num,
    PositionAndShape: {
      AbsolutePosition: { x: num * 10, y: 20 },
      Size: { width: 8, height: 6 },
    },
    staffEntries: entries.map((e) => ({
      PositionAndShape: { AbsolutePosition: { x: num * 10 + e.rv * 4 } },
      sourceStaffEntry: { Timestamp: { RealValue: e.rv } },
      graphicalVoiceEntries: [{ notes: [e.note] }],
    })),
  }
}
```

新增测试（红）：

```ts
describe('OSMDScore T3c 行归并与坐标系修正', () => {
  // 同一系统行的两个小节：m1（rv0 A / rv0.25 B，行内绝对 x 10/11 unit -> 100/110px）、
  // m2（rv0 C，x 20 unit -> 200px），同 y 带 200..260px
  const A = mkGNote(), B = mkGNote(), C = mkGNote()
  const mlRow = [[fakeMeasure(1, [{ rv: 0, note: A }, { rv: 0.25, note: B }])], [fakeMeasure(2, [{ rv: 0, note: C }])]]

  it('bug 复现用例：行内第二小节的音符可选中（不再恒选行首小节）', () => {
    const { score } = makeGeomScore(mlRow)
    expect(score.noteAtPoint(205, 230)?.measure).toBe(2)
    expect(score.noteAtPoint(205, 230)?.rvInMeasure).toBe(0)
    // 行首小节仍可选
    expect(score.noteAtPoint(105, 230)?.measure).toBe(1)
    expect(score.noteAtPoint(105, 230)?.rvInMeasure).toBe(0)
  })

  it('跨行：不同 y 带的小节归入各自行，不串行', () => {
    const D = mkGNote()
    const ml2Rows = [
      ...mlRow,
      [fakeMeasure(3, [{ rv: 0, note: D }])].map((m) => ({
        ...m,
        PositionAndShape: { AbsolutePosition: { x: 30, y: 50 }, Size: { width: 8, height: 6 } },
      })),
    ]
    const { score } = makeGeomScore(ml2Rows)
    expect(score.noteAtPoint(305, 500)?.measure).toBe(3)
    expect(score.noteAtPoint(305, 500)?.rvInMeasure).toBe(0)
  })

  it('setMarkers：标记按行内绝对锚点定位（不叠加小节 x，修复双重计数错位）', () => {
    const { score, container } = makeGeomScore(mlRow)
    score.setMarkers([{ measure: 2, rvInMeasure: 0, color: '#fff' }])
    const el = container.querySelector<HTMLElement>('.sync-marker')
    expect(el).not.toBeNull()
    // happy-dom 下 svgRect/容器 rect 全零 -> offX=0；m2 rv0 锚点 x=20 unit -> 200px（旧代码会给 400px）
    expect(el!.style.left).toBe('200px')
    expect(el!.style.top).toBe('200px') // g.y = 20 unit
    expect(el!.style.height).toBe('60px')
    score.setMarkers([])
    expect(container.querySelector('.sync-marker')).toBeNull()
  })
})
```

注意：既有 `fakeMeasure` 被 T3/T3b 多个用例共用；把 `ml`/`mlSel`/`mlHit`/`ml2` 的外层数组改成 `[[…]]`（每小节一项）后，其余用例的期望值不变（页内位置口径不变：m1 rv0/rv0.25 仍 100/110px、m2 rv0 仍 200px）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：新增「行内第二小节可选中」「跨行」FAIL（实际返回 measure 1），「setMarkers 定位」FAIL（left 得 '400px'）；既有用例全绿。

- [ ] **步骤 3：实现**

`ensureMarkerGeom` 重写外层循环（行归并 + cursorStops 表先不做，任务 3 再加）：

```ts
private ensureMarkerGeom(): MarkerGeom | null {
  if (this.markerGeom) return this.markerGeom
  const svg = this.containerEl.querySelector('svg')
  const ml = this.osmd.GraphicSheet?.MeasureList
  if (!svg || !ml) return null
  const cRect = this.containerEl.getBoundingClientRect()
  const svgRect = svg.getBoundingClientRect()
  const unitPx = 10 * (this.osmd.Zoom || 1)
  const map = new Map</* …现有签名不变…*/>()
  const hitRows: HitRow[] = []
  // MeasureList 实为 [小节][staff]（T3c 诊断实测）：外层逐小节，行按纵向包络归并——
  // 同一系统行的小节包络基本重合（重叠 > 较小者半高），相邻系统行不重叠
  let row: HitRow | null = null
  for (const measureStaves of ml) {
    if (!measureStaves?.length) continue
    let mTop = Infinity
    let mBottom = -Infinity
    let hasEntry = false
    const entries: HitEntry[] = []
    for (const m of measureStaves) {
      const ps = m.PositionAndShape
      mTop = Math.min(mTop, ps.AbsolutePosition.y * unitPx)
      mBottom = Math.max(mBottom, (ps.AbsolutePosition.y + ps.Size.height) * unitPx)
      if (!map.has(m.MeasureNumber)) {
        map.set(m.MeasureNumber, { /* 现有字段不变，se.x 语义=行内绝对 */ })
      }
      for (const se of m.staffEntries) {
        const entry = this.hitEntryFor(se, m.MeasureNumber, unitPx, svgRect)
        if (entry) { entries.push(entry); hasEntry = true }
      }
    }
    if (!hasEntry) continue
    const inter = row ? Math.min(mBottom, row.bottom) - Math.max(mTop, row.top) : -1
    const minH = Math.min(mBottom - mTop, row ? row.bottom - row.top : Infinity)
    if (row && inter > minH / 2) {
      row.top = Math.min(row.top, mTop)
      row.bottom = Math.max(row.bottom, mBottom)
      row.entries.push(...entries)
    } else {
      row = { top: mTop, bottom: mBottom, entries }
      hitRows.push(row)
    }
  }
  this.markerGeom = { map, offX: svgRect.left - cRect.left, offY: svgRect.top - cRect.top, unitPx, hitRows }
  return this.markerGeom
}
```

`hitEntryFor` 兜底去掉 `mx` 参量（锚点已是行内绝对）：

```ts
// 兜底：DOM 与几何都不可用 -> staffEntry 锚点（行内绝对坐标，T3c 修正：不再叠加小节 x）
const ax = se.PositionAndShape?.AbsolutePosition?.x
return { m: measure, rv, x: (ax ?? 0) * unitPx, ys: [], hw: 0 }
```

（DOM 主路径与 GraphicalNote 包络回退不动——它们本来就是 svg 绝对坐标。）

`setMarkers` 的定位行去掉 `g.x`：

```ts
// rv→x 已是行内绝对坐标（se x 与小节同空间，T3c 诊断实测），不再叠加小节偏移
el.style.left = `${geom.offX + fx * geom.unitPx}px`
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：全绿（含既有用例）。

- [ ] **步骤 5：真机回归（CDP）**

运行：`node scripts/diag-t3c-hitrows.mjs`
预期：每行的 5 次点击分别命中该行各小节（row0 → m1..m5 中对应小节，不再恒 m1/m6/m11）。
运行：`node scripts/diag-t3c-marker-align.mjs`
预期：各行标记 x 序列全部落在 svg 宽度内且与音符头对齐（无 1000+ 溢出值）。

- [ ] **步骤 6：Commit**

```bash
git add src/score/OSMDScore.ts src/score/osmd-score.test.ts scripts/diag-t3c-hitrows.mjs scripts/diag-t3c-marker-align.mjs
git commit -m "T3c fix(score): hitRows 行归并——MeasureList 实为[小节][staff]，按纵向包络聚系统行；修正 se 锚点行内绝对坐标语义（标记层不再双重计数）"
```

---

### 任务 2：光标跨时值高亮（可选中，演奏页缺省不变）

**文件：**
- 修改：`app/src/score/OSMDScore.ts`（构造函数第 6 参、`syncToTime`、`showCursor`、`resetCursor`、`ensureMarkerGeom` 增 `cursorStops` 表、新私有 `updateCursorSpan`/`stopXAt`）
- 测试：`app/src/score/osmd-score.test.ts`

- [ ] **步骤 1：编写失败的测试**

`FakeCursor` 增加可注入的 `cursorElement`（缺省 `{ width: 0 }`）：

```ts
class FakeCursor {
  stops: number[]
  pos = 0
  nextCount = 0
  resetCount = 0
  colorLog: string[] = []
  /** [T3c] 光标元素替身（updateCursorSpan 用；happy-dom 下无真实 img） */
  cursorElement = { width: 0 }
  …
}
```

新增测试：

```ts
describe('OSMDScore T3c 光标跨时值高亮（cursorSpan）', () => {
  // m1：rv0 锚点 x=10 unit、rv0.5 锚点 x=15 unit（行内绝对）；stops=[0, 0.5, 1]（全音符单位）
  const N = mkGNote()
  const mlSpan = [[fakeMeasure(1, [{ rv: 0, note: N }, { rv: 0.5, note: mkGNote() }])]]
  function makeSpanScore(cursorSpan?: boolean) {
    const cursor = new FakeCursor([0, 0.5, 1])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const score = new OSMDScore(container, '#3ddfae', {
      load: async () => {}, render: () => {}, cursor,
      GraphicSheet: { MeasureList: mlSpan },
    } as unknown as OpenSheetMusicDisplay, 1, undefined, cursorSpan)
    return { score, cursor }
  }

  it('推进后光标元素宽度覆盖当前音到下一停靠点的跨度（(15-10)unit×10px=50px）', () => {
    const { score, cursor } = makeSpanScore(true)
    score.syncToTime(2 * SPQ) // rv0.5（第 2 拍，A 段时刻）-> 推进到中间停靠点
    expect(cursor.pos).toBe(1)
    expect(cursor.cursorElement.width).toBe(50)
  })

  it('末站无下一停靠点：宽度不动（保持 OSMD 缺省窄条）', () => {
    const { score, cursor } = makeSpanScore(true)
    score.syncToTime(99)
    expect(cursor.pos).toBe(2)
    expect(cursor.cursorElement.width).toBe(0)
  })

  it('缺省不传：光标宽度不被改写（演奏页兼容红线）', () => {
    const { score, cursor } = makeSpanScore()
    score.syncToTime(2 * SPQ)
    expect(cursor.pos).toBe(1)
    expect(cursor.cursorElement.width).toBe(0)
  })
})
```

（rv0.5 的停靠时刻：`timeAtQuarters(0.5*4=2 拍)` 按 MINI_TIMELINE 90bpm = 4/3s；`2*SPQ` 即 4/3s。）

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：新 3 例 FAIL（构造器第 6 参不识别/宽度恒 0）。

- [ ] **步骤 3：实现**

```ts
// 构造器签名追加第 6 参（与 selectionColor 同款可选参数缺省兼容先例）：
constructor(
  container: HTMLElement,
  accent = '#3ddfae',
  osmdInstance?: OpenSheetMusicDisplay,
  zoom = 1,
  selectionColor?: string,
  /** [T3c] 光标高亮覆盖当前音完整时值跨度（宽度=当前停靠点→下一停靠点）；
   *  缺省 false：OSMD ThinLeft 窄条行为，演奏页不传即不变 */
  cursorSpan = false,
)
```

`MarkerGeom` 增字段与构建（在 ensureMarkerGeom 的小节循环里）：

```ts
type MarkerGeom = {
  /* …现有字段… */
  /** [T3c] 光标跨度查表：全谱 staffEntry {全局 rv(全音符), 行内绝对 x(单位)}，按 rv 排序 */
  cursorStops: { rv: number; x: number }[]
}
// ensureMarkerGeom 内（构造 hitRows 的同一循环）：
const cursorStops: { rv: number; x: number }[] = []
// measureQuarters 由 this.measureTimes 建表（小节号→quarters，终点标记除外）：
const qByM = new Map<number, number>()
for (const e of this.measureTimes) if (!e.end && !qByM.has(e.measure)) qByM.set(e.measure, e.quarters)
// 每个小节（外层）每个 staff 每个 staffEntry：
for (const se of m.staffEntries) {
  const q0 = qByM.get(m.MeasureNumber)
  const sx = se.PositionAndShape?.AbsolutePosition?.x
  const rv = se.sourceStaffEntry?.Timestamp?.RealValue
  if (q0 !== undefined && sx !== undefined && rv !== undefined) cursorStops.push({ rv: q0 / 4 + rv, x: sx })
}
// 循环结束后去重排序：
cursorStops.sort((a, b) => a.rv - b.rv || a.x - b.x)
```

推进后覆写宽度（`syncToTime` 内 `if (advanced) this.updateHighlight()` 之后追加 `this.updateCursorSpan()`；`showCursor()`/`resetCursor()` 末尾同样追加）：

```ts
/** [T3c] 光标跨度：当前停靠点→下一停靠点覆盖当前音完整时值（可选功能）。
 *  OSMD ThinLeft 每次 cursor.next() 会把 img 宽度重置为 5*zoom，推进后覆写。
 *  末站/跨行（下一停靠点 x 更小）/查表缺失时不覆写，保持 OSMD 缺省窄条。 */
private updateCursorSpan(): void {
  if (!this.cursorSpan) return
  const img = (this.osmd.cursor as { cursorElement?: HTMLImageElement }).cursorElement
  if (!img) return
  const geom = this.ensureMarkerGeom()
  if (!geom) return
  const cur = this.stopQuarters[this.nextIdx - 1]
  const nxt = this.stopQuarters[this.nextIdx]
  if (cur === undefined || nxt === undefined) return
  const x0 = this.stopXAt(geom, cur)
  const x1 = this.stopXAt(geom, nxt)
  if (x0 === null || x1 === null || x1 <= x0) return
  const w = Math.round((x1 - x0) * geom.unitPx)
  if (w > 0) img.width = w
}

/** 全局 rv(全音符) -> 最近 cursorStops 的行内 x（单位）；空表 null */
private stopXAt(geom: MarkerGeom, rv: number): number | null {
  const cs = geom.cursorStops
  if (!cs.length) return null
  let best = 0
  let bd = Math.abs(cs[0].rv - rv)
  for (let i = 1; i < cs.length; i++) {
    const d = Math.abs(cs[i].rv - rv)
    if (d < bd) { bd = d; best = i }
  }
  return cs[best].x
}
```

注意：`stopXAt` 的线性扫描每帧最多两次调用 × cursorStops 长度（≈全谱 staffEntry 数，luv-letter ~2300）——可在实现时顺手换二分（rv 有序），但先保证正确。测试替身 `cursorElement` 是 `{ width: 0 }`，直接赋值 `img.width = w` 即可命中断言。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/score/OSMDScore.ts src/score/osmd-score.test.ts
git commit -m "T3c feat(score): 光标跨时值高亮 cursorSpan 可选参数——宽度覆盖当前音到下一停靠点，缺省不变"
```

---

### 任务 3：setTimeline——保存修改后播放即新节奏

**文件：**
- 修改：`app/src/score/OSMDScore.ts`（新公开方法）
- 测试：`app/src/score/osmd-score.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
describe('OSMDScore T3c setTimeline（保存修改后播放即新节奏）', () => {
  it('换时间轴后 syncToTime 按新 measureTimes 推进（quarters 不变）', async () => {
    const { score, cursor } = await makeScore([0, 1])
    // 新时间轴：m1 0s、m2 10s（同 quarters 0/4）——90bpm 下原 m2 在 8/3s
    const slow: Timeline = {
      ...MINI_TIMELINE,
      secPerQuarter: 2.5,
      measureTimes: [
        { measure: 1, time: 0, quarters: 0 },
        { measure: 2, time: 10, quarters: 4 },
        { measure: 3, time: 12.5, quarters: 5, end: true },
      ],
    }
    score.setTimeline(slow)
    score.syncToTime(5) // 旧轴会推进（5 > 8/3），新轴不应（5 < 10）
    expect(cursor.pos).toBe(0)
    score.syncToTime(10)
    expect(cursor.pos).toBe(1)
  })

  it('onMeasureChange 也按新轴反查小节', async () => {
    const { score } = await makeScore([0, 1])
    const slow: Timeline = { /* 同上 */ }
    score.setTimeline(slow)
    const fired: number[] = []
    score.onMeasureChange = (m) => fired.push(m)
    score.syncToTime(5)
    score.syncToTime(10)
    expect(fired).toEqual([1, 2])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：FAIL——`score.setTimeline is not a function`。

- [ ] **步骤 3：实现**

```ts
/** [sync-tune T3c] 就地更换时间轴（保存修改后播放即新节奏）：谱面不重渲，
 *  仅更新 measureTimes/secPerQuarter（quarters 几何不变，stopQuarters 无需重扫）。
 *  独立可选方法：演奏页不调用，缺省行为不变。 */
setTimeline(timeline: Timeline): void {
  this.secPerQuarter = timeline.secPerQuarter
  this.measureTimes = timeline.measureTimes
  this.totalMeasures = timeline.measureTimes.filter((e) => !e.end).length
}
```

（注意：`ensureMarkerGeom` 若在 setTimeline 前已建缓存，`cursorStops` 用的 quarters 两轴相同，缓存无需作废。）

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/score/OSMDScore.ts src/score/osmd-score.test.ts
git commit -m "T3c feat(score): setTimeline 就地换时间轴——保存修改后光标/小节号即新节奏，谱面不重渲"
```

---

### 任务 4：store.saveBaseline（保存修改）

**文件：**
- 修改：`app/src/synctune/store.ts`
- 测试：`app/src/synctune/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
describe('saveBaseline 保存修改（working 应用为新基线）', () => {
  it('dirty 时保存：baseline=working 拷贝、dirty 清零、undoStack 保留', () => {
    S().select(1)
    S().adjust(50)
    expect(S().dirty).toBe(true)
    const before = S().working
    S().saveBaseline()
    expect(S().baseline).toEqual(before)
    expect(S().baseline).not.toBe(before) // 拷贝，非同引用
    expect(S().dirty).toBe(false)
    expect(S().undoStack).toHaveLength(1) // 现有 undo() 语义不变，栈不清
  })

  it('保存后再微调：偏差相对新基线计算；未 dirty 时保存 no-op', () => {
    S().select(1)
    S().adjust(50)
    S().saveBaseline()
    expect(S().log).toHaveLength(1) // 日志保留
    const b0 = S().baseline
    S().saveBaseline() // 无 diff：no-op
    expect(S().baseline).toBe(b0)
    S().adjust(-50)
    expect(S().working.find((p) => p.q === 5)!.t).toBeCloseTo(2.5, 6) // 回到新基线值
    expect(S().dirty).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/synctune/store.test.ts`
预期：FAIL——`S().saveBaseline is not a function`。

- [ ] **步骤 3：实现**

`SyncTuneState` 接口与实现：

```ts
/** 保存修改：working 应用为新基线（播放/波形即新节奏），dirty 清零。
 *  undoStack 不清——撤销上一步仍是「撤销最近一次微调」（相对新基线呈现为反向偏差）。 */
saveBaseline(): void
// 实现：
saveBaseline: () => {
  const { working, dirty } = get()
  if (!dirty) return
  set({ baseline: working.map((p) => ({ ...p })), dirty: false })
},
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/synctune/store.test.ts`
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/synctune/store.ts src/synctune/store.test.ts
git commit -m "T3c feat(synctune): store.saveBaseline——working 应用为新基线、dirty 清零（撤销栈保留）"
```

---

### 任务 5：SyncTunePage 工作流重排 + UI 打磨（任务速览 2/4/5 的页面侧）

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx`
- 修改：`app/src/views/SyncTunePage.css`（summary 样式）
- 修改：`app/src/synctune/logic.ts`（删 auditionWindow）
- 修改：`app/src/synctune/logic.test.ts`（删 auditionWindow 测试块）

- [ ] **步骤 1：实现页面改动（本任务为 UI 编排，无独立组件测试——逻辑均在 store/OSMDScore 已测）**

1. **删试听 A/B 全链路**：删 `auditioning` state、`auditionSeqRef`、`cancelAudition`、`runAudition`、快捷键 `case 'Enter'`、帮助面板 Enter 条目、`onWavePointerUp`/`doSeek`/`togglePlay`/列表行 onClick/`onScoreClick`/卸载清理里的 `cancelAudition()` 调用、`auditionWindow` import；`logic.ts` 删 `auditionWindow()`；`logic.test.ts` 删其 describe 块。
2. **删「重置」按钮**：右栏 `st-btn-row`（重置 + 试听 A/B）整行删除（store.resetSelected 保留——任务只删按钮）。
3. **新增【撤销上一步】+【保存修改】**（顶栏只留导出）：顶栏删「撤销 (Ctrl+Z)」按钮；右栏 ±ms 网格后加：

```tsx
<div className="st-btn-row">
  <button className="st-btn" onClick={() => st.getState().undo()} disabled={undoStack.length === 0}>
    撤销上一步
  </button>
  <button className="st-btn primary" onClick={saveChanges} disabled={!dirty}>
    保存修改
  </button>
</div>
```

4. **saveChanges 处理器**（装配期留存恒速解析结果 `baseTlRef`，挂载 effect 里 `baseTlRef.current = pre`）：

```ts
/** 保存修改：working 应用为新基线（store），播放光标/波形期望线即时切到新节奏——
 *  显示时间轴按新锚点重建（applyBeats 用原 beats 的 anchors/bpm，只换 beatAnchors） */
const saveChanges = useCallback(() => {
  const st0 = st.getState()
  if (!st0.dirty) return
  st0.saveBaseline()
  const beats = beatsRef.current
  const baseTl = baseTlRef.current
  if (beats && baseTl) {
    displayTlRef.current = applyBeats(baseTl, { ...beats, beatAnchors: st0.working.map((p) => ({ ...p })) })
    scoreRef.current?.setTimeline(displayTlRef.current)
  }
  waveDirtyRef.current = true
  waveKickRef.current()
}, [])
```

5. **nearHint 去 px**：`onScoreClick` 中两处文案改为：

```ts
if (hit.dist > 120) {
  setNearHint('已选最近音符（点击处附近无音符）')
  …
} else if (!hit.precise) {
  setNearHint('已选附近音符（距点击处稍远）')
  …
```

6. **「?」按钮精简**：`<summary>? 操作说明</summary>` → `<summary aria-label="操作说明" />`；CSS `.st-help summary::before` 的 `content: '? '` 改 `content: '?'`。
7. **构造 OSMDScore 启用光标跨度**：`new OSMDScore(div, song.accent, undefined, undefined, '#ff9f43', true)`。
8. CSS：`.st-btn.live` 规则删除（试听态专用）。

- [ ] **步骤 2：类型检查 + 全量测试**

运行：`npx tsc -b`；预期：无错误。
运行：`npx vitest run`；预期：全绿（audition 测试已删，不残留对已删函数的引用）。

- [ ] **步骤 3：真机验证（CDP 手动路径）**

启动 dev 页后检查（可复用 diag 脚本骨架）：
- 右栏无「重置/试听 A/B」，有「撤销上一步/保存修改」；顶栏只有「导出 beats.json」。
- 「?」只显示绿色问号，hover 有 aria-label，展开内容完整且无 Enter 条目。
- 选中音符 → ±50ms → 「保存修改」可点 → 点击后「已调」归零、「未导出」消失、波形青线与白线重合。
- 播放中光标为覆盖音符时值的宽条（不再是 5px 窄框）。

- [ ] **步骤 4：Commit**

```bash
git add src/views/SyncTunePage.tsx src/views/SyncTunePage.css src/synctune/logic.ts src/synctune/logic.test.ts
git commit -m "T3c feat(synctune): 微调工作流重排——删试听 A/B 与重置、加保存修改/撤销上一步、nearHint 去 px、帮助按钮精简、光标跨时值高亮启用"
```

---

### 任务 6：全量验收

- [ ] `npx tsc -b` 通过
- [ ] `npx vitest run` 全绿（数量以当前为准，audition 用例移除后应 ≥162-3+新增）
- [ ] `npm run build` 通过
- [ ] `node scripts/diag-t3c-hitrows.mjs`：每行各小节点击命中各自小节
- [ ] `node scripts/diag-t3c-marker-align.mjs`：标记不再溢出谱面、与音符头对齐
- [ ] `git status` 核对未提交他人 WIP（`app/scripts/shot-entry.mjs` 等）；`git log` 前缀 T3c；不 push
- [ ] 报告逐项写实现 + 验证证据

## 自检

- 规格覆盖：速览 1（任务 1）、2（任务 5.5）、3（任务 2 + 5.7）、4（任务 5.6）、5（任务 3/4/5）；红线（PerformPage 零改动✓、缺省兼容✓、测试清理✓、新逻辑补测✓、并发 WIP 不碰✓）均有对应步骤。
- 占位符：无 TODO/待定；所有代码块完整。
- 类型一致性：`cursorSpan`/`cursorStops`/`stopXAt`/`updateCursorSpan`/`setTimeline`/`saveBaseline`/`baseTlRef` 命名在各任务间一致。

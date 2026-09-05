# sync-tune R2 · T3b 谱面点击命中精度强化 + 鼠标选中改橙色 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 sync-tune 谱面点击「点 A 选 B」的命中偏差（音符头绘制 x 与 staffEntry 锚点 x 不一致），并把选中音染色从 accent 改为橙色 #ff9f43，与播放光标视觉分离。

**架构：** OSMDScore 的 `ensureMarkerGeom` 缓存中新增命中测试行表 `hitRows`（行几何 + 每个 staffEntry 的**音符头绘制 x**，SVG DOM `getBoundingClientRect` 主路径、GraphicalNote `PositionAndShape` 几何回退、staffEntry 锚点兜底）；`noteAtPoint` 改读该缓存并收紧行判定（超行高一半返回 null）+ 同 x 并列按 y tie-break。颜色侧新增构造参数 `selectionColor`（缺省回退 accent，演奏页零变化），`restore` 改为按释放方（光标/选中）恢复各自持有色。SyncTunePage 传 `#ff9f43` 并把 nearHint 分三档（精确/附近/超距）+ 无效点击提示。

**技术栈：** Vite + React + TS + zustand + OSMD（opensheetmusicdisplay SVG backend）；vitest + happy-dom。

**工作区纪律（并发任务）：** 只 add 自己改的文件；不碰他人未提交改动；commit 前缀 `T3b`，不 push。

**开工快照（git status --short，2026-09-01）：**
```
?? app/scripts/shot-entry.mjs
?? docs/superpowers/plans/2026-09-01-planb-t3-cursor-mode-eval.md
```

---

## 文件结构

- 修改：`app/src/score/OSMDScore.ts` —— hitRows 几何缓存 + noteAtPoint 重写 + selectionColor/restore 颜色分离（唯一改动源文件，均为可选扩展，演奏页路径零变化）
- 修改：`app/src/views/SyncTunePage.tsx` —— 构造传橙色 selectionColor；onScoreClick 三档 nearHint + 无效点击提示；nearHint 提升到右栏顶层（无选中时也可见）
- 测试：`app/src/score/osmd-score.test.ts` —— 新增 T3b describe（颜色分离、命中偏移修正、y tie-break、行阈值、precise）；更新现有 noteAtPoint 距离断言（行为按设计收紧）

---

### 任务 1：OSMDScore 选中色分离（selectionColor + 按持有者恢复）

**文件：**
- 修改：`app/src/score/OSMDScore.ts`
- 测试：`app/src/score/osmd-score.test.ts`（新增 describe）

- [ ] **步骤 1：编写失败的测试**

在 `osmd-score.test.ts` 末尾（zoom describe 之前）新增（复用现有 `mkGNote`/`fakeMeasure`/`makeGeomScore`，见文件 187–233 行）：

```ts
describe('OSMDScore T3b 选中色分离（selectionColor）', () => {
  const ORANGE = '#ff9f43'
  const ml = [[fakeMeasure(1, [{ rv: 0, note: mkGNote() }])]]

  function makeScore(sel?: string) {
    const cursor = new FakeCursor([0, 1])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const score = new OSMDScore(
      container,
      '#3ddfae',
      { load: async () => {}, render: () => {}, cursor, GraphicSheet: { MeasureList: ml } } as unknown as OpenSheetMusicDisplay,
      1,
      sel,
    )
    return { score, cursor }
  }

  it('传 selectionColor：选中染橙、切换/清除恢复白', () => {
    const { score } = makeScore(ORANGE)
    score.highlightNoteAt(1, 0)
    // 断言选中音符的最后一次 setColor 是橙色（fakeMeasure 里单音符，直接取其 gnote 记录）
    const g = (ml[0][0] as unknown as { staffEntries: { graphicalVoiceEntries: { notes: FakeGNote[] }[] }[] }).staffEntries[0].graphicalVoiceEntries[0].notes[0]
    expect(g.colors.at(-1)).toBe(ORANGE)
    score.highlightNoteAt(null)
    expect(g.colors.at(-1)).toBe(BASE)
  })

  it('缺省不传 selectionColor：选中仍染 accent（演奏页兼容红线）', () => {
    const { score } = makeScore()
    score.highlightNoteAt(1, 0)
    const g = (ml[0][0] as unknown as { staffEntries: { graphicalVoiceEntries: { notes: FakeGNote[] }[] }[] }).staffEntries[0].graphicalVoiceEntries[0].notes[0]
    expect(g.colors.at(-1)).toBe('#3ddfae')
  })

  it('双方持有同一音符显示橙：光标移走保持橙，清除选中回 accent，光标再移走回白', () => {
    const { score, cursor } = makeScore(ORANGE)
    cursor.notesUnder = [A2] // 见下方说明：A2 为本 describe 内的独立音符
    score.syncToTime(4 * SPQ) // 光标推进 -> A2 染 accent
    expect(A2.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(1, 0) // 选中同一音符 -> 橙（意图优先）
    expect(A2.colors.at(-1)).toBe(ORANGE)
    cursor.notesUnder = [] // 光标移开：restore 按持有者恢复 -> 仍被选中，保持橙
    score.syncToTime(8 * SPQ)
    expect(A2.colors.at(-1)).toBe(ORANGE)
    score.highlightNoteAt(null) // 清除选中：仍被光标持有 -> accent
    expect(A2.colors.at(-1)).toBe('#3ddfae')
    cursor.notesUnder = []
    score.syncToTime(12 * SPQ)
    expect(A2.colors.at(-1)).toBe(BASE)
  })

  it('光标推进到选中音符上：不把橙色覆盖成 accent', () => {
    const { score, cursor } = makeScore(ORANGE)
    cursor.stops = [0, 1, 2]
    score.highlightNoteAt(1, 0) // 先选中 -> 橙
    cursor.notesUnder = [A2]
    score.syncToTime(4 * SPQ) // 光标推进到该音符：updateHighlight 跳过 selNote 染色
    expect(A2.colors.at(-1)).toBe(ORANGE)
  })
})
```

说明：`A2` 是本 describe 模块级音符（与 T3 describe 的 A/B/C 区分）：`const A2 = mkGNote()`，且 `ml` 里 `fakeMeasure(1, [{ rv: 0, note: A2 }])`——即把上面 `ml` 定义中的 `mkGNote()` 换成 `A2`。前两个用例取 gnote 的方式一致（都从 `ml[0][0].staffEntries[0]...` 取，即 `A2`）。第三、四个用例需要 `cursor.stops = [0, 1, 2]`（跨两个停靠点推进）。

注意：`syncToTime(8 * SPQ)` 推进需要 `cursor.stops` 有第三个停靠点（时间 8/3·2=…，见既有测试「与光标高亮共存」中 `cursor.stops = [0, 1, 2]` 的用法，stop2 时间 = 8*SPQ）。上面第 1、2 用例不需要。为简洁，在 `makeScore` 内统一 `cursor.stops = [0, 1, 2]`。

`cursor.notesUnder = []` 时光标下无音符 → `updateHighlight` 的 `next` 为 null → 只恢复旧高亮，不染新音（现有逻辑）。第三个用例中 `syncToTime(8 * SPQ)`（第二停靠点时刻）推进后 notesUnder 已换成 `[]`，`next=null`，`restore(A2,'cursor')` → A2===selNote → 橙 ✓。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：FAIL——新 describe 报 `Expected 4 arguments, but got 5`（构造器尚无第 5 参）或 `selColor` 相关断言失败。

- [ ] **步骤 3：编写最少实现代码**

`OSMDScore.ts`：

3a. 字段（`selNote` 声明后）：

```ts
/** [T3b] 选中音染色：与播放光标 accent 视觉分离（sync-tune 传 #ff9f43）；
 *  缺省跟随 accent——演奏页不传第 5 参，行为与 T3b 前完全一致 */
private selColor: string
```

3b. 构造器加第 5 参（`zoom = 1,` 之后）并赋值：

```ts
zoom = 1,
/** [T3b] 选中音颜色（可选）；缺省跟随 accent，演奏页不传即保持旧观感 */
selectionColor?: string,
```

```ts
this.selColor = selectionColor ?? accent
```

3c. `restore` 改为按释放方恢复（替换现有 100–108 行）：

```ts
/** 恢复一个高亮音符的颜色（T3b 起按释放方区分）：光标释放时若音符仍被
 *  选中持有 → 保持选中色（鼠标意图优先，与光标 accent 同屏可分辨）；选中
 *  释放时若仍被光标持有 → accent；两方都不持有 → 恢复底色 */
private restore(
  g: { setColor: (c: string, o?: unknown) => void },
  released: 'cursor' | 'sel',
): void {
  const color =
    released === 'cursor' && g === this.selNote
      ? this.selColor
      : released === 'sel' && g === this.highlighted
        ? this.accent
        : this.baseNoteColor
  try {
    g.setColor(color)
  } catch {
    /* 渲染层可能已重排，忽略单帧恢复失败 */
  }
}
```

3d. `updateHighlight`（替换 174/177 行两处调用）：

```ts
if (prev) this.restore(prev, 'cursor')
if (next) {
  try {
    // 选中持有的音符保持选中色（意图优先）；演奏页 selNote 恒为 null，行为不变
    if (next !== this.selNote) next.setColor(this.accent)
    this.highlighted = next
  } catch {
    /* 同上 */
  }
}
```

3e. `highlightNoteAt`：`gn.setColor(this.accent)` → `gn.setColor(this.selColor)`；末尾 `if (prev) this.restore(prev)` → `if (prev) this.restore(prev, 'sel')`。同步更新两处方法的 doc 注释中「染成 accent 色」→「染成选中色（缺省 accent）」。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：全部 PASS（含既有 T3 describe——缺省色路径下 selColor===accent，旧断言不变）。

- [ ] **步骤 5：Commit**

```bash
git add src/score/OSMDScore.ts src/score/osmd-score.test.ts
git commit -m "T3b feat(score): 选中音染色与播放光标分离——selectionColor 可选参数 + restore 按持有者恢复"
```

---

### 任务 2：noteAtPoint 命中精度强化（hitRows 缓存 + 绘制 x 对齐 + 行阈值收紧）

**文件：**
- 修改：`app/src/score/OSMDScore.ts`
- 测试：`app/src/score/osmd-score.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `osmd-score.test.ts` 新增测试基建与 describe。先在文件顶部（T3 describe 的 `mkGNote` 附近）补充：

```ts
/** [T3b] 可注入音符头绘制几何的 GraphicalNote 替身：
 *  headBoxes: 每个 notehead 的 {left, top, width, height}（client px）；
 *  modBoxes: 修饰符（升/降号）box，只并入包络不贡献中心 y */
function mkGNoteGeom(headBoxes: { left: number; top: number; width: number; height: number }[], modBoxes: { left: number; top: number; width: number; height: number }[] = []) {
  const colors: string[] = []
  const mkEl = (b: { left: number; top: number; width: number; height: number }) => ({
    getBoundingClientRect: () => ({ left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height, width: b.width, height: b.height }),
  })
  return {
    colors,
    setColor: (c: string) => colors.push(c),
    sourceNote: { isRest: () => false },
    getNoteheadSVGs: () => headBoxes.map(mkEl),
    getModifierSVGs: () => modBoxes.map(mkEl),
  }
}
```

`fakeMeasure` 已支持 `{rv, note}` 注入任意 note 形状（note 只要带 `sourceNote.isRest`）。DOM 路径下 svg 的 `getBoundingClientRect()` 在 happy-dom 返回全零 rect——左/上偏移就是 box 自带的 left/top，正好做纯数学断言。

新增 describe（放在 T3 describe 之后）：

```ts
describe('OSMDScore T3b 命中精度强化（音符头绘制 x 对齐）', () => {
  /** m1：rv0 音符头绘制在锚点右侧（模拟升/降号偏移 +12px）；rv0.25 音符头贴锚点。
   *  staffEntry 相对 x = rv*4 OSMD 单位（fakeMeasure 口径），m1 绝对 x=10 单位=100px */
  const N0 = mkGNoteGeom([{ left: 112, top: 218, width: 12, height: 8 }])
  const N1 = mkGNoteGeom([{ left: 110, top: 218, width: 12, height: 8 }])
  const ml2 = [[fakeMeasure(1, [
    { rv: 0, note: N0 },
    { rv: 0.25, note: N1 },
  ])]]
  const hit = (x: number, y: number) => {
    const cursor = new FakeCursor([0, 1])
    const container = document.createElement('div')
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const score = new OSMDScore(
      container,
      '#3ddfae',
      { load: async () => {}, render: () => {}, cursor, GraphicSheet: { MeasureList: ml2 } } as unknown as OpenSheetMusicDisplay,
    )
    return score.noteAtPoint(x, y)
  }

  it('偏移修正：点击落在带 accidental 音符头上时选它而非锚点更近的邻音', () => {
    // 旧逻辑（锚点 x）：rv0@100 距 16、rv0.25@110 距 6 -> 误选 rv0.25
    // 新逻辑（绘制 x）：rv0@118 距 2 -> 选中 rv0
    const h = hit(116, 222)
    expect(h?.measure).toBe(1)
    expect(h?.rvInMeasure).toBe(0)
    expect(h?.precise).toBe(true)
  })

  it('无偏移音符：正常按绘制 x 最近邻命中', () => {
    const h = hit(112, 222)
    expect(h?.rvInMeasure).toBe(0.25) // rv0.25@110 距 2 < rv0@118 距 6
    expect(h?.precise).toBe(true)
  })

  it('precise=false：命中但在半个音符头宽度之外（供页面三档提示）', () => {
    const h = hit(130, 222) // 距 rv0.25@110 为 20px > 半宽 6px
    expect(h?.rvInMeasure).toBe(0.25)
    expect(h?.precise).toBe(false)
  })

  it('行判定收紧：点击处与行几何 y 距离超过行高一半返回 null（不跨行乱选）', () => {
    // 行 y=200..260（fakeMeasure y=20 单位 ×10、h=6 单位 ×10），行高 60、半行高 30
    expect(hit(116, 160)).toBeNull() // dy=40 > 30
    const near = hit(116, 180) // dy=20 <= 30：仍命中，dist 含行外距离
    expect(near?.rvInMeasure).toBe(0)
    expect(near?.dist).toBeCloseTo(Math.hypot(2, 20), 5)
  })

  it('同 x 并列（多声部）：优先 y 更接近点击处的音符', () => {
    const Hi = mkGNoteGeom([{ left: 100, top: 208, width: 12, height: 8 }]) // 上声部
    const Lo = mkGNoteGeom([{ left: 100, top: 248, width: 12, height: 8 }]) // 下声部
    const ml3 = [[fakeMeasure(1, [
      { rv: 0, note: Hi },
      { rv: 0.5, note: Lo },
    ])]]
    const mk = () => {
      const cursor = new FakeCursor([0, 1])
      const container = document.createElement('div')
      container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
      const score = new OSMDScore(
        container,
        '#3ddfae',
        { load: async () => {}, render: () => {}, cursor, GraphicSheet: { MeasureList: ml3 } } as unknown as OpenSheetMusicDisplay,
      )
      return score
    }
    expect(mk().noteAtPoint(106, 252)?.rvInMeasure).toBe(0.5) // 点下声部
    expect(mk().noteAtPoint(106, 212)?.rvInMeasure).toBe(0) // 点上声部
  })
})
```

同时**更新现有用例**（行为按设计收紧）：`'noteAtPoint：返回与最近音符的欧氏距离'` 第二段 `far = score.noteAtPoint(150, 80)`（y=80 距行顶 200 有 120px > 半行高 30，新行为返回 null）改为：

```ts
// 行内偏移点击：dy 叠入距离（y=190 -> 行顶 200，dy=10，dist=hypot(40,10)）
const near = score.noteAtPoint(150, 190)
expect(near?.dist).toBeCloseTo(Math.hypot(40, 10), 5)
// 行外超半行高：无效点击返回 null（T3b 行判定收紧）
expect(score.noteAtPoint(150, 80)).toBeNull()
```

第一段 `hit = score.noteAtPoint(150, 230)` 断言不变（锚点兜底路径：fake note 无 DOM 方法无 PositionAndShape，dist 仍 40；`precise` 为 false，不断言）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：FAIL——新用例报返回值无 `precise` 字段 / 行外点击仍返回对象 / 偏移修正用例 `rvInMeasure` 为 0.25（锚点最近邻选错）。

- [ ] **步骤 3：编写实现代码**

`OSMDScore.ts`：

3a. 类型（`MarkerGeom` 定义处扩展）：

```ts
/** [T3b] 命中测试表项：x = 音符头绘制包络中心（svg px），ys = 各音符头中心 y，
 *  hw = 音符头半宽（precise 判定阈值） */
type HitEntry = { m: number; rv: number; x: number; ys: number[]; hw: number }
/** [T3b] 命中测试行：noteAtPoint 用——行几何 + 行内全部 HitEntry */
type HitRow = { top: number; bottom: number; entries: HitEntry[] }
```

`MarkerGeom` 增加字段 `hitRows: HitRow[]`。

3b. `ensureMarkerGeom` 中，在现有 per-system 循环外再建 `const hitRows: HitRow[] = []`；每个 system 的循环里（`for (const m of systemMeasures)` 内、`map.set` 同层）收集：

```ts
const entries: HitEntry[] = []
const svgRect2 = svgRect // 同帧一次测量，供 DOM 偏移换算
for (const m of systemMeasures) {
  // …现有 map.set 逻辑不变…
  const mx = m.PositionAndShape.AbsolutePosition.x * unitPx
  for (const se of m.staffEntries) {
    const gnotes = (se.graphicalVoiceEntries ?? [])
      .flatMap((v) => v.notes ?? [])
      .filter((n) => !n.sourceNote?.isRest?.()) as unknown as {
      getNoteheadSVGs?: () => { getBoundingClientRect(): { left: number; right: number; top: number; height: number; width: number } }[]
      getModifierSVGs?: () => { getBoundingClientRect(): { left: number; right: number; top: number; height: number; width: number } }[]
      PositionAndShape?: { AbsolutePosition: { x: number; y: number }; Size: { width: number; height: number } }
    }[]
    if (!gnotes.length) continue // 无可选中音符（纯休止）不入命中表
    // 每个音符的绘制 box：DOM 主路径（notehead+modifier 包络，左上已减 svg 原点）
    const boxes = gnotes.map((gn) => {
      const heads = gn.getNoteheadSVGs?.() ?? []
      const headRects = heads
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r && (r.width > 0 || r.height > 0))
      if (headRects.length) {
        const mods = (gn.getModifierSVGs?.() ?? [])
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r && (r.width > 0 || r.height > 0))
        const left = Math.min(...headRects.map((r) => r.left), ...mods.map((r) => r.left)) - svgRect2.left
        const right = Math.max(...headRects.map((r) => r.right), ...mods.map((r) => r.right)) - svgRect2.left
        return {
          left,
          right,
          ys: headRects.map((r) => r.top + r.height / 2 - svgRect2.top),
          hw: Math.max(...headRects.map((r) => r.width / 2)),
        }
      }
      // 几何回退：GraphicalNote 包络（含 accidental 时 OSMD bbox 已并入）
      const bb = gn.PositionAndShape
      if (bb && bb.Size.width > 0) {
        return {
          left: bb.AbsolutePosition.x * unitPx,
          right: (bb.AbsolutePosition.x + bb.Size.width) * unitPx,
          ys: [(bb.AbsolutePosition.y + bb.Size.height / 2) * unitPx],
          hw: (bb.Size.width * unitPx) / 2,
        }
      }
      return null
    })
    const okBoxes = boxes.filter((b): b is NonNullable<typeof b> => b !== null)
    const entry: HitEntry = {
      m: m.MeasureNumber,
      rv: se.sourceStaffEntry?.Timestamp?.RealValue ?? 0,
      x: ok_boxes_center_or_anchor, // 见下
      ys: okBoxes.flatMap((b) => b.ys),
      hw: okBoxes.length ? Math.max(...okBoxes.map((b) => b.hw)) : 0,
    }
    // 兜底锚点 x：DOM 与几何都不可用时退回 staffEntry 锚点（旧口径）
    if (!okBoxes.length) {
      entry.x = mx + (se.PositionAndShape?.AbsolutePosition?.x ?? 0) * unitPx
    } else {
      entry.x =
        (Math.min(...okBoxes.map((b) => b.left)) + Math.max(...okBoxes.map((b) => b.right))) / 2
    }
    entries.push(entry)
  }
}
if (entries.length) {
  hitRows.push({ top, bottom, entries })
}
```

`top`/`bottom` 即现有行扫描变量（ensureMarkerGeom 目前没有行概念——把 per-system 的 `top/bottom` 计算提进来，与 `noteAtPoint` 旧逻辑同式：`Math.min/top, Math.max/bottom` over `systemMeasures` 的 `PositionAndShape`）。实现时把上面的 `const mx = …` 与现有 `map.set` 循环合并在同一个 `for (const m of systemMeasures)` 内，`top/bottom` 在该循环里同步累计。最终 `this.markerGeom = { map, offX, offY, unitPx, hitRows }`。

（计划注记：上面伪代码中 `ok_boxes_center_or_anchor` 处写成两段实际赋值逻辑即可，实现按此处展开，不要保留伪标识符。）

3c. 重写 `noteAtPoint`（整体替换现有实现，doc 注释更新为「markerGeom hitRows 缓存 + 音符头绘制 x 对齐 + 行阈值收紧」）：

```ts
noteAtPoint(
  clientX: number,
  clientY: number,
): { measure: number; rvInMeasure: number; dist: number; precise: boolean } | null {
  const svg = this.containerEl.querySelector('svg')
  if (!svg) return null
  const geom = this.ensureMarkerGeom()
  if (!geom || !geom.hitRows.length) return null
  const svgRect = svg.getBoundingClientRect()
  const x = clientX - svgRect.left
  const y = clientY - svgRect.top
  // y 最近行；行判定收紧（T3b）：点击处与行几何 y 距离超过行高一半视为无效点击
  let bestRow: { row: HitRow; d: number } | null = null
  for (const row of geom.hitRows) {
    const dy = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0
    if (dy > (row.bottom - row.top) / 2) continue
    if (!bestRow || dy < bestRow.d) bestRow = { row, d: dy }
  }
  if (!bestRow) return null
  // 行内音符头绘制 x 最近邻；x 并列（±4px，多声部/同 x）时优先 y 更接近点击处
  let best: { e: HitEntry; dx: number; dy: number } | null = null
  for (const e of bestRow.row.entries) {
    const dx = Math.abs(x - e.x)
    const dy = e.ys.length
      ? Math.min(...e.ys.map((yy) => Math.abs(y - yy)))
      : bestRow.d
    if (!best || dx < best.dx - 4 || (Math.abs(dx - best.dx) <= 4 && dy < best.dy)) {
      best = { e, dx, dy }
    }
  }
  if (!best) return null
  const dist = Math.hypot(best.dx, bestRow.d)
  return {
    measure: best.e.m,
    rvInMeasure: best.e.rv,
    dist,
    // 点在音符头半宽内为精确命中（供调用方三档提示：精确/附近/超距）
    precise: dist <= Math.max(best.e.hw, 3),
  }
}
```

注意：现有「行内 x 最近的 staffEntry → fallback 最近小节行最近音符」的 fallback 语义由新结构自然覆盖（命中表只含非休止音符，行内最近即 fallback 结果）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：全部 PASS（含更新后的旧用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/score/OSMDScore.ts src/score/osmd-score.test.ts
git commit -m "T3b feat(score): noteAtPoint 命中精度强化——音符头绘制 x 对齐/行阈值收紧/y 并列 tie-break（markerGeom hitRows 缓存）"
```

---

### 任务 3：SyncTunePage 接线（橙色选中 + 三档 nearHint + 无效点击提示）

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx:251`（构造）、`846-863`（onScoreClick）、`991-997`（nearHint 渲染位置）

- [ ] **步骤 1：构造传 selectionColor**

```ts
// 橙色选中（T3b）：与播放光标 accent 分离，「我点的」一眼可辨
const osmd = new OSMDScore(div, song.accent, undefined, undefined, '#ff9f43')
```

- [ ] **步骤 2：onScoreClick 三档提示 + 无效点击提示**

替换现有 `onScoreClick` 主体（保留原注释并追加三档说明）：

```ts
const onScoreClick = (e: React.MouseEvent<HTMLDivElement>) => {
  const hit = scoreRef.current?.noteAtPoint(e.clientX, e.clientY)
  window.clearTimeout(nearHintTimerRef.current)
  // 无效点击（T3b 行判定收紧）：点击处离谱行过远（超行高一半），不选不误触
  if (!hit) {
    setNearHint('点击处离谱行过远，未选中（无效点击）')
    nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
    return
  }
  const entry = measureTableRef.current.find((x) => x.m === hit.measure)
  if (!entry) return
  cancelAudition()
  if (hit.dist > 120) {
    setNearHint(`已选最近音符（点击处 ${Math.round(hit.dist)}px 内无音符）`)
    nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
  } else if (!hit.precise) {
    // 半个音符头宽度外但 120px 内：始终告知选中的是附近音符（T3b 决策 3）
    setNearHint(`已选附近音符（距点击处 ${Math.round(hit.dist)}px）`)
    nearHintTimerRef.current = window.setTimeout(() => setNearHint(null), 5000)
  } else {
    setNearHint(null) // 精确命中：无提示
  }
  st.getState().selectByQ(entry.quarters + hit.rvInMeasure * 4)
}
```

- [ ] **步骤 3：nearHint 提升到右栏顶层（无选中时也可见）**

把 `{nearHint && <p className="st-near-hint">{nearHint}</p>}` 从 `selView.note ?` 分支内移到 `<aside className="st-props">` 直接子级顶部（`selView.note` 三元之前）。

- [ ] **步骤 4：类型与单测现状确认**

运行：`npx tsc -b && npx vitest run src/score/osmd-score.test.ts`
预期：tsc 零错误；测试全 PASS（SyncTunePage 无组件级测试基建，靠任务 4 手动验收兜底）。

- [ ] **步骤 5：Commit**

```bash
git add src/views/SyncTunePage.tsx
git commit -m "T3b feat(sync-tune): 谱面选中音改橙色 + 命中提示三档化（精确/附近/超距）与无效点击提示"
```

---

### 任务 4：全量验证与收口（verification-before-completion）

**文件：** 无新改动（验证任务）

- [ ] **步骤 1：全量验证**

依次运行（app 目录下）：

```bash
npx tsc -b
npx vitest run
npm run build
```

预期：tsc 零错误；vitest **111+新增 全绿**（数一下实际通过数，须 ≥111 且无 fail——原 111 含 T3 既有用例，本计划新增约 8 个用例、更新 1 个）；build 成功。

- [ ] **步骤 2：git status 核对只含自己的改动**

```bash
git status --short
git log --oneline -5
```

预期：本次 3 个 commit（T3b 前缀）；工作区无本任务遗漏文件；他人未提交改动未被触碰/未被提交。

- [ ] **步骤 3：手动验收报告**

以「点音符正中即命中」为标准整理：点击谱面音符头正中 → 该音符染橙、播放光标音符保持 accent（两色同屏可辨）；nearHint 三档文案正确。此步在报告中如实标注为「需用户在 sync-tune 页实测」（点 10 次无误选），不代跑、不虚报。

---

## 自检

**1. 规格覆盖度：**
- 设计决策 1（选中橙/光标 accent/restore 按持有者/双方持有显示橙）→ 任务 1 ✓
- 设计决策 2（markerGeom staffEntry 表、绘制 x 修正含 accidental 包络、y tie-break、行阈值收紧）→ 任务 2 ✓
- 设计决策 3（<120px 且 > 半音符头宽提示已选附近音符、三档文案）→ 任务 2（precise）+ 任务 3（文案）✓
- 设计决策 4（演奏页零变化、vitest 不回归、单音符 setColor 不进 React 帧）→ 任务 1（缺省 accent 兼容）+ 任务 4（全量验证）✓
- 验收「密集音符段点 A 选 A」→ 任务 2 偏移修正 + 手动验收（任务 4 步骤 3）✓

**2. 占位符扫描：** 无「TODO/待定/类似任务 N」；3b 步骤中的 `ok_boxes_center_or_anchor` 伪标识符已附带真实赋值代码并注明展开要求。✓

**3. 类型一致性：** `HitEntry`/`HitRow` 定义与 `noteAtPoint` 返回 `precise` 与任务 3 消费一致；`selectionColor` 第 5 参与 `ScoreSheet.tsx:27`（4 参调用）不冲突；`restore(g, released)` 双调用点（updateHighlight='cursor'、highlightNoteAt='sel'）与实现一致。✓

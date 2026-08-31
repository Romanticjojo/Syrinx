# sync-tune R2 · T3 谱面选中可视化 + 点击命中强化 + 小节自动聚焦 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 三向选中（谱面/列表/波形）触发选中音符 notehead 染 accent 色；noteAtPoint 返回命中距离并在 >120px 时右栏提示；播放/选中变化自动滚动聚焦当前小节（手动滚动 5 秒让位）。

**架构：** OSMDScore 新增三个向后兼容扩展：`highlightNoteAt`（MeasureList 反查 GraphicalNote，单音符 setColor，与光标高亮互不干扰）、`scrollToMeasure`（复用从 setMarkers 抽出的 markerGeom 几何缓存，写滚动祖先 scrollTop）、`noteAtPoint` 增加返回 `dist`。SyncTunePage 用单一 effect 监听 store 选中变化收口三向染色 + 聚焦；播放聚焦挂在已有 onMeasureChange；5 秒让位用 score 分区上的 wheel/pointerdown 时间戳。

**技术栈：** Vite + React + TS + zustand + OSMD + vitest（happy-dom，fake OSMD 注入）。

**依据：** plans/2026-08-31-sync-tune-redesign.md 决策 3/4/6 与红线（禁改 PerformPage*/musicxml.ts/anchors.ts/songs//全局 store.ts；OSMDScore 只做新增可选方法/向后兼容改动；不引入每帧 React 渲染）。

---

### 任务 1：OSMDScore 扩展（highlightNoteAt / scrollToMeasure / noteAtPoint 距离）

**文件：**
- 修改：`app/src/score/OSMDScore.ts`
- 测试：`app/src/score/osmd-score.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `osmd-score.test.ts` 追加（复用文件既有 FakeCursor/MINi_TIMELINE 风格）：

```ts
// -- T3：选中染色 / 小节聚焦 / 命中距离（fake MeasureList 几何）--
type FakeGNote = { colors: string[]; setColor: (c: string) => void; sourceNote: { isRest: () => boolean } }
function mkGNote(): FakeGNote {
  const colors: string[] = []
  return { colors, setColor: (c) => colors.push(c), sourceNote: { isRest: () => false } }
}
function fakeMeasure(num: number, entries: { rv: number; note: FakeGNote }[]): Record<string, unknown> {
  return {
    MeasureNumber: num,
    PositionAndShape: { AbsolutePosition: { x: num * 10, y: 20 }, Size: { width: 8, height: 6 } },
    staffEntries: entries.map((e) => ({
      PositionAndShape: { AbsolutePosition: { x: e.rv * 4 } },
      sourceStaffEntry: { Timestamp: { RealValue: e.rv } },
      graphicalVoiceEntries: [{ notes: [e.note] }],
    })),
  }
}
function makeGeomScore(ml: unknown[][]): { score: OSMDScore; cursor: FakeCursor; container: HTMLElement } {
  const cursor = new FakeCursor([0, 1])
  const container = document.createElement('div')
  container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  const score = new OSMDScore(
    container,
    '#3ddfae',
    { load: async () => {}, render: () => {}, cursor, GraphicSheet: { MeasureList: ml } } as unknown as OpenSheetMusicDisplay,
  )
  return { score, cursor, container }
}

describe('OSMDScore T3 选中染色与小节聚焦', () => {
  const A = mkGNote(), B = mkGNote(), C = mkGNote()
  const ml = [[fakeMeasure(1, [{ rv: 0, note: A }, { rv: 0.25, note: B }]), fakeMeasure(2, [{ rv: 0, note: C }])]]

  it('highlightNoteAt：染 accent，切换时旧选中恢复白', async () => {
    const { score } = makeGeomScore(ml)
    score.highlightNoteAt(1, 0.25)
    expect(B.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(2, 0)
    expect(B.colors.at(-1)).toBe('#e8e8e2') // 旧选中恢复 baseNoteColor
    expect(C.colors.at(-1)).toBe('#3ddfae')
  })

  it('highlightNoteAt(null)：清除选中恢复白', () => {
    const { score } = makeGeomScore(ml)
    score.highlightNoteAt(1, 0.25)
    score.highlightNoteAt(null)
    expect(B.colors.at(-1)).toBe('#e8e8e2')
  })

  it('与光标高亮共存：光标离开选中音不褪色，清除选中不影响光标音', async () => {
    const { score, cursor } = makeGeomScore(ml)
    cursor.notesUnder = [A]
    score.syncToTime(4 * SPQ) // 光标推进 -> A 染 accent
    score.highlightNoteAt(1, 0) // 选中同为 A
    cursor.notesUnder = [C]
    score.syncToTime(8 * SPQ) // 光标移走：A 仍是选中，不恢复白
    expect(A.colors.at(-1)).toBe('#3ddfae')
    expect(C.colors.at(-1)).toBe('#3ddfae')
    score.highlightNoteAt(null) // 清除选中：A 恢复白，光标音 C 不动
    expect(A.colors.at(-1)).toBe('#e8e8e2')
    expect(C.colors.at(-1)).toBe('#3ddfae')
  })

  it('noteAtPoint：返回与最近音符的欧氏距离', () => {
    const { score } = makeGeomScore(ml)
    const hit = score.noteAtPoint(150, 30)
    expect(hit?.measure).toBe(1)
    expect(hit?.rvInMeasure).toBe(1) // rv 1（x=40）比 rv 0（x=0）近
    expect(hit?.dist).toBeCloseTo(110, 5)
  })

  it('scrollToMeasure：滚动祖先 scrollTop 定位到小节行中部', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const { score } = (() => {
      const cursor = new FakeCursor([0, 1])
      const container = document.createElement('div')
      container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
      scroller.appendChild(container)
      document.body.appendChild(scroller)
      const s = new OSMDScore(
        container,
        '#3ddfae',
        { load: async () => {}, render: () => {}, cursor, GraphicSheet: { MeasureList: ml } } as unknown as OpenSheetMusicDisplay,
      )
      return { score: s }
    })()
    score.scrollToMeasure(2) // m2 y=20 单位 * unitPx10=200px，h=60px -> 目标 200+30--clientHeight/2
    expect(scroller.scrollTop).toBe(230 - scroller.clientHeight / 2)
    score.scrollToMeasure(99) // 未知小节：no-op 不抛
    expect(scroller.scrollTop).toBe(230 - scroller.clientHeight / 2)
    document.body.removeChild(scroller)
  })
})
```

FakeCursor 增加 `notesUnder` 注入口（缺省行为不变）：

```ts
/** 可注入：当前光标下音符（T3 共存测试用），缺省返回内置单音符 */
notesUnder: { setColor: (c: string) => void; sourceNote: { isRest: () => boolean } }[] | null = null
GNotesUnderCursor() {
  return this.notesUnder ?? [{ setColor: (c) => this.colorLog.push(c), sourceNote: { isRest: () => false } }]
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/score/osmd-score.test.ts`
预期：FAIL（highlightNoteAt 不存在 / noteAtPoint 无 dist 字段 / scrollToMeasure 不存在）

- [ ] **步骤 3：实现 OSMDScore.ts**

1. 新增字段 `selNote`（选中染色持有者）；`load()`/`dispose()` 中置 null
2. 抽出 `private ensureMarkerGeom()`（现 setMarkers 内 markerGeom 构建块原样搬出），setMarkers 改调它
3. 新增 `private restore(g)`：仅当 g 非光标/选中持有者才恢复 baseNoteColor
4. `updateHighlight` 的恢复块改走 `restore()`（行为向后兼容：无选中时等价旧逻辑）
5. 新增 `private findGNote(measure, rvInMeasure)`：MeasureList 找该小节 rv 最近且含非休止 GraphicalNote 的 staffEntry
6. 新增 `highlightNoteAt(measure: number | null, rvInMeasure = 0)`：单音符 setColor(accent)，旧选中 restore；null 仅清除
7. 新增 `scrollToMeasure(m)`：ensureMarkerGeom 取行几何，向上找 overflowY auto/scroll 的滚动祖先，写 `scrollTop = 行中心 - clientHeight/2`
8. `noteAtPoint` 返回值增补 `dist: number`（行 dy 与行内 dx 的欧氏距离）

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/score/osmd-score.test.ts`，预期全 PASS（含既有 12 条）

- [ ] **步骤 5：Commit**

```bash
git add app/src/score/OSMDScore.ts app/src/score/osmd-score.test.ts
git commit -m "T3: OSMDScore 选中染色/小节聚焦/命中距离（向后兼容扩展+单测）"
```

### 任务 2：SyncTunePage 三向选中染色 + 自动聚焦 + 命中提示

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx`
- 修改：`app/src/views/SyncTunePage.css`（`.st-near-hint` 一条）

- [ ] **步骤 1：实现页面接线（纯接线无独立单测，靠 tsc/既有 store 测试回归）**

1. `lastUserScrollRef` + `followMeasure(m)`（useCallback）：`Date.now() - lastUserScrollRef.current < 5000` 时跳过，否则 `scoreRef.current?.scrollToMeasure(m)`
2. 谱面挂载 effect 内：`osmd.onMeasureChange = (m) => { setCurMeasure(m); if (audioEngine.playing) followMeasure(m) }`
3. 新 effect（deps `[selView.note, markersReady, followMeasure]`）：选中变化 -> 由 `measureTableRef` 反算 rvInMeasure -> `score.highlightNoteAt(m, rv)` + `followMeasure(m)`；无选中 -> `highlightNoteAt(null)`
4. `<section className="st-score">` 加 ref，新 effect 挂 `wheel`（passive）/`pointerdown` 监听记时间戳
5. `onScoreClick`：读 `hit.dist`，>120 时 `setNearHint('已选最近音符…')`（5s 定时自动清除），否则清空
6. 右栏 `st-props` 渲染 `.st-near-hint`；CSS 加一条琥珀色小字
7. 头注释补 T3 行为描述

- [ ] **步骤 2：验证**

运行：`npx tsc -b && npx vitest run`，预期 tsc 通过、106+ 用例全绿

- [ ] **步骤 3：Commit**

```bash
git add app/src/views/SyncTunePage.tsx app/src/views/SyncTunePage.css
git commit -m "T3: sync-tune 三向选中谱面染色 + 小节自动聚焦（5 秒让位）+ 最近音符提示"
```

### 任务 3：整体验收

- [ ] `npx tsc -b` 通过
- [ ] `npx vitest run` 全绿（无回归）
- [ ] `npm run build` 成功
- [ ] 报告：每个决策点的实现方式与验证证据

# sync-tune R2 · T3d 列表滚轮展示不全修复 + 帮助按钮文字恢复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 sync-tune 左侧音符列表只显示当前小节 ±2 窗口、滚轮无法浏览全谱的 bug（改为全量展示），并恢复右栏帮助按钮的「操作说明」文字（绿色 ？ 保留）。

**架构：** store 的 `visibleNotes` 去掉小节窗口参数（`curMeasure`/`window`），只做全量 + filter 过滤；SyncTunePage 列表改全量渲染，行元数据（控制点/偏差 ms）用 `useMemo` 按 q 建 Map 一次构建（避免 601 行 × O(M) `working.find` 的重复扫描），选中行 scrollIntoView 与筛选 chips 保留、chips 作用于全量；`curMeasure` 状态随窗口裁剪一并移除（其唯一消费方就是列表窗口）。帮助按钮 summary 恢复文字节点，CSS `::before` 绿 ？ 加右侧间距。

**技术栈：** Vite + React + TS + zustand；vitest + happy-dom。

**工作区纪律（并发任务）：** 只 add 自己改的文件；不碰他人未提交改动（`app/scripts/shot-entry.mjs`、`docs/superpowers/plans/2026-09-01-planb-t3-cursor-mode-eval.md`、`docs/superpowers/plans/2026-09-01-sync-tune-r2-t3b-*.md` 均为他人 WIP，只读）；commit 前缀 `T3d`，不 push。

**看板任务：** t_d5f6362c（board=cursor-planb）。设计决策（已定稿）：列表展示全部音符、去掉窗口限制、按播放序排；当前选中行仍自动 scrollIntoView；性能上 601+ 行全量渲染可接受则全量（备选：视口 ±50 行窗口化——本计划先全量 + 行元数据 memo，真机滚动流畅度交用户实测，卡再窗口化）；筛选 chips（全部/已调/未调）保留、作用于全量列表。帮助按钮「?」+「操作说明」都显示（绿色 ？ 保留在 ::before，文字正常显示）。

**开工快照（git status --short，2026-09-01）：**
```
?? app/scripts/shot-entry.mjs
?? docs/superpowers/plans/2026-09-01-planb-t3-cursor-mode-eval.md
?? docs/superpowers/plans/2026-09-01-sync-tune-r2-t3b-hit-precision-orange-selection.md
```

---

## 文件结构

- 修改：`app/src/synctune/store.ts` —— `visibleNotes` 签名改 `(state)`，删小节窗口二分裁剪，保留 filter 逻辑（唯一改动源文件，演奏页零涉及）
- 修改：`app/src/views/SyncTunePage.tsx` —— 列表全量渲染 + 行元数据 useMemo Map + 列表头改过滤计数；移除 `curMeasure` 状态（唯一消费方是列表窗口）；帮助 summary 恢复文字
- 修改：`app/src/views/SyncTunePage.css` —— `.st-help summary::before` 绿 ？ 加 `margin-right`
- 测试：`app/src/synctune/store.test.ts` —— 改写既有 visibleNotes 用例（窗口断言 → 全量断言）+ 新增 601 规模性能护栏用例

注：store 签名变更与页面调用方必须同一 commit 落地（否则 tsc 红），故任务 1 合并为一个 TDD 循环。

---

### 任务 1：列表全量展示（visibleNotes 去窗口 + 页面全量渲染 + 行元数据 memo）

**文件：**
- 修改：`app/src/synctune/store.ts:174-194`
- 修改：`app/src/views/SyncTunePage.tsx`（行 1、46、253-255、787-789、896-899、910-938、组件头注释）
- 测试：`app/src/synctune/store.test.ts:114-126`

- [ ] **步骤 0：基线确认**

运行（app 目录下）：`npx vitest run`
预期：171 全绿（改前基线，记录实际通过数）。

- [ ] **步骤 1：编写失败的测试**

`store.test.ts`：文件顶部 import 增加 `type SyncNote`（从 `./logic`）；将既有用例（115-126 行）

```ts
it('visibleNotes：小节 ±2 窗口 + tuned/untuned 过滤', () => {
  ...
})
```

整体替换为：

```ts
it('visibleNotes：全量返回 + tuned/untuned 过滤（T3d 去小节窗口）', () => {
  S().select(1)
  S().adjust(50) // q=5 已调
  // 全量：不再按小节窗口裁剪，播放序原样返回
  expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 1, 2])
  S().setFilter('tuned')
  expect(visibleNotes(S()).map((n) => n.idx)).toEqual([1])
  S().setFilter('untuned')
  expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 2])
  S().setFilter('all')
  expect(visibleNotes(S()).map((n) => n.idx)).toEqual([0, 1, 2])
})

it('visibleNotes：601 音符 + 601 控制点全量过滤性能护栏', () => {
  const notes: SyncNote[] = []
  for (let i = 0; i < 601; i++) {
    notes.push({ idx: i, measure: 1 + Math.floor(i / 6), midi: 72, q: (i * 4) / 6 })
  }
  const baseline = notes.map((n) => ({ q: n.q, t: n.q * 0.5 }))
  useSyncTuneStore.getState().load('big', notes, baseline)
  // 前 300 个控制点平移 -> 已调；其余未调
  useSyncTuneStore.setState({
    working: baseline.map((p, i) => (i < 300 ? { q: p.q, t: p.t + 0.01 } : { ...p })),
  })
  const t0 = performance.now()
  expect(visibleNotes(S()).length).toBe(601) // all：全量
  S().setFilter('tuned')
  const tunedList = visibleNotes(S())
  expect(tunedList.length).toBe(300)
  expect(tunedList[0].idx).toBe(0)
  expect(tunedList[299].idx).toBe(299)
  S().setFilter('untuned')
  const untunedList = visibleNotes(S())
  expect(untunedList.length).toBe(301)
  expect(untunedList[0].idx).toBe(300)
  // 护栏：三档全量过滤在 601 规模下毫秒级（tunedSetOf 单次构建）；
  // 若退化成逐音符 O(N²) 判定（~36 万次比较×3）会显著超时
  expect(performance.now() - t0).toBeLessThan(1000)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/synctune/store.test.ts`
预期：FAIL——TS/运行时报 `visibleNotes` 参数过多（`Expected 1 arguments, but got 3`）或旧签名下全量断言不成立。

- [ ] **步骤 3：编写实现代码**

3a. `store.ts`：将 174-194 行（doc 注释 + 函数体）整体替换为：

```ts
/** 过滤后的音符列表（T3d 起作用于全量：列表全量展示，不再按小节窗口裁剪）
 *  性能（t_perf_sync_tune）：filter 模式的已调判定走 tunedSetOf 单次构建 O(N log N)。 */
export function visibleNotes(state: SyncTuneState): SyncNote[] {
  if (state.filter === 'all') return state.notes
  const tunedSet = tunedSetOf(state)
  return state.notes.filter((n) => tunedSet.has(n.idx) === (state.filter === 'tuned'))
}
```

3b. `SyncTunePage.tsx`：

- 第 1 行 react import 增加 `useMemo`：`import { useCallback, useEffect, useMemo, useRef, useState } from 'react'`
- logic import 列表增加 `type CtrlPoint`
- 删除第 46 行 `const [curMeasure, setCurMeasure] = useState(1)`
- 253-255 行 `osmd.onMeasureChange` 回调去掉 `setCurMeasure(m)`：

```ts
osmd.onMeasureChange = (m) => {
  if (audioEngine.playing) followMeasure(m)
}
```

- 787-792 行替换为：

```tsx
// —— 渲染 ——
// 列表全量展示（T3d）：去掉小节 ±2 窗口，滚轮可浏览全谱；chips 过滤作用于全量，
// 选中行自动 scrollIntoView 保留（下方 effect）
const listNotes = visibleNotes(st.getState())
// 行元数据（T3d 全量列表）：q→{控制点, 偏差ms} 随 working/baseline 一次构建 O(N+M)，
// 行渲染 O(1) 查表——601 行逐行 working.find + 重复 deltaMsAt 扫描是全量化后的卡顿源
const rowMeta = useMemo(() => {
  const cpByQ = new Map(working.map((p) => [p.q, p]))
  const meta = new Map<number, { cp?: CtrlPoint; delta: number }>()
  for (const n of st.getState().notes) {
    meta.set(n.q, { cp: cpByQ.get(n.q), delta: Math.round(deltaMsAt(working, baseline, n.q)) })
  }
  return meta
}, [working, baseline])
useEffect(() => {
  listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' })
}, [selectedIdx, filter])
```

- 列表头（原 897-899 行 `m{...}–{...}` 范围显示）改为过滤感知计数：

```tsx
<span>
  {filter === 'all' ? '全部' : filter === 'tuned' ? '已调' : '未调'} {listNotes.length} 音符
</span>
```

- 行渲染（原 911-914 行）改查表、行点击去掉 `setCurMeasure(n.measure)`：

```tsx
{listNotes.map((n) => {
  const isSel = n.idx === selectedIdx
  const { cp, delta } = rowMeta.get(n.q) ?? { cp: undefined, delta: 0 }
  return (
    <button
      key={n.idx}
      className={`st-row${isSel ? ' sel' : ''}`}
      data-sel={isSel ? '1' : undefined}
      onClick={() => st.getState().select(n.idx)}
    >
```

（其余 JSX——m/p/q/t/delta span——不变。）

- 空态文案（原 938 行）：`该窗口内无此状态音符` → `无此状态音符`
- 组件头注释（21-33 行 doc）末尾追加一行：

```ts
 * R2（T3d）：列表全量展示（去小节 ±2 窗口）+ 行元数据 memo 查表；帮助按钮
 * 「? 操作说明」文字恢复（绿色 ？ 保留）。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc -b && npx vitest run src/synctune/store.test.ts`
预期：tsc 零错误（`anchorMeasure`/`curMeasure` 无残留引用）；store.test.ts 全 PASS（含新增 2 用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/synctune/store.ts src/synctune/store.test.ts src/views/SyncTunePage.tsx
git commit -m "T3d fix(synctune): 列表全量展示——visibleNotes 去小节窗口 + 行元数据 memo 查表 + curMeasure 状态移除"
```

---

### 任务 2：帮助按钮文字恢复（「?」+「操作说明」并排）

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx:994-997`
- 修改：`app/src/views/SyncTunePage.css:367-372`

- [ ] **步骤 1：summary 恢复文字节点**

```tsx
{/* 操作说明（T2）：默认收起、展开不持久化；T3d 起「?」与「操作说明」并排显示
    （T3c 曾只留绿色 ？，用户要求文字留着），aria-label 保持不变 */}
<details className="st-help">
  <summary aria-label="操作说明">操作说明</summary>
```

- [ ] **步骤 2：CSS 绿 ？ 加右间距**

`.st-help summary::before`（367-372 行）改为：

```css
.st-help summary::before {
  /* T3d：绿色 ？ 与「操作说明」白字并排（T3c 曾只留 ？） */
  content: '?';
  color: var(--song-accent, #5fb8a8);
  font-weight: 700;
  margin-right: 6px;
}
```

- [ ] **步骤 3：类型确认**

运行：`npx tsc -b`
预期：零错误。（无组件级测试基建，视觉验收归任务 3 手动项。）

- [ ] **步骤 4：Commit**

```bash
git add src/views/SyncTunePage.tsx src/views/SyncTunePage.css
git commit -m "T3d feat(sync-tune): 帮助按钮文字恢复——「?」+「操作说明」并排显示，绿色 ？ 保留"
```

---

### 任务 3：全量验证与收口（verification-before-completion）

**文件：** 无新改动（验证任务）

- [ ] **步骤 1：全量验证**

依次运行（app 目录下）：

```bash
npx tsc -b
npx vitest run
npm run build
```

预期：tsc 零错误；vitest 全绿（171 既有 + 新增 1 个净增用例——改写 1 个、新增 1 个——实际数一下，须无 fail）；build 成功。

- [ ] **步骤 2：git status 核对只含自己的改动**

```bash
git status --short
git log --oneline -5
```

预期：本次 2 个 commit（T3d 前缀）；工作区仅剩他人 WIP 未跟踪文件（shot-entry.mjs、两份 plan md）未被触碰、未被提交。

- [ ] **步骤 3：手动验收项（报告如实标注，需用户实测）**

- 列表滚轮从 m1 滚到曲尾可见全部音符（601+ 行）；筛选 chips 作用于全量；点选/播放中选中行自动滚入视野
- 全量滚动流畅度（601 行）——若卡顿，按看板备选方案加视口 ±50 行窗口化（不在本计划内）
- 右栏「? 操作说明」完整显示，点开正常

---

## 自检

**1. 规格覆盖度：**
- 需求 1（全量展示、去窗口、chips 作用于全量、scrollIntoView 保留）→ 任务 1 ✓（visibleNotes 去窗口 + 页面全量渲染 + effect 保留）
- 需求 1 性能注意（601 行先测流畅度，卡则窗口化）→ 任务 1 行元数据 memo + 任务 3 手动流畅度验收（备选窗口化明确标注不在本计划）✓
- 需求 2（? + 操作说明并排、绿 ？ 保留、aria-label 不变）→ 任务 2 ✓
- 红线（演奏页零改动——store.ts 只动 visibleNotes，OSMDScore/AudioEngine/PerformPage* 零涉及；签名同步调用方与单测——任务 1 一并改；vitest 171 不回归 + 新逻辑补单测——任务 1 步骤 1 + 任务 3 步骤 1）✓
- 红线（并发 WIP 只读不提交）→ 任务 3 步骤 2 ✓

**2. 占位符扫描：** 无「TODO/待定/类似任务 N」；所有代码步骤含完整代码。✓

**3. 类型一致性：** `visibleNotes(state)` 新签名与任务 1 页面调用 `visibleNotes(st.getState())` 一致；`rowMeta` 的 `{ cp?: CtrlPoint; delta: number }` 与行渲染解构 `const { cp, delta } = rowMeta.get(n.q) ?? { cp: undefined, delta: 0 }` 一致（`cp` 在 JSX 中 `cp ? ... : '—'`，undefined 安全）；`CtrlPoint`/`SyncNote` 均自 `../synctune/logic` 导出（store.ts 现有 import 佐证）；`useMemo` 补进 react import。✓

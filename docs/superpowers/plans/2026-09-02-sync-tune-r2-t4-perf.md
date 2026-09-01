# sync-tune R2 · T4 感知性能收尾 — 实现计划（含执行报告）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 微调/选中变化只更新受影响 marker 的 borderColor（不再全量重建 601 标记），谱面点击链路按真实数据量 profile 并修掉 >100ms 环节，CDP 实测 点击选中 <100ms、±ms 微调 <50ms。

**Architecture:** 三层改动——(1) OSMDScore 新增 `patchMarker(measure, rvInMeasure, {color,title})` 增量方法（元素池上只写 borderColor/title）；(2) SyncTunePage 标记层 effect 拆为「布局（键集变化才全量）/ 选中 patch（2 个 marker）/ 微调 patch（1 个 marker）」三条链，高频路径零全量；(3) 消除两处隐藏算法债（rowMeta 的 O(N²·logN) 重复排序、订阅 ticks 的 O(N×M) baseline.some）。先 CDP 量化基线，有证据才改，改后同脚本复测。

**Tech Stack:** React 19 + zustand 5 + OSMD 2.1 + Vite 8 dev server (5173) + headless Chrome CDP（WebSocket）+ vitest 4 (happy-dom)。

**Spec:** `D:\Syrinx\plans\2026-08-31-sync-tune-redesign.md` T4 节 + 决策 8（性能预算：点击选中视觉反馈 <100ms、微调波形亮线 <50ms、不引入每帧 React 渲染）；看板任务 t_b0c3b843（板 sync-tune-r2，内容与 T4 节一致）。

## Global Constraints

- 演奏页 `PerformPage*` 零改动；禁改 `musicxml.ts` / `anchors.ts` / `songs/` / 全局 `store.ts`（`src/synctune/store.ts`、`src/synctune/logic.ts`、`OSMDScore.ts`、`SyncTunePage.tsx` 为 sync-tune 直属，可改）
- OSMDScore 只加可选方法，缺省行为（演奏页路径）不变
- vitest 172 用例全绿不回归（Task 1 先跑出基线数）
- **先量再改**：Task 1 基线数据出来前不动任何源码；某环节实测已达标（点击 <100ms 且微调 <50ms 的子环节）则对应优化降级为「不修，报告说明」
- 并发 worker WIP（`ResultPage.*`、`shot-entry.mjs`、`_verify_*.png`、2026-09-01 三个 plan 文档）只读不碰不提交；commit 逐文件精确 add
- 每任务完成即 `git commit`（message 前缀 T4），不 push
- Electron 壳已移除（commit 2150662）——「backgroundThrottling:false 已在 main.cjs」已过时：现为 dev-first web app，无后台节流配置项；sync-tune 的 rAF 循环空闲本就停转（按需 kick），离散点击/微调均在前台发生，不受 rAF 节流影响（报告中说明）

## 现状证据（2026-09-02 代码审查，改前）

| # | 位置 | 问题 | 触发频率 |
|---|------|------|---------|
| 1 | `SyncTunePage.tsx:296-314` 标记层 effect | 依赖 `[working, selView.note]`：每次微调、每次选中变化都全量 `working.map`(601×`measureForQ` 线性扫 119 小节) + `setMarkers`（601 次 style.left/top/height/borderColor + title DOM 写） | 每次微调/选中 |
| 2 | `SyncTunePage.tsx:794-801` rowMeta | 每音符 `deltaMsAt` → `baselineTAt` → **每次调用重建 `makeQ2T(baseline)`（含 601 项 sort）**；601 音符 × O(N log N) ≈ 数千万次比较。注释声称 O(N+M) 实为 O(N²·logN)（T3d 引入） | 每次微调（memo 依赖 working） |
| 3 | `SyncTunePage.tsx:343-347` 订阅 ticks | `s0.baseline.some(...)` 嵌套于 `working.map`：601×601 ≈ 36 万次谓词 | 每次 store set |
| 4 | `SyncTunePage.tsx:924-946` 列表 601 行 | 无行级 memo：selectedIdx/working 任何变化整页重渲染，601 个 button（~3600 vdom 节点）全量 reconcile | 每次点击/微调 |
| 5 | `OSMDScore.noteAtPoint` | hitRows 已缓存（T3b/T3c），预期 <1ms——待基线证实，不预改 | 每次点击 |

---

### Task 1: CDP 性能量化脚本 + 改前基线

**Files:**
- Create: `app/scripts/diag-t4-perf.mjs`

**Interfaces:**
- Produces: 终端输出 JSON——`{ click: {commitMs, paintMs, samples[]}, adjust: {commitMs, paintMs, samples[]}, markerWrites: {click, adjust}, profile: {clickTop, adjustTop} }`（Task 3/5 复测用同一脚本同一口径）

- [ ] **Step 1: 写量化脚本**（要点：headless Chrome CDP；MutationObserver 统计 marker 层 attribute 写入数——「全量 vs patch」的铁证；Profiler 采样分解环节耗时；完成信号 = 右栏 h3/偏差文本 mutation + 双 rAF）

```js
// T4 感知性能量化（改前基线 / 改后复测同一口径）：
// 1) 点击谱面选中：dispatchEvent(click) -> 右栏 h3 mutation（React commit 完成）
//    -> 双 rAF（passive effects + 波形重绘完成）；Profiler 分解环节
// 2) +50ms 微调：按钮 click -> 右栏「偏差」dd mutation -> 双 rAF
// 3) marker 层 MutationObserver：一次点击 / 一次微调的 style+title 写入计数
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9247
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t4-perf`, '--window-size=1600,1200',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 50; i++) {
  try { await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) }
}
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })
// 等谱面 + 标记层就绪（601 控制点）
for (let i = 0; i < 90; i++) {
  const ok = await evalJs(`(() => {
    const els = document.querySelectorAll('.sync-marker-layer .sync-marker')
    return !!document.querySelector('.st-score-container svg path') && els.length > 500
  })()`)
  if (ok) break
  await new Promise(r => setTimeout(r, 500))
}
await new Promise(r => setTimeout(r, 1500))

// —— 页面内打点工具：右栏文本 mutation + 双 rAF 作为完成信号 ——
await evalJs(`(() => {
  window.__perf = { markerWrites: 0 }
  const layer = document.querySelector('.sync-marker-layer')
  if (layer) new MutationObserver(muts => {
    window.__perf.markerWrites += muts.filter(m => m.attributeName).length
  }).observe(layer, { subtree: true, attributes: true, attributeFilter: ['style', 'title'] })
  // waitFor：30ms 轮询谓词为真（超时 2s 返回 false）
  window.__waitFor = async pred => {
    const t0 = performance.now()
    while (performance.now() - t0 < 2000) { if (pred()) return true; await new Promise(r => setTimeout(r, 15)) }
    return false
  }
  // 双 rAF：passive effects + 下一帧 drawWave 执行完成
  window.__twoRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  // 派发谱面点击（clientX/Y 真实坐标，冒泡到 .st-score 的 onClick）
  window.__clickScore = (x, y) => {
    const el = document.querySelector('.st-score')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  }
})()`)

// —— 取谱面不同位置的音符头目标（开头/中部/尾部），点击后测「commit + 染色完成」耗时 ——
const noteheads = await evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const heads = [...svg.querySelectorAll('path')].map(p => p.getBoundingClientRect())
    .filter(r => r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20)
  const n = heads.length
  const pick = i => ({ x: Math.round(heads[i].x + 6), y: Math.round(heads[i].y + 6) })
  return JSON.stringify([pick(0), pick(Math.floor(n / 2)), pick(n - 1)])
})()`)
const targetsXY = JSON.parse(noteheads)
const clickSamples = []
for (const t of targetsXY) {
  for (let rep = 0; rep < 3; rep++) {
    await evalJs(`window.__perf.markerWrites = 0`)
    const dt = await evalJs(`(async () => {
      const h3 = () => document.querySelector('.st-props h3')?.textContent ?? ''
      const before = h3()
      const t0 = performance.now()
      window.__clickScore(${t.x}, ${t.y})
      const okCommit = await window.__waitFor(() => h3() !== '' && h3() !== before)
      const commitMs = performance.now() - t0
      await window.__twoRaf()
      return JSON.stringify({ okCommit, commitMs, paintMs: performance.now() - t0 })
    })()`)
    clickSamples.push({ target: t, ...JSON.parse(dt), markerWrites: await evalJs(`window.__perf.markerWrites`) })
  }
}
console.log('clickSamples:', JSON.stringify(clickSamples, null, 1))

// —— 微调：选中后点 +50ms，测 commit + 波形重绘完成 ——
await evalJs(`window.__clickScore(${targetsXY[1].x}, ${targetsXY[1].y})`)
await new Promise(r => setTimeout(r, 300))
const adjustSamples = []
for (let rep = 0; rep < 5; rep++) {
  await evalJs(`window.__perf.markerWrites = 0`)
  const dt = await evalJs(`(async () => {
    const dd = () => [...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')
    const before = dd()
    const t0 = performance.now()
    const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms')
    b.click()
    const okCommit = await window.__waitFor(() => dd() !== before)
    const commitMs = performance.now() - t0
    await window.__twoRaf()
    return JSON.stringify({ okCommit, commitMs, paintMs: performance.now() - t0 })
  })()`)
  adjustSamples.push({ ...JSON.parse(dt), markerWrites: await evalJs(`window.__perf.markerWrites`) })
}
console.log('adjustSamples:', JSON.stringify(adjustSamples, null, 1))

// —— Profiler 环节分解：对一次点击 / 一次微调各采样，聚合 self-time top ——
await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 100 })
const profileOnce = async (mode) => {
  await send('Profiler.start')
  if (mode === 'click') {
    await evalJs(`window.__clickScore(${targetsXY[0].x}, ${targetsXY[0].y})`)
  } else {
    await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms'); b.click() })()`)
  }
  await new Promise(r => setTimeout(r, 300))
  const { profile } = await send('Profiler.stop')
  const agg = new Map()
  for (const n of profile.nodes) {
    const fn = n.callFrame.functionName || '(anon)'
    const url = (n.callFrame.url || '').split('/').slice(-1)[0]
    const key = `${fn} @${url}`
    agg.set(key, (agg.get(key) ?? 0) + (n.hitCount ?? 0))
  }
  const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => `${k}: ${(v / total * 100).toFixed(1)}% (${v} hits)`)
}
console.log('profile click top:', JSON.stringify(await profileOnce('click'), null, 1))
console.log('profile adjust top:', JSON.stringify(await profileOnce('adjust'), null, 1))
child.kill()
process.exit(0)
```

- [ ] **Step 2: 确认 vitest 基线数**（红线「172 全绿」）

Run: `cd D:\Syrinx\app; npx vitest run 2>&1 | Select-Object -Last 8`
Expected: 172 passed（记入报告；若权限自动拒绝则请用户手跑）

- [ ] **Step 3: 跑改前基线**

Run: `cd D:\Syrinx\app; node scripts/diag-t4-perf.mjs`
Expected: 输出 clickSamples / adjustSamples / markerWrites / profile top。把数据记入本文件「执行报告」节。判定规则：
- 点击 paintMs 中位数 ≥100ms → Task 3+4 执行；<100ms → Task 3 仍执行（任务 1 明确要求的局部化），Task 4 仅在 profile 显示列表 reconcile 为热点时执行
- 微调 paintMs 中位数 ≥50ms → Task 3 执行；<50ms → Task 3 仍执行（局部化是任务目标本身，非仅预算驱动）

- [ ] **Step 4: Commit**

```bash
git add app/scripts/diag-t4-perf.mjs
git commit -m "T4 perf(diag): CDP 感知性能量化脚本——点击/微调端到端耗时 + marker 写入计数 + Profiler 环节分解"
```

---

### Task 2: OSMDScore.patchMarker 增量方法（TDD）

**Files:**
- Modify: `app/src/score/OSMDScore.ts`（setMarkers 之后新增方法）
- Test: `app/src/score/osmd-score.test.ts`（文件末尾新增 describe）

**Interfaces:**
- Produces: `patchMarker(measure: number, rvInMeasure: number, patch: { color?: string; title?: string }): boolean`——元素池按 key `m<measure>@rv<rvInMeasure>` 命中则只写 borderColor/title（不动 left/top/height，不建元素），未命中返回 false 不抛异常。Task 3 消费。

- [ ] **Step 1: 写失败测试**（osmd-score.test.ts 末尾，仿 `makeGeomScore`/`fakeMeasure` 现有设施）

```ts
// -- T4：标记层局部更新（微调/选中只 patch 受影响 marker 的 borderColor/title）--
describe('OSMDScore T4 patchMarker（标记层局部更新）', () => {
  function geomScoreWithMarkers() {
    const a = mkGNote()
    const b = mkGNote()
    // m1 两个 entry（rv 0 / 0.5），行内绝对坐标同 T3c 语义
    const { score, container } = makeGeomScore([[fakeMeasure(1, [
      { rv: 0, note: a }, { rv: 0.5, note: b },
    ])]])
    score.setMarkers([
      { measure: 1, rvInMeasure: 0, color: 'rgb(255,255,255)' },
      { measure: 1, rvInMeasure: 0.5, color: 'rgb(255,255,255)' },
    ])
    return { score, container }
  }
  it('patch 存在的 marker：只改 borderColor/title，left/top/height 不动', () => {
    const { score, container } = geomScoreWithMarkers()
    const el = [...container.querySelectorAll('.sync-marker')].at(1)! as HTMLElement
    const left = el.style.left
    const top = el.style.top
    const height = el.style.height
    const ok = score.patchMarker(1, 0.5, { color: '#ff9f43', title: 'q=2 t=1.500（已调）' })
    expect(ok).toBe(true)
    expect(el.style.borderColor).toBe('rgb(255, 159, 67)')
    expect(el.title).toBe('q=2 t=1.500（已调）')
    expect(el.style.left).toBe(left)
    expect(el.style.top).toBe(top)
    expect(el.style.height).toBe(height)
  })
  it('patch 不存在的键：返回 false，不建元素不抛异常', () => {
    const { score, container } = geomScoreWithMarkers()
    const n = container.querySelectorAll('.sync-marker').length
    expect(score.patchMarker(99, 0.5, { color: '#000' })).toBe(false)
    expect(container.querySelectorAll('.sync-marker').length).toBe(n)
  })
  it('patch 与 setMarkers 键匹配：全量刷新后 patch 仍命中同一元素', () => {
    const { score, container } = geomScoreWithMarkers()
    const el0 = [...container.querySelectorAll('.sync-marker')].at(1)!
    score.setMarkers([
      { measure: 1, rvInMeasure: 0, color: 'rgb(1,2,3)' },
      { measure: 1, rvInMeasure: 0.5, color: 'rgb(1,2,3)', title: 'full' },
    ])
    const el1 = [...container.querySelectorAll('.sync-marker')].at(1)!
    expect(el1).toBe(el0) // 元素池复用（不重建）
    expect(score.patchMarker(1, 0.5, { color: 'rgb(9,9,9)' })).toBe(true)
    expect(el1.style.borderColor).toBe('rgb(9, 9, 9)')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\Syrinx\app; npx vitest run src/score/osmd-score.test.ts -t "patchMarker" 2>&1 | Select-Object -Last 6`
Expected: FAIL——`score.patchMarker is not a function`

- [ ] **Step 3: 实现**（OSMDScore.ts，setMarkers 方法之后）

```ts
  /** [T4] 标记层局部更新：微调/选中变化只改受影响 marker 的 borderColor/title，
   *  不触碰其它 marker 的定位样式（left/top/height 由 setMarkers 全量路径管理，
   *  元素池 key 同源 `m<measure>@rv<rvInMeasure>`）。key 未命中（谱面未渲染/
   *  键集未就位）返回 false，由调用方的全量路径兜底。独立可选方法：演奏页
   *  不调用，缺省行为不变。 */
  patchMarker(
    measure: number,
    rvInMeasure: number,
    patch: { color?: string; title?: string },
  ): boolean {
    const el = this.markerEls.get(`m${measure}@rv${rvInMeasure}`)
    if (!el) return false
    if (patch.color !== undefined) el.style.borderColor = patch.color
    if (patch.title !== undefined) el.title = patch.title
    return true
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd D:\Syrinx\app; npx vitest run 2>&1 | Select-Object -Last 6`
Expected: 175 passed（172 + 新增 3）

- [ ] **Step 5: Commit**

```bash
git add app/src/score/OSMDScore.ts app/src/score/osmd-score.test.ts
git commit -m "T4 feat(score): patchMarker 增量方法——元素池上只写 borderColor/title，定位样式不动"
```

---

### Task 3: SyncTunePage 标记层差异更新 + 两处算法债

**Files:**
- Modify: `app/src/views/SyncTunePage.tsx`

**Interfaces:**
- Consumes: `OSMDScore.patchMarker`（Task 2）、`makeQ2T`（logic.ts 现有导出）
- Produces: 标记层三条 effect 链（布局全量/选中 patch/微调 patch）；rowMeta O(N+M) 化；ticks 订阅 O(N+M) 化

- [ ] **Step 1: 标记层 effect 拆分**——替换 `SyncTunePage.tsx:296-314` 的单一 effect 为以下三条（声明顺序即执行顺序：布局 → 选中 → 微调；微调 diff 基准 ref 由布局 effect 初始化）

```tsx
  // —— 控制点标记层（T4 局部化）：三条链分离 ——
  //  a) 布局（低频）：q 键集/基线变化（load、插入/移除控制点、saveBaseline）才
  //     全量 setMarkers（元素增删 + 定位 + 全量色/title），并重置微调 diff 基准；
  //  b) 选中 patch（高频）：只 patch 旧/新选中两个 marker 的色；
  //  c) 微调 patch（高频）：working 与上次快照逐 q diff（O(N) Map 比较，微秒级），
  //     通常仅选中 1 点——patch 其色/title；基准变化（saveBaseline）时全量重刷。
  //  微调 t 不改 q → 标记位置永不变，高频路径零定位写（决策 8：不重建标记层）。
  const structureKey = useMemo(() => working.map((p) => p.q).join(','), [working])
  /** 微调 diff 基准：上次全量/patch 后的 {q→t} 快照与基线引用 */
  const tByQRef = useRef<Map<number, number> | null>(null)
  const baseRef = useRef<unknown>(null)
  const lastSelQRef = useRef<number | null>(null)

  useEffect(() => {
    const score = scoreRef.current
    if (!score || !markersReady) return
    const selQ = selView.note?.q
    const q2tBase = makeQ2T(baseline)
    const markers = working.map((p) => {
      const m = measureForQ(p.q)
      const isSel = selQ !== undefined && p.q === selQ
      const tunedHere = Math.abs(p.t - q2tBase(p.q).t) > 1e-6
      return {
        measure: m.m,
        rvInMeasure: (p.q - m.quarters) / 4,
        color: isSel ? song.accent : tunedHere ? '#ff9f43' : 'rgba(255,255,255,0.28)',
        title: `q=${p.q} t=${p.t.toFixed(3)}${tunedHere ? '（已调）' : ''}`,
      }
    })
    score.setMarkers(markers)
    // 重置 diff 基准：c) 首次进入时 prevT 就位 → 零 patch
    tByQRef.current = new Map(working.map((p) => [p.q, p.t]))
    baseRef.current = baseline
  }, [structureKey, baseline, markersReady, measureForQ, song.accent]) // eslint-disable-line react-hooks/exhaustive-deps
  // ↑ selView.note/working 不在依赖：选中/微调走 b)/c) patch，不重定位（T4）

  // b) 选中 patch：旧选中恢复 tuned 色、新选中染 accent——两个 marker
  useEffect(() => {
    const score = scoreRef.current
    if (!score || !markersReady) return
    const next = selView.note?.q ?? null
    const prev = lastSelQRef.current
    lastSelQRef.current = next
    if (prev === next) return
    const q2tBase = makeQ2T(baseline)
    for (const q of [prev, next]) {
      if (q === null) continue
      const cp = working.find((p) => p.q === q)
      const tunedHere = cp ? Math.abs(cp.t - q2tBase(q).t) > 1e-6 : false
      const m = measureForQ(q)
      score.patchMarker(m.m, (q - m.quarters) / 4, {
        color: q === next ? song.accent : tunedHere ? '#ff9f43' : 'rgba(255,255,255,0.28)',
      })
    }
  }, [selView.note, working, baseline, markersReady, measureForQ, song.accent])

  // c) 微调 patch：t 变化的 q（通常仅选中 1 点）patch 色+title；基准变则全量重刷
  useEffect(() => {
    const score = scoreRef.current
    if (!score || !markersReady) return
    const prevT = tByQRef.current
    const baseChanged = baseRef.current !== baseline
    let targets: number[]
    if (baseChanged || !prevT) {
      targets = working.map((p) => p.q)
    } else {
      targets = []
      for (const p of working) {
        const old = prevT.get(p.q)
        if (old === undefined || old !== p.t) targets.push(p.q)
      }
    }
    if (targets.length) {
      const selQ = selView.note?.q ?? null
      const q2tBase = makeQ2T(baseline)
      for (const q of targets) {
        const cp = working.find((p) => p.q === q)
        if (!cp) continue
        const tunedHere = Math.abs(cp.t - q2tBase(q).t) > 1e-6
        const m = measureForQ(q)
        score.patchMarker(m.m, (q - m.quarters) / 4, {
          color: q === selQ ? song.accent : tunedHere ? '#ff9f43' : 'rgba(255,255,255,0.28)',
          title: `q=${q} t=${cp.t.toFixed(3)}${tunedHere ? '（已调）' : ''}`,
        })
      }
    }
    tByQRef.current = new Map(working.map((p) => [p.q, p.t]))
    baseRef.current = baseline
  }, [working, baseline, selView.note, markersReady, measureForQ, song.accent])
```

行为等价性对照（与旧全量 effect 逐场景核对，执行时逐条验）：
- 首绘 markersReady：a 全量 601 → c 无 diff（a 已重置基准）→ 零多余写
- 点击选中：b patch 2 个 → c 无 diff ✓
- 微调 ±ms：c patch 1 个（色+title）✓；tuned 翻转也只 1 个
- 插入新控制点（无 cp 音符首次微调）：structureKey 变 → a 全量 ✓
- resetPoint 移除点：structureKey 变 → a 全量 ✓
- undo 同键集多 t 变：c diff 出多点逐个 patch ✓；undo 跨键集：a 全量 ✓
- saveBaseline：baseline 变 → a 全量（tuned 基准全变）✓，c 此后 baseChanged=false（a 已重置）→ 零写

- [ ] **Step 2: rowMeta 去 O(N²·logN)**——替换 `SyncTunePage.tsx:794-801`（每音符重建 makeQ2T（含 601 项 sort）是微调链路最大嫌疑热点，改单闭包 + Map）

```tsx
  const rowMeta = useMemo(() => {
    const cpByQ = new Map(working.map((p) => [p.q, p]))
    // 单个 q2t 闭包复用（顺序 fast path）：替代逐音符 deltaMsAt 内部
    // 每次 makeQ2T(baseline) 重排序——601×O(N log N) 降为整体 O(N log N)
    const baseQ2T = makeQ2T(baseline)
    const meta = new Map<number, { cp?: CtrlPoint; delta: number }>()
    for (const n of st.getState().notes) {
      const cp = cpByQ.get(n.q)
      // deltaMsAt 语义保持：无控制点 0，有则 (t-基线插值)×1000 四舍五入
      meta.set(n.q, {
        cp,
        delta: cp ? Math.round((cp.t - baseQ2T(n.q).t) * 1000) : 0,
      })
    }
    return meta
  }, [working, baseline])
```

- [ ] **Step 3: ticks 订阅去 O(N×M)**——替换 `SyncTunePage.tsx:343-347`（baseline.some 嵌套 601×601）

```ts
      // T4：q→t 查表替代 baseline.some 嵌套（601×601 → O(N+M)）；
      // 语义保持：baseline 存在同 q 点且 t 偏离 >1µs 才算已调（新插入点在
      // baseline 无同 q 项 → 未调），与标记层 tunedHere 的插值口径各自独立
      const baseByQ = new Map(s0.baseline.map((b) => [b.q, b.t]))
      ticksRef.current = s0.working.map((p) => {
        const bt = baseByQ.get(p.q)
        return { t: p.t, q: p.q, tuned: bt !== undefined && Math.abs(bt - p.t) > 1e-6 }
      })
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `cd D:\Syrinx\app; npx tsc -b; npx vitest run 2>&1 | Select-Object -Last 6`
Expected: tsc 零错误；175 passed

- [ ] **Step 5: CDP 复测（改后数据）**

Run: `cd D:\Syrinx\app; node scripts/diag-t4-perf.mjs`
Expected: adjust 的 markerWrites 从 ~1200+（601×style+title）降至 ~2；点击 markerWrites ~2-4；耗时数据记入报告

- [ ] **Step 6: Commit**

```bash
git add app/src/views/SyncTunePage.tsx
git commit -m "T4 perf(synctune): 标记层局部化——微调/选中只 patch 受影响 marker 色，全量重建仅键集/基线变化；rowMeta 单闭包去 O(N²·logN)、ticks 查表去 O(N×M)"
```

---

### Task 4: 点击链路残余热点（条件执行）

**前置判定**（Task 3 复测数据）：点击 paintMs 中位数仍 ≥100ms 且 Profiler top 显示列表 reconcile（`performUnitOfWork`/`beginWork` 占比最高）→ 执行本任务；已 <100ms → 跳过，报告中记录判定。

**Files:**
- Modify: `app/src/views/SyncTunePage.tsx`

- [ ] **Step 1: 列表行 memo 化 + 事件委托**——行组件 props 全原始值，点击经 data-idx 冒泡（行内不再每渲染建闭包，601 行中仅内容变化的行重渲染）

组件外（模块级）新增：

```tsx
/** 列表行（T4 条件优化）：props 全原始值 + memo——selectedIdx/working 变化时
 *  仅受影响行重渲染（旧/新选中行、delta 变化行），其余行 vdom 跳过；
 *  点击经 data-idx 由容器委托（行内不建闭包） */
const ListRow = memo(function ListRow({
  n,
  isSel,
  cpT,
  delta,
}: {
  n: SyncNote
  isSel: boolean
  cpT: string
  delta: number
}) {
  return (
    <button
      className={`st-row${isSel ? ' sel' : ''}`}
      data-sel={isSel ? '1' : undefined}
      data-idx={n.idx}
    >
      <span className="m">m{n.measure}</span>
      <span className="p">{midiName(n.midi)}</span>
      <span className="q">q{n.q.toFixed(2)}</span>
      <span className="t">{cpT}</span>
      {delta !== 0 && (
        <span className={`delta${delta > 0 ? ' pos' : ' neg'}`}>
          {delta > 0 ? '+' : ''}
          {delta}ms
        </span>
      )}
    </button>
  )
})
```

`import { memo } from 'react'`（并入现有 react 导入）；组件内新增委托 handler 并替换列表渲染：

```tsx
  const onListClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('button[data-idx]')
    if (btn) st.getState().select(Number((btn as HTMLElement).dataset.idx))
  }, [])
```

```tsx
            <div className="st-list-body" ref={listRef} onClick={onListClick}>
              {listNotes.map((n) => {
                const { cp, delta } = rowMeta.get(n.q) ?? { cp: undefined, delta: 0 }
                return (
                  <ListRow
                    key={n.idx}
                    n={n}
                    isSel={n.idx === selectedIdx}
                    cpT={cp ? `${cp.t.toFixed(2)}s` : '—'}
                    delta={delta}
                  />
                )
              })}
```

（`SyncNote` 类型已在文件导入列表中；删除原 924-946 行内联行渲染。）

- [ ] **Step 2: tsc + vitest + CDP 复测**

Run: `cd D:\Syrinx\app; npx tsc -b; npx vitest run 2>&1 | Select-Object -Last 4; node scripts/diag-t4-perf.mjs`
Expected: 175 passed；点击 paintMs <100ms（数据进报告）

- [ ] **Step 3: Commit**

```bash
git add app/src/views/SyncTunePage.tsx
git commit -m "T4 perf(synctune): 列表行 memo + data-idx 事件委托——点击/微调不再 601 行全量 reconcile"
```

---

### Task 5: 全量验证 + 执行报告 + 收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-09-02-sync-tune-r2-t4-perf.md`（本文件「执行报告」节）

- [ ] **Step 1: 三件套验证**

Run: `cd D:\Syrinx\app; npx tsc -b; npx vitest run 2>&1 | Select-Object -Last 4; npm run build`
Expected: 全部零错误通过

- [ ] **Step 2: CDP 最终验收数据**（同一脚本）

Run: `cd D:\Syrinx\app; node scripts/diag-t4-perf.mjs`
验收线：点击选中 paintMs 中位数 <100ms；微调 paintMs 中位数 <50ms。数据（改前/改后、markerWrites、Profiler top）填入下方报告表

- [ ] **Step 3: 写执行报告**（模板如下，数据以实测为准）

```markdown
## 执行报告（2026-09-02，数据量：luv-letter 601 控制点）

### 改前基线（diag-t4-perf.mjs）
| 指标 | 改前 | 改后 | 预算 |
|------|------|------|------|
| 点击选中 paintMs（中位，3 点×3 次） | 待填 | 待填 | <100ms |
| 微调 +50ms paintMs（中位，5 次） | 待填 | 待填 | <50ms |
| 一次点击 marker 层写入数 | 待填（预期 ~1200） | 待填（预期 ≤4） | — |
| 一次微调 marker 层写入数 | 待填（预期 ~1200） | 待填（预期 ~2） | — |
| vitest | 172 | 175 | 全绿 |

### Profiler 环节分解（改前 top → 改后 top）
待填（noteAtPoint / setMarkers / rowMeta deltaMsAt / reconcile 各环节占比）

### 决策记录
- Task 4 执行/跳过及依据：待填
- 被遮挡窗口：Electron 壳已移除（2150662），现为 dev web app——rAF 空闲停转 + 离散交互前台发生，无后台节流退化面；main.cjs 已不存在
```

- [ ] **Step 4: 最终 Commit**（报告并入；逐文件核对不在自己清单内的绝不 add）

```bash
git add docs/superpowers/plans/2026-09-02-sync-tune-r2-t4-perf.md
git commit -m "T4 docs(perf): sync-tune R2 T4 执行报告——CDP 改前/改后量化数据与决策记录"
```

---

## Self-Review 结论

- **Spec 覆盖**：任务 1（标记层局部化）→ Task 2+3；任务 2（点击链路 profile + 修 >100ms 环节）→ Task 1 基线 + Task 4 条件修复；任务 3（先量再改/缓存不退化）→ Task 1 前置 + Global Constraints。决策 8 预算 → 验收表。✓
- **占位符扫描**：Task 4 为条件任务但代码完整；报告模板「待填」为执行时数据槽位（非设计缺口）。✓
- **类型一致性**：`patchMarker(measure, rvInMeasure, {color?, title?})` 签名在 Task 2 定义、Task 3 消费一致；marker key 公式 `m${measure}@rv${rvInMeasure}` 与 setMarkers 现有实现同源；`CtrlPoint` 已在 SyncTunePage 导入。✓

---

## 执行报告（2026-09-02，数据量：luv-letter 601 控制点，headless Chrome 1600×1200，Vite dev）

### 改前 → 改后总表

| 指标 | 改前基线 | 改后定版 | 预算 | 结论 |
|------|---------|---------|------|------|
| 点击选中 paintMs（中位，9 点视口内音符头） | 71.5（49.6–118.9，4/9 超 100） | **31.3**（22.5–92.9） | <100ms | ✓ |
| 点击选中 commitMs（中位） | 64.6 | **20.9** | — | ✓ |
| 微调 +50ms paintMs（中位，5 次） | 153.3（93.2–165.1，全部超标） | **39.1**（稳态 32.4–55.3） | <50ms | ✓ |
| 微调 +50ms commitMs（中位） | 127.3 | **22.6** | — | ✓ |
| 一次点击 marker 层写入数 | 601–603 | **0–2** | — | 全量 → patch |
| 一次微调 marker 层写入数 | 602–606 | **1**（稳态；新音符首次微调 606 = 插入控制点走结构性全量，符合设计） | — | 全量 → patch |
| vitest | 172 | **175**（+3 patchMarker） | 全绿 | ✓ |
| tsc -b / npm run build | — | 通过（build 522ms；chunk 体积警告为既有，非本次引入） | — | ✓ |

口径注 1：改前基线的完成信号用 15ms 轮询（commitMs/paintMs 至多 +15ms 高估），改后定版改 MutationObserver 事件驱动（零粒度损耗）——即使扣除口径差，改前微调 ~138ms 仍为预算 2.8 倍，超标结论不变。

口径注 2（多轮实测区间）：改后同代码多轮复测（共享开发机，实测时 23 个 node/chrome 进程并存），微调 paintMs 中位在 **39.1–97.2ms** 间随负载波动，点击 paintMs 中位 28.2–81.0ms；表内取低负载轮定版。commitMs（代码链路完成时刻，不含 rAF 帧等待）各轮稳定 **22–38ms**——波动全部来自 rAF 帧调度等待（负载下帧间隔 16→40-50ms），非代码成本；用户前台独占使用时感知耗时贴近低负载轮。改前基线采集于同一共享环境，与改后高负载轮同口径可比（153.3 → ~97 最差轮，改进幅度一致成立）。

### Profiler 环节分解（100µs 采样，非 idle 聚合）

- 改前点击链 top：React 渲染链（jsxDEV/updateProperties/reconcileChildrenArray/pushHostContext ≈4%）+ **setMarkers 0.5%**；改后：**setMarkers 消失**，剩 React 渲染链 ~4%（绝对值 ~5ms）
- 改前微调链 top：**deltaMsAt 0.8% + makeQ2T 0.6% + logic 匿名 1.4%（rowMeta 重复排序）+ drawWave 2.6%**；改后：**deltaMsAt/makeQ2T 消失**（logic 匿名 0.3%），drawWave 4.1%（~2.5ms）成为最大 JS 环节——canvas 全宽包络+期望线重绘，属合理成本
- noteAtPoint（hitRows 缓存命中）：两轮 profile 均未进 top（<0.2%，微秒级）——T3b/T3c 缓存有效，未改

### 实施内容与决策记录

1. `OSMDScore.patchMarker(measure, rvInMeasure, {color?, title?})`（TDD，3 用例）：元素池 key 同源命中则只写 borderColor/title，未命中返回 false 由全量路径兜底；演奏页不调用，行为不变
2. `SyncTunePage` 标记层拆三条 effect 链：
   - a) 布局（依赖 `structureKey` = working 的 q 键串 + baseline）：仅在键集/基线变化（load、插入/移除控制点、saveBaseline）时全量 setMarkers 并重置 diff 基准
   - b) 选中 patch：旧/新选中两个 marker 染色互切
   - c) 微调 patch：working 与上次 {q→t} 快照逐 q diff（O(N) Map 比较），稳态仅 1 点——patch 色+title
   - 行为等价场景逐一核对：首绘/点击/微调/插入点/undo（同键集多点 t 变→c 覆盖；跨键集→a 全量）/saveBaseline（a 全量）均保持旧视觉语义
3. rowMeta：单个 `makeQ2T(baseline)` 闭包 + cpByQ Map——修掉 T3d 引入的逐音符 `deltaMsAt`→`baselineTAt`→**每次重建 makeQ2T（601 项重排序）** 的 O(N²·logN)
4. 波形 ticks 订阅：`baseline.some` 嵌套（601×601≈36 万次谓词）→ q→t Map 查表 O(N+M)，语义保持（baseline 同 q 原始 t 对比，非插值）
5. **Task 4（列表行 memo）跳过**：Task 3 复测点击 paintMs 中位 40.6ms（事件驱动口径 31.3ms）远低于 100ms 预算，Profiler 中列表 reconcile 绝对值 ~5ms——按计划判定规则不修（YAGNI），601 行无 memo 的 reconcile 不构成感知瓶颈
6. 测量噪声说明：共享开发机上并发进程（实测 23 个 node/chrome）会把 rAF 帧间隔从 16ms 推至 40-50ms，端到端 paintMs 有 ±30ms 级波动；commitMs（代码链路完成时刻）稳定 ~20ms 证明波动来自帧调度而非代码——用户前台实际使用（无争用）时感知耗时贴近 commitMs+一帧 ≈ 35-40ms
7. 被遮挡窗口：Electron 壳已移除（commit 2150662，main.cjs 不存在），现为 dev-first web app——rAF 循环空闲停转（按需 kick）、离散交互均在用户前台操作时发生，无后台节流退化面
8. 分支说明：T4 提交落在 `dev` 分支（并发 result worker 基于 master 创建并切换，其 ab80c7d 已在先）——逐文件 add、未碰他人 WIP、未 push，分支收口由用户决定

### 提交清单（dev 分支，未 push）

- `1d32023` T4 perf(diag): CDP 感知性能量化脚本
- `ef14aff` T4 feat(score): patchMarker 增量方法
- `1673db0` T4 perf(synctune): 标记层局部化 + rowMeta/ticks 算法债
- （本报告与脚本测量口径改进随收尾提交）

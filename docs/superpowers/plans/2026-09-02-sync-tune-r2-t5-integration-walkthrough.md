# sync-tune R2 · T5 集成走查 + 文档收尾 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** R2 流水线终点——CDP 驱动真机全流程走查（11 步用户链路）、SyncTunePage.tsx 头注释定稿为 T1-T4 全部能力、验证三连（tsc/vitest/build）、T5 commit + R2 整体收官报告。

**架构:** 走查复用项目既有 CDP 模式（headless Chrome + WebSocket 直连 DevTools，参照 `diag-t3c-ui.mjs`/`diag-t4-perf.mjs`）：一个 Node 脚本按用户链路逐步驱动页面并断言 DOM/交互证据，关键节点截图，导出文件落盘校验。不改任何产品逻辑（头注释是唯一源码改动，且工作区已有 +3 行 T1 描述草稿待定稿）。

**技术栈:** Node 20+（全局 WebSocket/fetch）、Chrome headless（CDP 协议）、Vite dev server（5173）、vitest、tsc。

**Spec:** `D:\Syrinx\plans\2026-08-31-sync-tune-redesign.md` T5 节；看板任务 t_b367b1fc（板 sync-tune-r2，API 需认证拉取失败——T4 计划已注明看板内容与规划书对应节一致，且本 prompt 走查清单更新更细，以 prompt 为准）。

**关键 DOM 契约（走查断言依据，均已从源码核实）:**

| 元素 | 选择器/文本 | 出处 |
|---|---|---|
| 音频徽标（suspended） | `button.st-audio`「🔊 点击启用音频」 | SyncTunePage.tsx:937-942 |
| 音频徽标（running） | `span.st-audio.ok`「音频已启用」 | SyncTunePage.tsx:932 |
| ⏯ 按钮 | `.st-tbtn` 文本 `playingUi ? '⏸' : '▶'` | SyncTunePage.tsx:964-965 |
| ⏮/⏭ | `.st-tbtn` title 上一小节/下一小节 | SyncTunePage.tsx:958-967 |
| 进度条 | `.st-progress`（点/拖 seek） | SyncTunePage.tsx:974-980 |
| 时间显示 | `span.st-time`（rAF 直写） | SyncTunePage.tsx:982 |
| dirty 徽标 | `i.st-dirty`「未导出」 | SyncTunePage.tsx:948 |
| 导出按钮 | 文本「导出 beats.json」 | SyncTunePage.tsx:952 |
| 微调按钮 | `.st-btn-grid .st-btn`「+50ms」 | diag-t3c 口径 |
| 撤销/保存 | 右栏 `.st-btn`「撤销上一步」「保存修改」 | SyncTunePage.tsx:1080-1083 |
| 选中橙 | notehead fill=`#ff9f43`(rgb(255,159,67)) | OSMDScore.ts:62 selColor |
| 标记层 | `.sync-marker-layer .sync-marker`（patchMarker 只写 borderColor/title） | OSMDScore.ts:711 |
| 光标 | `.st-score-container img[id^="cursorImg-"]` 宽>5px=跨时值高亮 | diag-t3c 口径 |
| 跟随滚动 | `.st-score` scrollTop 由 scrollToMeasure 写 | OSMDScore.ts:454 |
| 右栏属性 | `.st-props h3`（选中）、`.st-props dd`（微调偏差） | diag-t4 口径 |

**store 语义（S8/S10 断言依据，store.ts:118-130）:** `saveBaseline()` 把 working 应用为新基线、dirty 清零、undoStack **不清**；保存后 `undo()` 把 working 回滚到最近一次微调前快照（相对新基线呈现反向偏差）、dirty 重新置 true。导出 `buildBeatsExport(beats, working, …)` version+1；`log` 非空则同时下载 manual_offsets.json。

---

### 任务 1：CDP 全流程走查脚本 + 真机执行

**文件：**
- 创建：`app/scripts/walk-t5-r2.mjs`（走查脚本，随 T5 提交作为证据工具，与既有 diag-* 脚本同口径）
- 产物：`app/scripts/_t5_walk/*.png`（截图证据，不提交——与 `_intro_frames/`、`_spec_grid_*.png` 等 worker 产物同等对待，保持 untracked）

- [ ] **步骤 1：写走查脚本**

脚本按下述完整内容创建（11 步链路 → 断言清单；断言失败以非零退出码结束，全部结果带 PASS/FAIL 前缀输出供报告引用）：

```js
// T5 全流程走查（R2 收官）：打开→启用音频→播放(光标跨时值高亮)→跟随滚动→
// 暂停→点音符(橙色选中,首/中/尾三处)→+50ms微调(标记亮线即时,局部patch)→
// 保存修改→播放按新节奏→撤销上一步→导出 beats.json+manual_offsets.json。
// 每步断言输出 PASS/FAIL；证据截图存 _t5_walk/；导出文件落盘校验。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9251
const SHOT_DIR = fileURLToPath(new URL('./_t5_walk/', import.meta.url))
const DL_DIR = join(tmpdir(), 'syrinx-t5-walk-dl')
mkdirSync(SHOT_DIR, { recursive: true })
rmSync(DL_DIR, { recursive: true, force: true })
mkdirSync(DL_DIR, { recursive: true })

const results = []
const assert = (step, name, ok, detail = '') => {
  results.push({ step, name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${step}] ${name}${detail ? ` — ${detail}` : ''}`)
}

let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t5-walk`, '--window-size=1600,1200',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 50; i++) {
  try { await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) }
}
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json())
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const shot = async name => {
  const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result
  writeFileSync(join(SHOT_DIR, name + '.png'), Buffer.from(data, 'base64'))
  console.log(`SHOT ${name}.png`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clickXY = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(250)
}

await send('Page.enable')
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR })
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })

// —— S1 打开：谱面 + 标记层就绪 ——
let markers = 0
for (let i = 0; i < 90; i++) {
  markers = await evalJs(`document.querySelectorAll('.sync-marker-layer .sync-marker').length`)
  if (await evalJs(`!!document.querySelector('.st-score-container svg path')`) && markers > 500) break
  await sleep(500)
}
await sleep(1500)
assert('S1', '谱面渲染', await evalJs(`!!document.querySelector('.st-score-container svg path')`))
assert('S1', '标记层就绪(>500)', markers > 500, `markers=${markers}`)
await shot('s1-open')

// —— S2 启用音频：suspended→点徽标按钮；已 running→徽标即 ok ——
const badge0 = await evalJs(`(() => {
  const b = document.querySelector('button.st-audio'), o = document.querySelector('.st-audio.ok')
  return JSON.stringify({ btn: b ? b.textContent.trim() : null, ok: !!o })
})()`)
if (JSON.parse(badge0).btn) {
  await evalJs(`document.querySelector('button.st-audio').click()`)
  await sleep(400)
}
const audioOk = await evalJs(`(() => {
  const o = document.querySelector('.st-audio.ok')
  return !!o || !document.querySelector('button.st-audio')
})()`)
assert('S2', '音频已启用(徽标 ok/无解锁按钮)', audioOk, `initial=${badge0}`)

// —— S3 播放：⏸ 图标 + 光标跨时值高亮 + 时间走动 ——
const playBtn = () => evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); return b ? b.textContent.trim() : null })()`)
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(1500)
assert('S3', '⏯ 切换为 ⏸', (await playBtn()) === '⏸', `btn=${await playBtn()}`)
const t1 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t2 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S3', '时间显示走动', t1 !== t2 && !!t2, `${t1} -> ${t2}`)
const cursorImg = await evalJs(`(() => { const i = document.querySelector('.st-score-container img[id^="cursorImg-"]'); return i ? Math.round(i.getBoundingClientRect().width) : -1 })()`)
assert('S3', '光标跨时值高亮(宽>5px)', cursorImg > 5, `width=${cursorImg}px`)
await shot('s3-playing')

// —— S4 跟随滚动：seek 到 55% 小节，谱面自动聚焦(scrollTop 变化) ——
const scoreScroll = () => evalJs(`Math.round(document.querySelector('.st-score')?.scrollTop ?? -1)`)
const s0 = await scoreScroll()
const prog = await evalJs(`(() => { const r = document.querySelector('.st-progress')?.getBoundingClientRect(); return r ? JSON.stringify({ x: r.x + r.width * 0.55, y: r.y + r.height / 2 }) : null })()`)
const pc = JSON.parse(prog)
await clickXY(Math.round(pc.x), Math.round(pc.y))
await sleep(2500)
const s1 = await scoreScroll()
assert('S4', '播放中谱面自动跟随(scrollTop 变化)', s1 !== s0, `${s0} -> ${s1}`)
const t3 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t4 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S4', 'seek 后播放继续(时间仍走动)', t3 !== t4, `${t3} -> ${t4}`)
await shot('s4-follow')

// —— S5 暂停：图标回 ▶、时间停 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(400)
assert('S5', '⏯ 切回 ▶', (await playBtn()) === '▶', `btn=${await playBtn()}`)
const t5 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1000)
const t6 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S5', '暂停后时间停住', t5 === t6, `${t5} == ${t6}`)

// —— S6 点音符：视口内首/中/尾三处均可点中，notehead 染橙 ——
const orangeCount = () => evalJs(`[...document.querySelectorAll('.st-score-container svg path')].filter(p => (p.getAttribute('fill') || p.style.fill || '').match(/255,\\s*159,\\s*67|#ff9f43/i)).length`)
const pickHeads = () => evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const heads = [...svg.querySelectorAll('path')].map(p => p.getBoundingClientRect())
    .filter(r => r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20 && r.top > 40 && r.bottom < 1150)
  if (!heads.length) return '[]'
  const pick = i => ({ x: Math.round(heads[i].x + 6), y: Math.round(heads[i].y + 6) })
  return JSON.stringify([pick(0), pick(Math.floor(heads.length / 2)), pick(heads.length - 1)])
})()`)
const orange0 = await orangeCount()
for (let k = 0; k < 3; k++) {
  const spots = JSON.parse(await pickHeads())
  if (!spots.length) { assert('S6', `音符#${k} 视口内无音符头`, false); continue }
  const h3Before = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
  await clickXY(spots[Math.min(k, spots.length - 1)].x, spots[Math.min(k, spots.length - 1)].y)
  const h3After = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
  assert('S6', `音符#${k} 点中(右栏联动)`, h3After !== '' && h3After !== h3Before, `${h3After}`)
  assert('S6', `音符#${k} notehead 染橙`, (await orangeCount()) > orange0, `orange=${await orangeCount()}`)
}
await shot('s6-orange-selected')

// —— S7 +50ms 微调：dd 即时变化 + 标记局部 patch(亮线更新) ——
const ddBefore = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
const markerSnap = () => evalJs(`JSON.stringify([...document.querySelectorAll('.sync-marker')].map(m => m.title + '|' + m.style.borderColor))`)
const ms0 = await markerSnap()
const t0 = Date.now()
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms'); b?.click() })()`)
await sleep(300)
const adjMs = Date.now() - t0
const ddAfter = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
assert('S7', '±50ms 右栏即时变化', ddAfter !== ddBefore, `${adjMs}ms`)
const ms1 = await markerSnap()
const [a0, a1] = [JSON.parse(ms0), JSON.parse(ms1)]
const diff = a1.filter((v, i) => v !== a0[i]).length
assert('S7', '波形亮线即时(标记局部 patch)', diff >= 1 && diff < 20, `patched=${diff}/${a1.length}`)
assert('S7', '微调端到端 <1s(远低于 50ms 预算的走查口径)', adjMs < 1000, `${adjMs}ms`)
await shot('s7-adjusted')

// —— S8 保存修改：dirty 清零、保存钮回 disabled、已调归零 ——
assert('S8', '微调后保存按钮可用', await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); return b ? !b.disabled : false })()`))
assert('S8', '微调后出现未导出徽标', await evalJs(`!!document.querySelector('.st-dirty')`))
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); b?.click() })()`)
await sleep(500)
assert('S8', '保存后未导出徽标消失', !(await evalJs(`!!document.querySelector('.st-dirty')`)))
assert('S8', '保存后按钮回 disabled', await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); return b ? b.disabled : true })()`))

// —— S9 播放按新节奏：保存后播放继续可用、时间走动 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(1500)
assert('S9', '保存后再播放(⏸)', (await playBtn()) === '⏸', `btn=${await playBtn()}`)
const t7 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t8 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S9', '新节奏下时间走动', t7 !== t8, `${t7} -> ${t8}`)
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(400)

// —— S10 撤销上一步：working 回滚、dirty 回归、呈现反向偏差 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '撤销上一步'); b?.click() })()`)
await sleep(400)
assert('S10', '撤销后未导出徽标回归', await evalJs(`!!document.querySelector('.st-dirty')`))
const ddUndo = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
assert('S10', '撤销后右栏呈现反向偏差', ddUndo !== ddAfter, `dd=${ddUndo}`)
await shot('s10-undo')

// —— S11 导出 beats.json + manual_offsets.json ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '导出 beats.json'); b?.click() })()`)
let dlFiles = []
for (let i = 0; i < 30; i++) {
  dlFiles = readdirSync(DL_DIR)
  if (dlFiles.includes('beats.json') && dlFiles.includes('manual_offsets.json')) break
  await sleep(400)
}
assert('S11', 'beats.json 下载', dlFiles.includes('beats.json'), dlFiles.join(','))
assert('S11', 'manual_offsets.json 下载', dlFiles.includes('manual_offsets.json'))
try {
  const beats = JSON.parse(readFileSync(join(DL_DIR, 'beats.json'), 'utf8'))
  assert('S11', 'beats.json 结构(version 数字 + beatAnchors>500)',
    typeof beats.version === 'number' && Array.isArray(beats.beatAnchors) && beats.beatAnchors.length > 500,
    `version=${beats.version} anchors=${beats.beatAnchors?.length}`)
  const offs = JSON.parse(readFileSync(join(DL_DIR, 'manual_offsets.json'), 'utf8'))
  assert('S11', 'manual_offsets 含微调记录', Array.isArray(offs) && offs.length >= 1, `entries=${offs.length}`)
} catch (e) {
  assert('S11', '导出文件可解析', false, String(e))
}
await shot('s11-exported')

child.kill()
const fail = results.filter(r => !r.ok)
console.log(`\n===== T5 走查汇总: ${results.length - fail.length}/${results.length} PASS =====`)
for (const f of fail) console.log(`FAILED: [${f.step}] ${f.name}`)
process.exit(fail.length ? 1 : 0)
```

- [ ] **步骤 2：确认 dev server 活着**

运行：`Invoke-WebRequest http://localhost:5173/sync-tune/luv-letter -UseBasicParsing -TimeoutSec 5 | Select-Object StatusCode`
预期：200（5173 已监听；若 dev server 不在，先 `npm run dev` 后台起）。

- [ ] **步骤 3：运行走查**

运行：`node app/scripts/walk-t5-r2.mjs`（工作目录 D:\Syrinx）
预期：末行 `T5 走查汇总: N/N PASS`，退出码 0；截图落 `app/scripts/_t5_walk/`。

- [ ] **步骤 4：失败项处置**

任一 FAIL → 用 systematic-debugging 口径定位（区分脚本口径错 vs 产品回归）：脚本口径错就修脚本；产品回归回修对应层（T1-T4 交付物）并记录。全过才进任务 2。

### 任务 2：SyncTunePage.tsx 头注释定稿（T1-T4 全部能力）

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx:21-38`（头注释块）

工作区已有未提交 +3 行（T1 描述草稿，已逐句核对 `AudioEngine.ts:44-53` 实现无误：async play / suspended 先 await resume 再建源 / resume 失败 return false 不置 playing / 徽标事件驱动——全对，保留）。

- [ ] **步骤 1：补 T3c 能力句（现缺）**

在 T3 段后、T3d 段前插入（与 5de3fbf 实际交付一致：删试听 A/B 与重置、加保存修改/撤销上一步、光标跨时值高亮）：

```ts
 * R2（T3c）：微调工作流重排——删试听 A/B 与重置，右栏「撤销上一步/保存修改」；
 * 保存即热切换显示时间轴（setTimeline 不重渲谱面），光标跨时值高亮启用。
```

- [ ] **步骤 2：核对 T2/T3/T3d/T4 句与代码一致（只读核对，不改即过）**

对照点：T2 控制条/图例/折叠/帮助面板（tsx:952-1131）；T3 highlightNoteAt/scrollToMeasure/5 秒让位/nearHint（tsx:162,401-406）；T3d 全量列表+行元数据 memo（tsx:869-878）；T4 patchMarker/rowMeta 单闭包/ticks 查表（OSMDScore.ts:711、tsx:872-878）。

- [ ] **步骤 3：tsc 快验**

运行：`npx tsc -b`（D:\Syrinx\app）
预期：零错误（注释改动不影响，但作为编辑后必跑步骤）。

### 任务 3：验证三连

- [ ] **步骤 1：`npx tsc -b`**（D:\Syrinx\app）预期零错误。
- [ ] **步骤 2：`npx vitest run`** 预期全绿、总数 ≥175（红线：175 不回归；本任务未动测试与产品逻辑）。
- [ ] **步骤 3：`npm run build`** 预期成功。
- [ ] 三项任一失败 → 停，systematic-debugging；不绿不 commit。

### 任务 4：T5 commit + R2 整体收官报告

- [ ] **步骤 1：逐文件 add（红线：并发 worker WIP 不碰）**

只 add：`app/scripts/walk-t5-r2.mjs`、`app/src/views/SyncTunePage.tsx`、`docs/superpowers/plans/2026-09-02-sync-tune-r2-t5-integration-walkthrough.md`。
**不碰**：`app/scripts/shot-entry.mjs`、`_intro_frames/`、`_preview_info.png`、`_spec_grid_*.png`、`shot_preview_info.py`、`verify_intro_flash.py`、`verify_spec_grid.py`、`docs/superpowers/plans/2026-09-01-planb-*` 与 `2026-09-01-sync-tune-r2-t3b-*`、`2026-09-01-sync-tune-r2-t3d-*`（他 worker WIP）、`_t5_walk/`（本任务截图证据，与既有截图产物同口径不入库）。提交前再跑 `git status --short` 核对暂存区只含上述三文件。

- [ ] **步骤 2：commit（dev 分支，不 push，不 merge）**

```
T5 chore(sync-tune): R2 收官——全流程走查脚本(11 步链路断言+截图) + 头注释定稿 T1-T4 全能力
```

- [ ] **步骤 3：R2 整体收官报告（T1-T5 汇总，输出给用户，不写文件）**

汇总口径：T1 音频修复 / T2 播放控制条+图例+帮助 / T3+T3b+T3c+T3d 选中可视化+命中+聚焦+工作流 / T4 感知性能量化（71.5→31.3ms、153.3→39.1ms、marker 写 602→1） / T5 走查 N/N PASS + 验证三连结果 + commit hash。

---

## 自检（writing-plans 口径）

1. **规格覆盖度：** 用户 prompt 11 步链路 → S1-S11 一一对应（含"行内各小节可点中"→ S6 三处采样；"波形亮线即时"→ S7 marker patch 断言）；头注释 T1-T4 全能力 → 任务 2（T1 草稿核对+T3c 补句+全段核对）；vitest/tsc/build → 任务 3；commit 前缀 T5/不 push/逐文件 add → 任务 4；规划书 T5 节的「试听 A/B」已被 5de3fbf 删除（T3c 重排），走查以 prompt 链路为准——已注明。✅
2. **占位符扫描：** 走查脚本为完整可运行代码；头注释补句为最终文本；无 TODO/待定。✅
3. **类型/契约一致性：** 断言用到的选择器、store 语义、色值均标注源码行号出处并已核实；`Browser.setDownloadBehavior` 为 CDP 稳定域方法；`readdirSync`/`readFileSync` 已在头部 import 区补 `readFileSync`（脚本代码块头部 import 行含全部用到的符号）。✅

## 执行方式

内联执行（executing-plans）——按任务 1→4 顺序，任务间检查点即各任务末步验证。

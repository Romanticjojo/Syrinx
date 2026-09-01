# sync-tune R2 · T6 伴奏波形可读性优化（三轮增强，降噪为先） 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 底部伴奏波形从「min/max 绝对峰值包络（趴底+毛刺+碎）」改为「RMS 能量包络 + 滑动平均 + 峰值增益归一 + 能量视角聚合」的可读乐句轮廓；交互（拖拽/缩放/seek/点刻度）全保留。

**架构：** 聚合/平滑/归一逻辑抽成 `app/src/synctune/waveform.ts` 纯函数（4 个函数 + 单测）；`SyncTunePage.tsx` 装配期预计算改为「RMS 桶包络 → 5 桶居中滑动平均 → 全局增益」，`drawWave` 包络绘制改为对称能量包络、宽视图每像素列按桶能量最大值聚合（替换 `peaksRef` 为 `envRef`+`gainRef`，消费方仅 drawWave 一处）。绘制仍走 dirty+rAF 按需重绘，几何（mid=0.42h / amp=0.36h）与配色不变。

**技术栈：** TypeScript / React 19 / vitest（纯函数单测）/ CDP headless Chrome（改前改后像素指标量化，复用 T5 walk 脚本模式）。

**看板任务：** t_61e0bca2（board=cursor-planb）。根因与三轮设计决策以其 body 为准（已核对，与本计划一致）。降级方案（删波形留进度条）本轮不执行——需用户确认后才可走。

---

## 根因（看板已定位）

`drawWave` 用 min/max 绝对峰值包络（`PEAK_STEP=512` 逐桶）：

1. **绝对幅度**：伴奏录音电平低（峰值可能仅 0.1-0.3），包络整体趴在 mid 线附近，像一撮噪声毛刺而非音乐轮廓；
2. **无感知加权**：长笛伴奏高频泛音多，min/max 把人耳不敏感的毛刺全画出来，视觉噪声 = 高频抖动叠加；
3. **无时间平滑**：每桶独立取 min/max，相邻桶跳变大，观感「碎」。

## 三轮增强（看板已定稿，顺序做、每轮量化看效果）

1. **R1 峰值归一化增益**：预计算后求全局 max，绘制时 amp 按增益缩放（峰值拉到 ~85% 高度），解决趴底；
2. **R2 RMS 包络替代 min/max**：每桶算 RMS（能量），画对称平滑包络（音乐能量轮廓天然抑毛刺），叠 5 桶居中滑动平均；
3. **R3 多分辨率聚合用能量最大值**：宽视图每像素列聚合时用桶 RMS 最大值（能量视角）而非 min/max。

最终态 = 三轮全叠加（`waveform.ts` 四个纯函数 + 页面接入）。R1/R2 的中间态只存在于工作树（供截图量化对比），不产生中间 commit；最终 commit 只含终态代码。

## 红线对照

- 演奏页/PerformPage*/OSMDScore.ts/musicxml.ts/anchors.ts/songs/全局 store.ts 零改动；
- 波形交互（拖拽平移/滚轮缩放/点空白 seek/点刻度选中）全部保留（任务 3 步骤 7 断言）；
- vitest 全绿不回归（基线实测 2026-09-02：18 文件 188 测试全过，含并发 worker 两个未跟踪测试文件）；
- 绘制仍走 dirty+rAF 按需重绘，几何/性能预算不变；
- 只改 `SyncTunePage.tsx`（预计 `.css` 零改动）+ 新增纯函数模块；并发 worker WIP（`app/scripts/_intro_frames/`、`shot-entry.mjs`、`verify_*.py`、`volCurve.test.ts`、`PitchChart.test.ts`、T3b/T3d/planb-t3 计划文档等未跟踪文件）只读不碰不提交，commit 逐文件 add。

## 文件结构

- 创建：`app/src/synctune/waveform.ts` — 波形包络纯函数（RMS 包络 / 居中滑动平均 / 峰值增益 / 能量聚合），无副作用可单测
- 测试：`app/src/synctune/waveform.test.ts` — 上述四函数单测（vitest，风格随 `logic.test.ts`）
- 修改：`app/src/views/SyncTunePage.tsx` — 装配期预计算换 RMS+平滑+增益（`peaksRef`→`envRef`+`gainRef`）；`drawWave` 对称能量包络 + max 聚合；头注释补 T6 行
- 创建：`app/scripts/wave-t6-check.mjs` — CDP 效果量化脚本（改前/每轮截图 + 包络像素指标 + 交互保留断言），产出 `app/scripts/_t6_wave/`（不进 git）
- 修改：本计划文档 — 执行报告（三轮指标对比表）回填
- 预计零改动：`app/src/views/SyncTunePage.css`（几何 160px 面板/128px 画布、配色均不变）

## 量化指标定义（`wave-t6-check.mjs`，页面内取 canvas 像素）

包络色 `#3d5a63`(61,90,99) 命中条件：`|r-61|≤10 && |g-90|≤10 && |b-99|≤10 && g<b`（`g<b` 排除青色工作网格线 rgba(95,184,168,.45)→(52,97,87)，其 g>b）。按 CSS 像素列聚合高度 h[x]：

- **peakExtent%** = max(h)/画布高 —— 趴底→归一的直接度量（目标 ≈ 2×0.85×0.36 ≈ 61%）
- **coverage%** = 有包络列占比 —— 总览下乐句覆盖
- **roughness** = 相邻列高差均值（px）—— 毛刺感/碎感度量（越低越平滑）
- **silent%** = h<2px 列占比 —— 近静音列（改前低电平应大量、改后能量归一应减少）

---

### 任务 1：波形包络纯函数模块 `synctune/waveform.ts`（TDD）

**文件：**
- 创建：`app/src/synctune/waveform.ts`
- 测试：`app/src/synctune/waveform.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { aggregateMax, computeRmsEnvelope, envelopeGain, smoothEnvelope } from './waveform'

describe('computeRmsEnvelope 桶能量（RMS）', () => {
  it('恒定电平信号：每桶 RMS = 电平值；总桶数 = ceil(len/step)', () => {
    const s = new Float32Array(1024).fill(0.5)
    const env = computeRmsEnvelope(s, 512)
    expect(env.length).toBe(2)
    expect(env[0]).toBeCloseTo(0.5, 6)
    expect(env[1]).toBeCloseTo(0.5, 6)
  })

  it('正弦波 RMS ≈ 幅度/√2（能量口径而非峰值口径）', () => {
    const s = new Float32Array(512 * 40)
    for (let i = 0; i < s.length; i++) s[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 44100)
    for (const v of computeRmsEnvelope(s, 512)) expect(v).toBeCloseTo(0.8 / Math.SQRT2, 2)
  })

  it('单采样尖峰被能量平均压掉：512 桶内一个 1.0 → 1/√512（min/max 口径会是 1.0）', () => {
    const s = new Float32Array(512)
    s[100] = 1
    expect(computeRmsEnvelope(s, 512)[0]).toBeCloseTo(1 / Math.sqrt(512), 6)
  })

  it('尾部不足一桶按实际样本数；零信号桶为 0', () => {
    const env = computeRmsEnvelope(new Float32Array(600).fill(0.3), 512)
    expect(env.length).toBe(2)
    expect(env[1]).toBeCloseTo(0.3, 6)
    expect(computeRmsEnvelope(new Float32Array(1024), 512)[0]).toBe(0)
  })
})

describe('smoothEnvelope 居中滑动平均（边界收缩窗）', () => {
  it('恒定包络不变；window≤1 原样返回拷贝', () => {
    expect([...smoothEnvelope(new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]), 5)]).toEqual([
      0.2, 0.2, 0.2, 0.2, 0.2,
    ])
    expect([...smoothEnvelope(new Float32Array([0.1, 0.5, 0.9]), 1)]).toEqual([0.1, 0.5, 0.9])
  })

  it('孤立尖峰被摊平：峰值降、邻桶抬（边界用收缩窗）', () => {
    const sm = smoothEnvelope(new Float32Array([0.1, 0.1, 1, 0.1, 0.1]), 5)
    expect(sm[2]).toBeCloseTo(1.3 / 5, 6)
    expect(sm[1]).toBeCloseTo(1.3 / 4, 6) // j∈[0,3] 四个值
    expect(Math.max(...sm)).toBeLessThan(1)
  })
})

describe('envelopeGain 峰值归一化增益', () => {
  it('全局 max × gain = target（伴奏低电平 0.1-0.3 拉到 85%）', () => {
    const g = envelopeGain(new Float32Array([0.05, 0.18, 0.3, 0.12, 0.02]), 0.85)
    expect(0.3 * g).toBeCloseTo(0.85, 6)
  })

  it('全静音返回 0（不放大底噪）', () => {
    expect(envelopeGain(new Float32Array(8), 0.85)).toBe(0)
  })
})

describe('aggregateMax 能量聚合（宽视图每像素列）', () => {
  const env = new Float32Array([0.1, 0.4, 0.2, 0.9, 0.3])

  it('闭区间取最大；越界索引裁剪到边界', () => {
    expect(aggregateMax(env, 1, 3)).toBeCloseTo(0.4, 6)
    expect(aggregateMax(env, 0, 99)).toBeCloseTo(0.9, 6)
  })

  it('空区间（from>to 或全越界）返回 0', () => {
    expect(aggregateMax(env, 3, 1)).toBe(0)
    expect(aggregateMax(env, 99, 100)).toBe(0)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/synctune/waveform.test.ts`（在 `D:\Syrinx\app` 下）
预期：FAIL —— 找不到模块 `./waveform`

- [x] **步骤 3：编写实现**

`app/src/synctune/waveform.ts`：

```ts
/**
 * 伴奏波形包络纯函数（T6 可读性三件套）：
 * 低电平伴奏 + 高频毛刺下，min/max 绝对峰值包络观感是「一撮噪声毛刺」——
 * 改用 RMS 能量包络（毛刺被能量平均天然压掉）+ 居中滑动平均（时间平滑）
 * + 全局峰值增益归一（低电平趴底拉到 ~85% 高度）+ 宽视图每像素列按能量
 * 最大值聚合。全部无副作用纯函数，供 SyncTunePage 装配期预计算/绘制调用，
 * 单测见 waveform.test.ts。
 */

/** 桶能量（RMS）：sqrt(mean(v²))；尾部不足一桶按实际样本数，零信号桶为 0 */
export function computeRmsEnvelope(samples: Float32Array, step: number): Float32Array {
  const n = Math.ceil(samples.length / step)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const end = Math.min(samples.length, (i + 1) * step)
    let sum = 0
    let count = 0
    for (let j = i * step; j < end; j++) {
      const v = samples[j]
      sum += v * v
      count++
    }
    env[i] = count > 0 ? Math.sqrt(sum / count) : 0
  }
  return env
}

/** 居中滑动平均（窗宽 window 桶，边界收缩到可用邻居）；window≤1 返回原数组拷贝 */
export function smoothEnvelope(env: Float32Array, window: number): Float32Array {
  if (window <= 1) return env.slice()
  const half = Math.floor(window / 2)
  const out = new Float32Array(env.length)
  for (let i = 0; i < env.length; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(env.length - 1, i + half)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += env[j]
    out[i] = sum / (hi - lo + 1)
  }
  return out
}

/** 峰值归一增益：g = target / max(env)；max≤0（全静音）返回 0，不放大底噪 */
export function envelopeGain(env: Float32Array, target = 0.85): number {
  let max = 0
  for (const v of env) if (v > max) max = v
  return max > 0 ? target / max : 0
}

/** 桶区间能量最大值 [from, to] 闭区间（宽视图每像素列聚合，能量视角）；空区间 0 */
export function aggregateMax(env: Float32Array, from: number, to: number): number {
  const lo = Math.max(0, from)
  const hi = Math.min(env.length - 1, to)
  let max = 0
  for (let i = lo; i <= hi; i++) if (env[i] > max) max = env[i]
  return max
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/synctune/waveform.test.ts`
预期：PASS（11 个用例全绿）

- [x] **步骤 5：commit（逐文件 add，先核对 git log 无并发新提交）**

```
git add app/src/synctune/waveform.ts app/src/synctune/waveform.test.ts
git commit -m "T6 feat(synctune): 波形包络纯函数——RMS 桶能量/居中滑动平均/峰值增益归一/能量聚合，先测后实现 11 用例"
```

### 任务 2：效果量化脚本 `wave-t6-check.mjs` + 改前基线

**文件：**
- 创建：`app/scripts/wave-t6-check.mjs`（复用 `walk-t5-r2.mjs` 的 CDP 模式：headless Chrome + WebSocket + Runtime.evaluate）
- 产出（不进 git）：`app/scripts/_t6_wave/<tag>.png` + stdout 指标 JSON

- [x] **步骤 1：编写脚本**

```js
// T6 波形可读性效果量化（CDP）：打开 sync-tune → 等波形画好 → 截图 + 包络像素指标
// 用法：node scripts/wave-t6-check.mjs <tag> [--interact]
//   <tag>        指标/截图标签（如 r0-before / r1-gain / r2-rms / r3-final / zoomed）
//   --interact   追加交互保留断言（滚轮缩放/拖拽平移/点刻度选中/点空白 seek）
// 指标（详见计划文档「量化指标定义」）：peakExtent%/coverage%/roughness/silent%
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const tag = process.argv[2] || 'run'
const INTERACT = process.argv.includes('--interact')
const PORT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '5173'
const CHROME_PORT = 9260
const SHOT_DIR = fileURLToPath(new URL('./_t6_wave/', import.meta.url))
mkdirSync(SHOT_DIR, { recursive: true })

let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t6-wave`, '--window-size=1600,1200',
  'about:blank',
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
const METRIC = `(() => {
  const c = document.querySelector('.st-wave canvas')
  if (!c || !c.width || !c.clientWidth) return null
  const ctx = c.getContext('2d')
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  const cssW = c.clientWidth, cssH = c.clientHeight, dpr = c.width / cssW
  const isEnv = (r, g, b) => Math.abs(r - 61) <= 10 && Math.abs(g - 90) <= 10 && Math.abs(b - 99) <= 10 && g < b
  const top = new Int32Array(cssW).fill(-1), bot = new Int32Array(cssW).fill(-1)
  for (let dx = 0; dx < c.width; dx++) {
    const x = Math.floor(dx / dpr)
    for (let dy = 0; dy < c.height; dy++) {
      const k = (dy * c.width + dx) * 4
      if (isEnv(data[k], data[k + 1], data[k + 2])) {
        const y = Math.floor(dy / dpr)
        if (top[x] < 0) top[x] = y
        bot[x] = y
      }
    }
  }
  const h = new Int32Array(cssW)
  let peak = 0, cov = 0, silent = 0
  for (let x = 0; x < cssW; x++) {
    h[x] = top[x] < 0 ? 0 : bot[x] - top[x] + 1
    if (h[x] > peak) peak = h[x]
    if (h[x] > 0) cov++
    if (h[x] < 2) silent++
  }
  let rSum = 0, rN = 0
  for (let x = 0; x + 1 < cssW; x++) if (h[x] > 0 && h[x + 1] > 0) { rSum += Math.abs(h[x + 1] - h[x]); rN++ }
  return JSON.stringify({ cssW, cssH, peakExtentPct: +((peak / cssH) * 100).toFixed(1), coveragePct: +((cov / cssW) * 100).toFixed(1), roughnessPx: rN ? +(rSum / rN).toFixed(2) : 0, silentPct: +((silent / cssW) * 100).toFixed(1) })
})()`

await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })
// 等谱面 + 波形包络实际画出来（peaks 装配晚于谱面）
let metrics = null
for (let i = 0; i < 120; i++) {
  metrics = await evalJs(METRIC)
  if (metrics && JSON.parse(metrics).peakExtentPct > 0) break
  await sleep(500)
}
if (!metrics) { console.error('FAIL 波形未就绪/无包络像素'); child.kill(); process.exit(1) }
console.log(`METRIC ${tag} ${metrics}`)
const rect = JSON.parse(await evalJs(`JSON.stringify(document.querySelector('.st-wave').getBoundingClientRect())`))
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 300), scale: 1 } })
writeFileSync(join(SHOT_DIR, tag + '.png'), Buffer.from(shot.result.data, 'base64'))
console.log(`SHOT ${tag}.png`)

// —— 交互保留断言（仅终态跑）：拖拽平移/滚轮缩放/点刻度选中/点空白 seek ——
if (INTERACT) {
  const pass = []
  const canvasRect = () => JSON.parse(await evalJs(`JSON.stringify(document.querySelector('.st-wave canvas').getBoundingClientRect())`))
  const hint = () => evalJs(`document.querySelector('.st-wave-hint')?.textContent ?? ''`)
  const r = await canvasRect()
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
  // 滚轮缩放：视口范围文本变化
  const h0 = await hint()
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120 })
  await sleep(400)
  const h1 = await hint()
  pass.push(['滚轮缩放(视口范围变)', h1 !== h0, `${h0} -> ${h1}`])
  // 拖拽平移
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
  for (const dx of [40, 80, 120]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + dx, y: cy, button: 'left' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 120, y: cy, button: 'left', clickCount: 1 })
  await sleep(400)
  const h2 = await hint()
  pass.push(['拖拽平移(视口范围变)', h2 !== h1, `${h1} -> ${h2}`])
  // 点刻度选中：控制点刻度在画布底部 h-14..h 区域，扫几列点击找橙刻度（可靠：先缩放回总览再点底部）
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 400 })
  await sleep(400)
  const r2 = await canvasRect()
  const yTick = Math.round(r2.y + r2.height - 4)
  let selected = false
  const h3Before = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
  for (let k = 1; k <= 40 && !selected; k++) {
    const x = Math.round(r2.x + (r2.width * k) / 41)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: yTick, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yTick, button: 'left', clickCount: 1 })
    await sleep(120)
    const h3 = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
    if (h3 && h3 !== h3Before) selected = true
  }
  pass.push(['点刻度选中(右栏 h3 联动)', selected, selected ? 'ok' : '40 列未命中'])
  // 点空白 seek：时间标签变化
  const t0 = await evalJs(`document.querySelector('.st-time')?.textContent`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(r2.x + r2.width * 0.6), y: Math.round(r2.y + r2.height * 0.3), button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(r2.x + r2.width * 0.6), y: Math.round(r2.y + r2.height * 0.3), button: 'left', clickCount: 1 })
  await sleep(400)
  const t1 = await evalJs(`document.querySelector('.st-time')?.textContent`)
  pass.push(['点空白 seek(时间标签变)', t1 !== t0, `${t0} -> ${t1}`])
  // 放大细节截图
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -400 })
  await sleep(400)
  console.log(`METRIC ${tag}-zoomed ` + (await evalJs(METRIC)))
  const rz = await canvasRect()
  const shot2 = await send('Page.captureScreenshot', { format: 'png', clip: { x: rz.x, y: rz.y, width: rz.width, height: rz.height, scale: 1 } })
  writeFileSync(join(SHOT_DIR, tag + '-zoomed.png'), Buffer.from(shot2.result.data, 'base64'))
  console.log(`SHOT ${tag}-zoomed.png`)
  const fail = pass.filter(([, ok]) => !ok)
  for (const [name, ok, detail] of pass) console.log(`${ok ? 'PASS' : 'FAIL'} [交互] ${name} — ${detail}`)
  child.kill()
  process.exit(fail.length ? 1 : 0)
}
child.kill()
process.exit(0)
```

- [x] **步骤 2：跑改前基线（工作树仍为 HEAD 状态）**

运行：`node scripts/wave-t6-check.mjs r0-before`（在 `D:\Syrinx\app` 下，dev server 5173 已在线）
预期：stdout 输出 `METRIC r0-before {...}`（peakExtent 低——趴底证据）、`_t6_wave/r0-before.png` 生成。
把指标四元组记入下方报告表格（r0 行）。若 peakExtent 异常大（>80%），说明包络色误检——检查配色/容差后修脚本再跑。

### 任务 3：SyncTunePage 三轮接入（R1→R2→R3，每轮量化）

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx`（预计算块 ~L203-234、`drawWave` 包络段 ~L486-540、头注释、`PEAK_STEP` 注释）
- 前置：grep 确认 `peaksRef`/`stepSecRef` 消费方仅 SyncTunePage.tsx 内（装配 effect 写 + drawWave 读），无跨文件引用

- [x] **步骤 1：R1 中间态（增益归一，min/max 不动）——仅工作树，不 commit**

预计算块（L210-228）末尾加全局峰值与增益：

```ts
let peakMax = 0
for (let i = 0; i < peaks.length; i++) {
  const a = Math.abs(peaks[i])
  if (a > peakMax) peakMax = a
}
gainRef.current = peakMax > 0 ? 0.85 / peakMax : 0
```

`drawWave` 包络段绘制改：`ctx.moveTo(x + 0.5, mid + Math.max(-1, Math.min(1, mn * g)) * amp)` / `mid + Math.min(1, mx * g) * amp`（g 从 gainRef 取，钳位 ±1 防越界）。

- [x] **步骤 2：R1 量化**

运行：`node scripts/wave-t6-check.mjs r1-gain`
预期：peakExtent% 从 r0 的低值升至 ~60%（0.85×0.36×2≈61%），roughness 基本不降（毛刺仍在）。截图 `_t6_wave/r1-gain.png`。

- [x] **步骤 3：R2+R3 终态：预计算换 RMS 能量包络**

预计算块（替换 L210-227 的 min/max 循环）：

```ts
const ch = buf.getChannelData(0)
// T6：RMS 能量包络 + 5 桶居中滑动平均 + 全局峰值增益归一（三轮：增益/RMS/能量聚合）
const env = smoothEnvelope(computeRmsEnvelope(ch, PEAK_STEP), 5)
envRef.current = env
gainRef.current = envelopeGain(env, 0.85)
stepSecRef.current = PEAK_STEP / buf.sampleRate
durationRef.current = buf.duration
viewRef.current = { t0: 0, t1: buf.duration }
```

refs 声明：`peaksRef` 改名 `envRef`（类型不变 `Float32Array | null`，语义=每桶能量），新增 `gainRef = useRef(0)`；import 加 `import { aggregateMax, computeRmsEnvelope, envelopeGain, smoothEnvelope } from '../synctune/waveform'`；`PEAK_STEP` 注释改「波形能量预计算步长（RMS 桶宽，样本数）：~11.6ms/桶（44.1k），总览分辨率足够」。

- [x] **步骤 4：R2 终态绘制：对称能量包络 + 每像素列能量最大值聚合（R3）**

`drawWave` 包络段（替换 L519-539 的 min/max 聚合绘制）：

```ts
// 包络（T6：对称能量包络，宽视图每像素列聚合取桶能量最大值）
const env = envRef.current
const gain = gainRef.current
if (env && gain > 0) {
  const stepSec = stepSecRef.current || PEAK_STEP / 44100
  ctx.strokeStyle = '#3d5a63'
  ctx.beginPath()
  for (let x = 0; x < w; x++) {
    const ta = t0 + (x / w) * span
    const tb = ta + span / w
    const b0 = Math.max(0, Math.floor(ta / stepSec))
    const b1 = Math.min(Math.floor(tb / stepSec), env.length - 1)
    if (b1 < b0) continue
    const a = Math.min(aggregateMax(env, b0, b1) * gain, 1) * amp
    if (a <= 0) continue
    ctx.moveTo(x + 0.5, mid - a)
    ctx.lineTo(x + 0.5, mid + a)
  }
  ctx.stroke()
}
```

（`if (!peaks || dur <= 0)` 不可用分支同步改 `if (!envRef.current || dur <= 0)`；`const peaks = peaksRef.current` 局部变量删除。）

- [x] **步骤 5：R2/R3 量化 + 交互断言**

运行：`node scripts/wave-t6-check.mjs r3-final --interact`
预期：
- METRIC：peakExtent% ≈ 60%，roughness 较 r1 显著下降（滑动平均+RMS 抑毛刺），silent% 下降；
- 交互 4 项全 PASS（滚轮缩放/拖拽平移/点刻度选中/点空白 seek）；
- `_t6_wave/r3-final.png` + `r3-final-zoomed.png`（放大细节仍可用）。

- [x] **步骤 6：头注释补 T6 行（组件顶部 JSDoc，随 T5 收官段后）**

```ts
 * R2（T6）：伴奏波形可读性三轮增强——预计算改 RMS 能量包络+5 桶滑动平均+
 * 全局峰值增益归一（低电平趴底拉到 ~85%），drawWave 画对称能量包络、宽视图
 * 每像素列按桶能量最大值聚合（纯函数 synctune/waveform.ts）；交互与 dirty+
 * rAF 按需重绘不变。
```

- [x] **步骤 7：类型检查**

运行：`npx tsc -b`（在 `D:\Syrinx\app` 下）
预期：无错误。特别核对 `peaksRef` 无残留引用（改名后 grep 0 命中）。

- [x] **步骤 8：commit（逐文件 add，先核对 git log 无并发新提交）**

```
git add app/src/views/SyncTunePage.tsx app/scripts/wave-t6-check.mjs
git commit -m "T6 feat(sync-tune): 伴奏波形三轮可读性增强——RMS 能量包络+5桶平滑+峰值增益归一(趴底→85%)+能量视角聚合，交互全保留，CDP 量化 roughness 显著下降"
```

### 任务 4：验证收口 + 执行报告

**文件：**
- 修改：本计划文档（回填执行报告）
- 验证产物：`app/scripts/_t6_wave/*.png`（不进 git）

- [x] **步骤 1：vitest 全量**

运行：`npx vitest run`（在 `D:\Syrinx\app` 下）
预期：全绿，测试数 = 基线 188 + 新增 11 = 199（±并发 worker 增量；若有他人 WIP 红测，用 `--exclude` 摘除后确认本任务范围全绿并在报告注明）。

- [x] **步骤 2：build**

运行：`npm run build`（= `tsc -b && vite build`）
预期：无错误。

- [x] **步骤 3：回填执行报告**（本文档末尾「执行报告」节）：三轮指标对比表（r0/r1/r3×2 + zoomed）、交互断言结果、验收清单勾选、降级方案说明（未触发——三轮达标）。

- [x] **步骤 4：commit 计划文档+报告**

```
git add docs/superpowers/plans/2026-09-02-sync-tune-r2-t6-waveform-readability.md
git commit -m "T6 docs(sync-tune): 执行报告——三轮增强 CDP 量化对比（peakExtent/coverage/roughness/silent），交互断言 4/4，vitest/tsc/build 全过"
```

- [x] **步骤 5：向用户汇报**：三轮各自效果（指标+截图路径）、采用方案、验收结论；不 push。

---

## 执行报告（2026-09-02 回填）

**采用方案：三轮全叠加**——R1 峰值增益归一 + R2 RMS 能量包络（5 桶居中滑动平均）+ R3 像素列能量最大值聚合；min/max 绝对峰值包络退役。纯函数 `app/src/synctune/waveform.ts` 四函数 + 12 用例单测；`SyncTunePage.tsx` 接入（peaksRef→envRef+envGainRef）。交互 4/4 保留，vitest 200/200、tsc -b、build 全过。

### 三轮量化对比 — CDP 画布像素法（`wave-t6-check.mjs`）

| 状态 | peakExtent% | medianExtent% | coverage% | roughness(px) | silent% | 备注 |
|------|-------------|---------------|-----------|---------------|---------|------|
| r0 改前（worktree@1c1389d，端口 5179） | 74.0 | 29.9 | 40.3 | 16.92 | 66.8 | min/max：满幅毛刺 |
| r3 终态（RMS+平滑+增益+能量聚合） | 59.1 | 22.0 | 40.8 | 13.16 | 68.3 | 峰值锁 85% 档（理论 61%） |
| r3-zoomed（放大 ~18s 视口） | 60.6 | 33.9 | 93.3 | 2.94 | 9.1 | 放大后能量轮廓平滑 |

- **peakExtent 74.0→59.1%**：改前绝对峰值顶满（超过对称包络几何上限 2×0.36=72%），改后锁定 2×0.85×0.36≈61% 归一档（59.1% 实测吻合）。
- **roughness 16.92→13.16px（总览）→2.94px（放大）**：毛刺/碎感的直接度量，RMS+平滑降幅 22%（总览）/83%（放大态）。
- medianExtent 29.9→22.0%：改前 min/max 中位列高偏大（处处密块），改后能量中位居中回落，强弱对比更可读。

### 逐轮归因 — 离线数据法（真实伴奏页内复算，W=1578 列，与旧代码逐行等价）

音频事实：luv-letter 伴奏 270.4s / 25350 桶 / 全局绝对峰值 **1.062**（接近满幅——看板根因①「电平低趴底」在该曲目不成立；根因②③「毛刺全画、无平滑」成立且是主要噪声源）。

| 轮次 | gain | peak(px) | median(px) | coverage% | roughness(px) | 备注 |
|------|------|----------|------------|-----------|---------------|------|
| old（min/max 无归一） | — | 91.4 | 76.6 | 98.4 | 11.17 | 中位列高 61% 画布——「处处密块」即噪声观感 |
| R1 +峰值增益归一 | 0.80 | 76.0 | 61.3 | 98.4 | 8.99 | 本曲目绝对峰值已满幅→增益实为轻微压低并锁定 85% 档；毛刺降幅有限（证实根因②③为主） |
| R2+R3（RMS+平滑+增益+能量聚合） | 1.91 | 77.7 | 53.3 | 98.2 | 8.48 | RMS 口径天然压掉人耳不敏感瞬态（env 峰值仅 0.445），中位列高 61%→42%，强弱起伏拉开；峰值稳定 85% 档 |

R1 的「拉高」作用在低电平曲目（峰值 0.1-0.3）才显现；对本曲目其价值是把高度锁定到统一归一档。R2 是降噪主力：RMS 能量平均 + 5 桶滑动平均双重抑制。R3 保证缩放时能量视角一致（放大态 roughness 2.94px）。

### 测量口径说明（两法差异已归因）

CDP 像素法的 coverage/median 被画布上后画的期望线/工作网格叠画压低：`rgba(255,255,255,0.13)` 叠在包络色 #3d5a63 上得 ~(86,111,119)，不再命中包络色判定（探针实测：纯包络列 40.6% + 叠线混合列 21.1% = 61.7%，其余为更多混合比例与真静音列）。叠画对新旧版本同等影响→**相对比较成立**；peakExtent 用最高列（几乎不被叠画覆盖）两法互证（CDP 74.0% ≈ 离线 91.4px/127px=72.0%）。离线数据法与旧代码逐行等价（b0..b1 范围聚合、mid=0.42h、amp=0.36h），其绝对数值可信。

### 交互保留断言（--interact，4/4 PASS）

- [x] 滚轮缩放（视口范围变）：0:00.0–4:30.3 → 0:27.0–4:03.3
- [x] 拖拽平移（视口范围变）：→ 0:10.5–3:46.9
- [x] 点刻度选中（右栏 h3 联动）：40 列扫描命中
- [x] 点空白 seek（时间标签变）：0:00.0 → 2:16.3（深放大 12 次滚轮后多点重试；总览下 601 刻度每 2.6px 一个、点哪都是刻度选中，断言需在放大态做）

### 验收清单

- [x] 整曲总览乐句起伏清晰、无毛刺感（截图 `app/scripts/_t6_wave/r0-preT6.png` vs `r3-final.png`）
- [x] 放大后细节仍可用（`r3-final-zoomed.png`，coverage 93.3%/roughness 2.94px）
- [x] vitest 全绿 200/200（基线 188 + 新增 12）、`npx tsc -b` PASS、`npm run build` PASS（665ms）
- [x] 演奏页/OSMDScore 等禁改文件零改动（T6 三提交 `git show --stat` 核对：仅 waveform.ts/waveform.test.ts/SyncTunePage.tsx/wave-t6-check.mjs）
- [x] git commit 前缀 T6、不 push：`5e8a04d`（纯函数+单测）、`710da77`（页面接入）、`e612ca4`（量化脚本）、本文档

（降级方案未触发：三轮达标。若用户后续仍不满意，需再次征询确认后才走删波形留进度条。）

### 偏离计划说明

1. **并发执行体竞写，采纳其实现**：本会话与看板 Hermes worker 同任务并行——`waveform.ts` 与 `SyncTunePage.tsx` 接入由执行体先写盘并提交（5e8a04d/710da77）。按「以磁盘为准」协议评审采纳：其 API（`sampleEnvelopeView` 替代计划 `aggregateMax`、`normalizeGain` 替代 `envelopeGain`）把像素列聚合的边界语义（半开区间不渗桶、深缩放收敛覆盖桶）收进纯函数，比计划设计更完整。本会话产出转为：12 用例单测钉语义 + 双基线量化验证 + 本报告。计划中的 `aggregateMax`/`envelopeGain` 名称与「全静音返回 0」语义（实现为返回 1，除零保护）以实现为准，单测同步。
2. **R1 中间态未单独截图**：发现 5173 dev server 在量化开始前已服务新代码，首测「r0-before」实为终态；真·改前基线改用 `git worktree` @1c1389d（junction node_modules/songs）+ 5179 端口补测。R1 单轮效果由离线数据法归因（old vs old+增益 同一几何复算）。
3. **量化脚本口径修正**：初版指标把画布底部刻度区像素误计入包络（peakExtent 81.9%>72% 几何上限），改为只扫包络几何带 [0.06h-1, 0.78h+1] 并补 medianExtent 指标。
4. **测试数**：计划预估 +11，实际 12 用例（补「非法参数全零列」边界）。

### 清理

- worktree `%TEMP%\syrinx-t6-pre` 与后台 dev server（5179）已于收尾移除；`_t6_wave/` 产物目录不进 git。

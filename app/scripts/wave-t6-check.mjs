// T6 波形可读性效果量化（CDP）：打开 sync-tune → 等波形画好 → 截图 + 包络像素指标
// 用法：node scripts/wave-t6-check.mjs <tag> [--interact] [port]
//   <tag>        指标/截图标签（如 r0-before / r1-gain / r3-final）
//   --interact   追加交互保留断言（滚轮缩放/拖拽平移/点刻度选中/点空白 seek）+ 放大截图
//   port         dev server 端口（默认 5173）
// 指标（包络色 #3d5a63 按列聚合命中高度；g<b 排除青色工作网格线 (52,97,87)）：
//   peakExtent% 最大列高/画布高（趴底→归一直接度量，目标 ≈ 2×0.85×0.36 ≈ 61%）
//   coverage%   有包络列占比 | roughnessPx 相邻列高差均值（毛刺感）| silent% 近零列占比
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
  // 只扫包络几何带 [mid-amp, mid+amp]±1（drawWave 几何），底部刻度区(y>0.78h)不可能是包络
  const yLo = Math.max(0, Math.floor(0.06 * cssH) - 1), yHi = Math.min(cssH - 1, Math.ceil(0.78 * cssH) + 1)
  const isEnv = (r, g, b) => Math.abs(r - 61) <= 10 && Math.abs(g - 90) <= 10 && Math.abs(b - 99) <= 10 && g < b
  const top = new Int32Array(cssW).fill(-1), bot = new Int32Array(cssW).fill(-1)
  for (let dx = 0; dx < c.width; dx++) {
    const x = Math.floor(dx / dpr)
    for (let dy = 0; dy < c.height; dy++) {
      const y = Math.floor(dy / dpr)
      if (y < yLo || y > yHi) continue
      const k = (dy * c.width + dx) * 4
      if (isEnv(data[k], data[k + 1], data[k + 2])) {
        if (top[x] < 0) top[x] = y
        bot[x] = y
      }
    }
  }
  const h = new Int32Array(cssW)
  let peak = 0, cov = 0, silent = 0
  const hs = []
  for (let x = 0; x < cssW; x++) {
    h[x] = top[x] < 0 ? 0 : bot[x] - top[x] + 1
    if (h[x] > peak) peak = h[x]
    if (h[x] > 0) { cov++; hs.push(h[x]) }
    if (h[x] < 2) silent++
  }
  hs.sort((a, b) => a - b)
  const median = hs.length ? hs[Math.floor(hs.length / 2)] : 0
  let rSum = 0, rN = 0
  for (let x = 0; x + 1 < cssW; x++) if (h[x] > 0 && h[x + 1] > 0) { rSum += Math.abs(h[x + 1] - h[x]); rN++ }
  return JSON.stringify({ cssW, cssH, peakExtentPct: +((peak / cssH) * 100).toFixed(1), medianExtentPct: +((median / cssH) * 100).toFixed(1), coveragePct: +((cov / cssW) * 100).toFixed(1), roughnessPx: rN ? +(rSum / rN).toFixed(2) : 0, silentPct: +((silent / cssW) * 100).toFixed(1) })
})()`

await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })
// 等谱面装配 + 波形包络实际画出来（peaks 解码晚于曲谱）
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

// —— 交互保留断言（仅终态跑）：滚轮缩放/拖拽平移/点刻度选中/点空白 seek ——
if (INTERACT) {
  const pass = []
  const canvasRect = async () => JSON.parse(await evalJs(`JSON.stringify(document.querySelector('.st-wave canvas').getBoundingClientRect())`))
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
  // 点刻度选中：缩放回总览，画布底部逐列点击找控制点刻度（底部 8px 区域）
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
  // 点空白 seek：先深放大（总览下 601 刻度每 2.6px 一个 ±6px 命中，点哪都是刻度
  // 选中；一次滚轮仅 ×0.8，需连发 12 次把 span 压到 ~18s、刻度间距 ~38px 才有
  // 间隙可点），再在若干 x 处试到时间标签变化为止
  for (let i = 0; i < 12; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120 })
    await sleep(60)
  }
  await sleep(400)
  const r3 = await canvasRect()
  const yBlank = Math.round(r3.y + r3.height * 0.3)
  const t0 = await evalJs(`document.querySelector('.st-time')?.textContent`)
  let sought = false
  for (const frac of [0.5, 0.52, 0.56, 0.6, 0.64, 0.68, 0.72]) {
    const x = Math.round(r3.x + r3.width * frac)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: yBlank, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yBlank, button: 'left', clickCount: 1 })
    await sleep(300)
    const t1 = await evalJs(`document.querySelector('.st-time')?.textContent`)
    if (t1 !== t0) { sought = true; pass.push(['点空白 seek(时间标签变)', true, `${t0} -> ${t1}`]); break }
  }
  if (!sought) pass.push(['点空白 seek(时间标签变)', false, `${t0} 未变（7 处 x 均命中刻度?）`])
  // 放大细节指标 + 截图
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

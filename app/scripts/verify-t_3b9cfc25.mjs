// 验证 t_3b9cfc25（dev 服 + CDP 实测）：
//   1. 谱面可读性：sheet-container 有 backdrop blur；notehead 降为 #e8e8e2（无纯白 #fdfdf8）
//   2. 伴奏锚点光标：beats.json 已加载；在 5 个锚点时刻（含跳段两侧 m9/m40、变速点 m57）
//      seek 后 HUD 小节 == 锚点小节（逐拍对齐验收）
// 用法：先起 dev（npx vite --port 5199），再 node scripts/verify-t_3b9cfc25.mjs
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9241
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-t3b9'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1440,1000',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank',
], { stdio: 'ignore' })

let version
for (let i = 0; i < 50; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) }
}
if (!version) { console.error('CDP not up'); child.kill(); process.exit(2) }
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`D:/Syrinx/docs/screenshots/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)

// 进演奏页：点 luv-letter 卡片 → 开始演奏
await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.song-card')]
  const c = cards.find(x => x.innerText.includes('Luv Letter'))
  if (c) { c.click(); return 'card' } return 'no-card'
})()`)
await sleep(2000)
const started = await evalJs(`(() => {
  const b = document.querySelector('[aria-label="开始演奏"]')
  if (b) { b.click(); return 'perform' } return 'not-found'
})()`)
console.log('enter perform:', started)
// 演奏页就绪浮层 → 点真正的起奏按钮（ov-start），随后 4 拍倒数（90bpm ≈ 2.67s）+ 余量
for (let i = 0; i < 20; i++) {
  const ready = await evalJs(`(() => {
    const b = document.querySelector('.ov-start')
    if (b) { b.click(); return 'ov-start' } return 'waiting'
  })()`)
  if (ready === 'ov-start') break
  await sleep(500)
}
await sleep(5500)

const phase = await evalJs(`document.querySelector('.count-num') ? 'countdown' : (document.querySelector('.progress-rail') ? 'performing' : 'other')`)
console.log('phase:', phase)

/* ---------- 1. 谱面可读性 ---------- */
const readability = await evalJs(`(() => {
  const el = document.querySelector('.sheet-container')
  const cs = el ? getComputedStyle(el) : null
  return {
    blur: cs?.backdropFilter ?? cs?.webkitBackdropFilter ?? 'none',
    dimHeads: document.querySelectorAll('[fill="#e8e8e2"]').length,
    pureWhiteHeads: document.querySelectorAll('[fill="#fdfdf8"]').length,
    dimMusic: document.querySelectorAll('[fill="#dedbd3"]').length,
  }
})()`)
console.log('readability:', JSON.stringify(readability))
await shot('t3b9-perform-readable')

/* ---------- 2. 伴奏锚点光标：5 个锚点时刻 ---------- */
const beatsOk = await evalJs(`fetch('/songs/luv-letter/beats.json').then(r => r.ok).catch(() => false)`)
console.log('beats.json reachable:', beatsOk)

// (measure, anchor time)——来自 beats.json：m5=10.6 m9=36.65 m20=70.45 m40=162.35 m57=246.0
const SAMPLES = [
  [5, 10.6], [9, 36.65], [20, 70.45], [40, 162.35], [57, 246.0],
]
let pass = 0
for (const [m, t] of SAMPLES) {
  await evalJs(`(async () => {
    const { audioEngine } = await import('/src/audio/AudioEngine.ts')
    audioEngine.seek(${t} + 0.5)
    return 1
  })()`)
  await sleep(900) // rAF 同步光标 + HUD
  const hud = await evalJs(`document.querySelector('.hud-stat .num')?.textContent ?? 'none'`)
  const ok = hud?.trim().startsWith(String(m).padStart(2, '0'))
  if (ok) pass++
  console.log(`t=${(t + 0.5).toFixed(1)}s expect m${m}  hud="${hud?.trim()}"  ${ok ? 'OK' : 'FAIL'}`)
}
console.log('---')
console.log('RESULT readability:', readability.blur !== 'none' && readability.dimHeads > 0 && readability.pureWhiteHeads === 0 ? 'PASS' : 'FAIL')
console.log('RESULT anchor cursor alignment:', `${pass}/${SAMPLES.length}`, pass === SAMPLES.length ? 'PASS' : 'FAIL')
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(readability.blur !== 'none' && readability.dimHeads > 0 && readability.pureWhiteHeads === 0 && pass === SAMPLES.length ? 0 : 1)

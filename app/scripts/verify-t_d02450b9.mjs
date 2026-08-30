// 验证 t_d02450b9（73 小节补全谱 + v2 伴奏锚点，dev 服 + CDP 实测）：
//   1. beats.json v2 可达；解析谱面 73 小节、仅 voice 1
//   2. 8 个锚点时刻 seek 后 HUD 小节 == 锚点小节（含补全小节 m33/m62/m73）
// 用法：先起 dev（npx vite --port 5199），再 node scripts/verify-t_d02450b9.mjs
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9242
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-td02450b9'
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

// 进演奏页
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
for (let i = 0; i < 20; i++) {
  const ready = await evalJs(`(() => {
    const b = document.querySelector('.ov-start')
    if (b) { b.click(); return 'ov-start' } return 'waiting'
  })()`)
  if (ready === 'ov-start') break
  await sleep(500)
}
await sleep(5500)

/* ---------- 1. 数据面：beats v2 + 73 小节 + 单声部 ---------- */
const data = await evalJs(`(async () => {
  const beats = await (await fetch('/songs/luv-letter/beats.json')).json()
  const xmlText = await (await fetch('/songs/luv-letter/score.musicxml')).text()
  const measures = (xmlText.match(/<measure number="/g) ?? []).length
  const voices = new Set([...xmlText.matchAll(/<voice>([^<]*)<\\/voice>/g)].map(m => m[1]))
  const { loadSong } = await import('/src/songs/index.ts')
  const manifest = (await import('/src/songs/index.ts')).SONGS.find(s => s.id === 'luv-letter')
  const { timeline } = await loadSong(manifest)
  return {
    beatsVersion: beats.version,
    anchorCount: beats.anchors.length,
    measures,
    voices: [...voices],
    measureTimes: timeline.measureTimes.length,
    notes: timeline.notes.length,
  }
})()`)
console.log('data:', JSON.stringify(data))

/* ---------- 2. 锚点光标：8 个时刻（含补全小节） ---------- */
// 来自 beats.json v2：m5=10.6 m9=36.65 m20=64.75 m33=110.55(补) m40=132.65 m56=193.6 m62=217.9(补) m73=256.0
const SAMPLES = [
  [5, 10.6], [9, 36.65], [20, 64.75], [33, 110.55],
  [40, 132.65], [56, 193.6], [62, 217.9], [73, 256.0],
]
let pass = 0
for (const [m, t] of SAMPLES) {
  await evalJs(`(async () => {
    const { audioEngine } = await import('/src/audio/AudioEngine.ts')
    audioEngine.seek(${t} + 0.5)
    return 1
  })()`)
  await sleep(900)
  const hud = await evalJs(`document.querySelector('.hud-stat .num')?.textContent ?? 'none'`)
  const ok = hud?.trim().startsWith(String(m).padStart(2, '0'))
  if (ok) pass++
  console.log(`t=${(t + 0.5).toFixed(1)}s expect m${m}  hud="${hud?.trim()}"  ${ok ? 'OK' : 'FAIL'}`)
}
await shot('td02450b9-perform-73')
console.log('---')
const dataOk = data.beatsVersion === 2 && data.anchorCount === 73 && data.measures === 73
  && data.voices.join(',') === '1' && data.measureTimes === 74
console.log('RESULT data(73 measures, voice1, beats v2):', dataOk ? 'PASS' : 'FAIL')
console.log('RESULT anchor cursor alignment:', `${pass}/${SAMPLES.length}`, pass === SAMPLES.length ? 'PASS' : 'FAIL')
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(dataOk && pass === SAMPLES.length ? 0 : 1)

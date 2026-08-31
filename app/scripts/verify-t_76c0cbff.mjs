// 验证 t_76c0cbff（Soundslice 精校谱 72 小节 + beats v3 播放序锚点，dev 服 + CDP 实测）：
//   1. beats.json v3 可达（97 锚点）；印谱 72 小节；展开谱 measureTimes 98；wavy-line ×3
//   2. 锚点时刻 seek 后 HUD 小节 == 播放序小节（seq1=m1 / seq46=m36 / seq92=m70 / seq97=m72）
//   3. m70 区域截图（人工核对波浪线）+ console 零错误
// 用法：先起 dev（npx vite --port 5199），再 node scripts/verify-t_76c0cbff.mjs
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9243
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-t76c0cbff'
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

/* ---------- 1. 数据面：beats v3 + 72 印谱 + 展开 98 + wavy-line ---------- */
const data = await evalJs(`(async () => {
  const beats = await (await fetch('/songs/luv-letter/beats.json')).json()
  const xmlText = await (await fetch('/songs/luv-letter/score.musicxml')).text()
  const measures = (xmlText.match(/<measure number="/g) ?? []).length
  const wavy = (xmlText.match(/<wavy-line/g) ?? []).length
  const { loadSong } = await import('/src/songs/index.ts')
  const manifest = (await import('/src/songs/index.ts')).SONGS.find(s => s.id === 'luv-letter')
  const { timeline } = await loadSong(manifest)
  const mono = timeline.measureTimes.every((e, i, a) => i === 0 || e.time >= a[i - 1].time)
  return {
    beatsVersion: beats.version,
    anchorCount: beats.anchors.length,
    measures,
    wavy,
    measureTimes: timeline.measureTimes.length,
    notes: timeline.notes.length,
    monotonic: mono,
    firstT: timeline.measureTimes[0].time,
    m36T: timeline.measureTimes[45].time,
    m70T: timeline.measureTimes[91].time,
    lastT: timeline.measureTimes[96].time,
    durationSec: timeline.durationSec,
  }
})()`)
console.log('data:', JSON.stringify(data))

/* ---------- 2. 锚点光标：播放序 seq1/46/92/97 ---------- */
const SAMPLES = [
  [1, 0.2], [46, 122.8], [92, 245.85], [97, 258.0],
]
let pass = 0
for (const [seq, t] of SAMPLES) {
  await evalJs(`(async () => {
    const { audioEngine } = await import('/src/audio/AudioEngine.ts')
    audioEngine.seek(${t} + 0.5)
    return 1
  })()`)
  await sleep(900)
  const hud = await evalJs(`document.querySelector('.hud-stat .num')?.textContent ?? 'none'`)
  const ok = hud?.trim().startsWith(String(seq).padStart(2, '0'))
  if (ok) pass++
  console.log(`t=${(t + 0.5).toFixed(1)}s expect seq${seq}  hud="${hud?.trim()}"  ${ok ? 'OK' : 'FAIL'}`)
}
await shot('t76c0cbff-perform-m70')
console.log('---')
const dataOk = data.beatsVersion === 3 && data.anchorCount === 97 && data.measures === 72
  && data.wavy === 3 && data.measureTimes === 98 && data.monotonic
console.log('RESULT data(72 printed, wavy 3, expanded 98 monotonic, beats v3):', dataOk ? 'PASS' : 'FAIL')
console.log('RESULT anchor cursor alignment:', `${pass}/${SAMPLES.length}`, pass === SAMPLES.length ? 'PASS' : 'FAIL')
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(dataOk && pass === SAMPLES.length && consoleErrors.length === 0 ? 0 : 1)

// 诊断：seek 到末段后 HUD 为何 none（抓 URL / console 错误 / 引擎时间 / timeline 终点）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9243
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-diag-end'
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`(() => { const c = [...document.querySelectorAll('.song-card')].find(x => x.innerText.includes('Luv Letter')); c?.click(); return 1 })()`)
await sleep(2000)
await evalJs(`document.querySelector('[aria-label="开始演奏"]')?.click(); 1`)
await sleep(1500)
for (let i = 0; i < 20; i++) { const r = await evalJs(`document.querySelector('.ov-start') ? (document.querySelector('.ov-start').click(), 'go') : 'wait'`); if (r === 'go') break; await sleep(500) }
await sleep(5500)

// timeline 终点信息
const tlInfo = await evalJs(`(async () => {
  const m = (await import('/src/songs/index.ts')).SONGS.find(s => s.id === 'luv-letter')
  const { timeline } = await (await import('/src/songs/index.ts')).loadSong(m)
  const mt = timeline.measureTimes
  return { durationSec: timeline.durationSec, endMarker: mt[mt.length - 1], m73: mt[72] }
})()`)
console.log('timeline:', JSON.stringify(tlInfo))

for (const t of [250, 252, 254, 256]) {
  await evalJs(`(async () => { const { audioEngine } = await import('/src/audio/AudioEngine.ts'); audioEngine.seek(${t}); return 1 })()`)
  await sleep(700)
  const st = await evalJs(`(() => ({
    url: location.hash || location.pathname,
    hud: document.querySelector('.hud-stat .num')?.textContent ?? null,
    hudStat: !!document.querySelector('.hud-stat'),
    rootChildren: document.getElementById('root')?.children.length ?? 0,
  }))()`)
  const eng = await evalJs(`(async () => {
    const a = await import('/src/audio/AudioEngine.ts')
    const e = a.audioEngine
    return { time: e.time, playing: e.playing, dur: e.duration }
  })()`)
  console.log(`seek ${t} ->`, JSON.stringify(st), JSON.stringify(eng))
}
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 8)) : 'none')
child.kill()

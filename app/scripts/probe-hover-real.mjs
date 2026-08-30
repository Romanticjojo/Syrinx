// hover 真实性 probe：用 CDP Input.dispatchMouseEvent 走真实 hover 路径
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5175'
const CHROME_PORT = 9234
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-hover-profile`, '--window-size=1280,2000',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
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
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Page.enable')
const BASE = `http://localhost:${PORT}/`
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 3000))
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 2500))
// 找卡片中心坐标
const box = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.song-card')];
  const c = cards.find(x => x.innerText.includes('Luv Letter'));
  if (!c) return null
  const r = c.getBoundingClientRect()
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
})()`)
console.log('box:', box)
const { x, y } = JSON.parse(box)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
await new Promise(r => setTimeout(r, 250))
let v = await evalJs(`(() => { const v = document.querySelector('video.art-preview'); return v ? JSON.stringify({ mounted: true, paused: v.paused, t: v.currentTime }) : 'not mounted yet' })()`)
console.log('@250ms:', v)
await new Promise(r => setTimeout(r, 600))
v = await evalJs(`(() => { const v = document.querySelector('video.art-preview'); return v ? JSON.stringify({ mounted: true, paused: v.paused, t: v.currentTime, vis: getComputedStyle(v).visibility }) : 'not mounted' })()`)
console.log('@850ms:', v)
// 移出
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
await new Promise(r => setTimeout(r, 400))
v = await evalJs(`(() => { const v = document.querySelector('video.art-preview'); return v ? JSON.stringify({ kept: true, paused: v.paused, t: v.currentTime }) : 'removed' })()`)
console.log('after leave:', v)
child.kill()
process.exit(0)

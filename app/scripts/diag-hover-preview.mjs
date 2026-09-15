// 诊断：曲库卡片 hover 后视频预览是否真的播放了
// 用法：node scripts/diag-hover-preview.mjs 5173
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5173'
const CHROME_PORT = 9231
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-hover-diag'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' })

let version
for (let i = 0; i < 50; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) }
}
if (!version) { console.error('CDP not up'); child.kill(); process.exit(2) }
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value

await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await new Promise(r => setTimeout(r, 2500))
// 进应用（跳过 intro）
await evalJs(`localStorage.setItem('syrinx.introSeen','1')`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await new Promise(r => setTimeout(r, 2000))

// 找第一张卡片（Luv Letter，有视频）
const cardInfo = await evalJs(`(() => {
  const card = document.querySelector('.song-card')
  if (!card) return { err: 'no card' }
  const r = card.getBoundingClientRect()
  return { x: r.x + r.width/2, y: r.y + r.height/2, hasVideoSrc: !!card.querySelector('video') }
})()`)
console.log('card:', cardInfo)

// 模拟 hover
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardInfo.x, y: cardInfo.y })
await new Promise(r => setTimeout(r, 1600)) // 超过 500ms 预览延迟 + 淡入

const after = await evalJs(`(() => {
  const v = document.querySelector('.song-card video.art-preview')
  if (!v) return { video: false }
  return { video: true, src: v.src.slice(-30), readyState: v.readyState, paused: v.paused,
           t: v.currentTime, w: v.videoWidth, h: v.videoHeight, display: getComputedStyle(v).display, opacity: getComputedStyle(v).opacity }
})()`)
console.log('after hover:', JSON.stringify(after))
await new Promise(r => setTimeout(r, 1000))
const after2 = await evalJs(`(() => { const v = document.querySelector('.song-card video.art-preview'); return v ? { t: v.currentTime, paused: v.paused } : { gone: true } })()`)
console.log('1s later:', JSON.stringify(after2))
child.kill()
process.exit(0)

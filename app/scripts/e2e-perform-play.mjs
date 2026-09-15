// 演奏页播放验证：点「开始演奏」→ 倒计时 → 播放中检查 HUD 时间/小节前进、光标 svg、无控制台错误。
// 归档用：最终截图落 resources/luv-letter/score/。
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const CHROME_PORT = 9232
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-e2e-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1280,2000',
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
const shot = async (name, dir) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${dir}/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', name)
}

const ARCHIVE = 'D:/Syrinx/resources/luv-letter/score'

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 3000))
await evalJs(`(() => { localStorage.setItem('syrinx_skip_intro','1'); return 1 })()`)
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 2500))
// 首页 → Luv Letter 卡片 → 详情页 ▶
await evalJs(`(() => { const els = [...document.querySelectorAll('[class*=card],[class*=hero]')]; const b = els.find(x => x.innerText && x.innerText.includes('Luv Letter')); if (b) { b.click(); return 'ok' } return 'notfound' })()`)
await new Promise(r => setTimeout(r, 2000))
await evalJs(`(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find(x => /开始|演奏/i.test(x.innerText) || /开始|演奏/i.test(x.getAttribute('aria-label') ?? '')); if (b) { b.click(); return 'ok' } return 'notfound' })()`)
await new Promise(r => setTimeout(r, 6000))
// 演奏页：点大「开始演奏」浮层按钮触发倒计时+播放
const r0 = await evalJs(`(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find(x => /开始演奏/i.test(x.innerText) || /开始演奏/i.test(x.getAttribute('aria-label') ?? '')); if (b) { b.click(); return 'play-clicked' } return 'no-start-btn: ' + btns.map(x => x.innerText.trim().slice(0, 10)).join('|') })()`)
console.log('start:', r0)
// 等倒计时（4 拍）+ 前奏进入
await new Promise(r => setTimeout(r, 12000))
const s1 = await evalJs(`(() => { const t = document.body.innerText; return JSON.stringify({ hud: t.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g), measure: (t.match(/小节\\s*(\\d+\\s*\\/\\s*\\d+)/) || [])[1] || [...t.matchAll(/\\b(\\d{1,2})\\b/g)].length, cursorShown: !!document.querySelector('[class*=cursor]'), svg: document.querySelectorAll('svg').length }) })()`)
console.log('t+12s:', s1)
await shot('render-perform-t12', ARCHIVE)
await new Promise(r => setTimeout(r, 30000))
const s2 = await evalJs(`(() => { const t = document.body.innerText; return JSON.stringify({ hud: t.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g) }) })()`)
console.log('t+42s:', s2)
await shot('render-perform-t42', ARCHIVE)
// 中段 seek 稳定性：直接查 audio 元素时间
const audio = await evalJs(`(() => { const a = document.querySelector('audio'); return a ? JSON.stringify({ t: a.currentTime, dur: a.duration, paused: a.paused }) : 'no audio' })()`)
console.log('audio:', audio)
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 8)) : 'none')
child.kill()
process.exit(consoleErrors.length ? 1 : 0)

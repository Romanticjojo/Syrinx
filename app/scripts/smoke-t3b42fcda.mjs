// t_3b42fcda smoke: 曲库 hover 首次不播放修复 + 预览页 cover-note 删除验证
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const PORT = process.argv[2] || '5177'
const CHROME_PORT = 9232
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-t3b42fcda-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1280,2000',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
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
  writeFileSync(process.env.TEMP + `/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', process.env.TEMP + `/${name}.png`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
const BASE = `http://localhost:${PORT}/`
await send('Page.navigate', { url: BASE })
await sleep(3000)
await evalJs(`(() => { localStorage.setItem('syrinx_skip_intro','1'); return 1 })()`)
await send('Page.navigate', { url: BASE })
await sleep(2500)

// ---- 验证 1：单次 mouseenter（首次 hover）后视频播放 ----
// React 的 onMouseEnter 由 mouseover 委托合成，派发 mouseover 即可触发
const hover1 = await evalJs(`(() => {
  const card = [...document.querySelectorAll('.song-card')].find(x => x.innerText.includes('Luv Letter'))
    ?? document.querySelector('.song-card')
  if (!card) return 'no card'
  card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  return 'hovered: ' + card.querySelector('.t')?.textContent
})()`)
console.log('hover1:', hover1)
await sleep(4000) // 200ms 延迟 + 挂载 + 缓冲
const t1 = await evalJs(`(() => {
  const v = document.querySelector('.art-preview')
  return JSON.stringify(v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : 'no video')
})()`)
await sleep(1200)
const t2 = await evalJs(`(() => {
  const v = document.querySelector('.art-preview')
  return JSON.stringify(v ? { t: v.currentTime, paused: v.paused } : 'no video')
})()`)
console.log('first-hover t1:', t1, ' t2(+1.2s):', t2)
const firstOk = (() => { try { const a = JSON.parse(t1), b = JSON.parse(t2); return !a.paused && !b.paused && b.t > a.t } catch { return false } })()
console.log('CHECK1 首次 hover 即播放:', firstOk ? 'PASS' : 'FAIL')
await shot('t3b42fcda-first-hover')

// ---- 验证 2：mouseleave 暂停、二次 hover 立即续播（预热不销毁）----
await evalJs(`(() => {
  const card = document.querySelector('.song-card')
  card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  return 1
})()`)
await sleep(500)
const pausedState = await evalJs(`(() => {
  const v = document.querySelector('.art-preview')
  return JSON.stringify(v ? { exists: true, paused: v.paused } : 'removed')
})()`)
await evalJs(`(() => {
  const card = document.querySelector('.song-card')
  card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  return 1
})()`)
await sleep(400) // warmed → 延迟为 0
const reHover = await evalJs(`(() => {
  const v = document.querySelector('.art-preview')
  return JSON.stringify(v ? { paused: v.paused, visible: getComputedStyle(v).visibility } : 'no video')
})()`)
console.log('leave→paused:', pausedState, ' re-hover:', reHover)
const secondOk = pausedState.includes('"paused":true') && reHover.includes('"paused":false')
console.log('CHECK2 预热续播保留:', secondOk ? 'PASS' : 'FAIL')

// ---- 验证 3：预览页无 .cover-note 角标 ----
await evalJs(`(() => {
  const card = [...document.querySelectorAll('.song-card')].find(x => x.innerText.includes('Luv Letter'))
  card?.click(); return 1
})()`)
await sleep(2500)
const note = await evalJs(`(() => JSON.stringify({
  isPreview: !!document.querySelector('[aria-label="曲目信息"]'),
  coverNote: document.querySelectorAll('.cover-note').length,
}))()`)
console.log('preview cover-note check:', note)
const noteOk = JSON.parse(note).isPreview && JSON.parse(note).coverNote === 0
console.log('CHECK3 预览页无角标:', noteOk ? 'PASS' : 'FAIL')
await shot('t3b42fcda-preview')

console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(firstOk && secondOk && noteOk && consoleErrors.length === 0 ? 0 : 1)

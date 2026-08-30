// Bug 修复验收 e2e（任务 t_a857b79e）：
// 1) 演奏页播放 30s：背景视频 playing+可见、音符染色 SVG 出现、HUD 时间推进、无控制台错误
// 2) 曲库 hover 预览：200ms 后开播（video currentTime 增长），移出即暂停、元素保留（预热复用）
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const PORT = process.argv[2] || '5175'
const CHROME_PORT = 9233
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-bugfix-profile'
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
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(process.env.TEMP + `/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', process.env.TEMP + `/${name}.png`)
}

await send('Page.enable')
await send('Runtime.enable')
const BASE = `http://localhost:${PORT}/`
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 3000))
await evalJs(`(() => { localStorage.setItem('syrinx_skip_intro','1'); return 1 })()`)
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 2500))

// ---- Part A: 曲库 hover 预览（200ms 延迟 + 预热复用）----
const hover = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('[class*=card], a, button')];
  const c = cards.find(x => x.innerText.includes('Luv Letter'));
  if (!c) return 'no card'
  c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  return 'hovered: ' + c.className
})()`)
console.log('hover:', hover)
await new Promise(r => setTimeout(r, 700))
const prev1 = await evalJs(`(() => {
  const v = document.querySelector('video.art-preview')
  if (!v) return JSON.stringify({ video: false })
  return JSON.stringify({ video: true, paused: v.paused, t: v.currentTime, visible: getComputedStyle(v).visibility })
})()`)
console.log('preview@700ms:', prev1)
// 移出鼠标 → 暂停但元素保留
await evalJs(`(() => {
  const cards = [...document.querySelectorAll('[class*=card], a, button')];
  const c = cards.find(x => x.innerText.includes('Luv Letter'));
  if (c) c.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
  return 1
})()`)
await new Promise(r => setTimeout(r, 400))
const prev2 = await evalJs(`(() => {
  const v = document.querySelector('video.art-preview')
  if (!v) return JSON.stringify({ kept: false })
  return JSON.stringify({ kept: true, paused: v.paused, t: v.currentTime })
})()`)
console.log('preview after mouseleave:', prev2)
// 再次 hover：预热命中应立即播
await evalJs(`(() => {
  const cards = [...document.querySelectorAll('[class*=card], a, button')];
  const c = cards.find(x => x.innerText.includes('Luv Letter'));
  if (c) c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  return 1
})()`)
await new Promise(r => setTimeout(r, 300))
const prev3 = await evalJs(`(() => {
  const v = document.querySelector('video.art-preview')
  return v ? JSON.stringify({ replay: true, paused: v.paused, t: v.currentTime }) : 'no video'
})()`)
console.log('preview re-hover@300ms:', prev3)

// ---- Part B: 进入演奏页播放 30s ----
const card = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('[class*=card], a, button')];
  const c = cards.find(x => x.innerText.includes('Luv Letter'));
  if (c) { c.click(); return 'clicked' }
  return 'no luv card'
})()`)
console.log('card:', card)
await new Promise(r => setTimeout(r, 2500))
const play = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => (x.getAttribute('aria-label') || '').includes('开始演奏')) ||
    btns.find(x => x.innerText.includes('开始演奏'));
  if (b) { b.click(); return 'clicked' }
  return 'buttons: ' + btns.map(x => x.innerText.trim()).join('|')
})()`)
console.log('play:', play)
await new Promise(r => setTimeout(r, 5000))
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => (x.getAttribute('aria-label') || '').includes('开始演奏') || x.innerText.includes('开始演奏'));
  if (b) { b.click(); return 'start clicked' }
  return 'no start btn'
})()`)
await new Promise(r => setTimeout(r, 8000))

// 播放中状态快照 1（约 13s 处）
const st1 = await evalJs(`(() => {
  const bv = document.querySelector('video.perform-bg')
  const colored = document.querySelectorAll('.sheet-container svg [fill\\:=""] , .sheet-container svg g[fill]')
  // 音符染色检查：accent 色 #5fb8a8 的元素
  const accentEls = [...document.querySelectorAll('.sheet-container svg *')].filter(e => {
    const f = e.getAttribute && e.getAttribute('fill')
    return f && f.toLowerCase() === '#5fb8a8'
  })
  const times = (document.body.innerText.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g) || [])
  return JSON.stringify({
    bgVideo: bv ? { paused: bv.paused, t: +bv.currentTime.toFixed(1), visible: getComputedStyle(bv).display !== 'none' && getComputedStyle(bv).visibility !== 'hidden', w: bv.videoWidth } : null,
    accentNotes: accentEls.length,
    times,
  })
})()`)
console.log('perform@13s:', st1)
await shot('bugfix-perform-13s')

await new Promise(r => setTimeout(r, 15000))
const st2 = await evalJs(`(() => {
  const bv = document.querySelector('video.perform-bg')
  const accentEls = [...document.querySelectorAll('.sheet-container svg *')].filter(e => {
    const f = e.getAttribute && e.getAttribute('fill')
    return f && f.toLowerCase() === '#5fb8a8'
  })
  const times = (document.body.innerText.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g) || [])
  return JSON.stringify({
    bgVideo: bv ? { paused: bv.paused, t: +bv.currentTime.toFixed(1), visible: getComputedStyle(bv).display !== 'none' && getComputedStyle(bv).visibility !== 'hidden' } : null,
    accentNotes: accentEls.length,
    times,
  })
})()`)
console.log('perform@28s:', st2)
await shot('bugfix-perform-28s')

console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(consoleErrors.length ? 1 : 0)

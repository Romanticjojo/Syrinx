// 检查演奏页 OSMD 渲染：svg 数量、小节号顺序、光标位置
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const VITE_PORT = '5199'
const CHROME_PORT = 9243
const chromeExe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const child = spawn(chromeExe, [`--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-render-live`, '--window-size=1440,1000',
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 50; i++) { try { await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0; const pending = new Map()
ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`document.querySelector('.home-hero')?.click(); 1`)
await sleep(2000)
await evalJs(`document.querySelector('[aria-label="开始演奏"], .btn-play-big')?.click(); 1`)
await sleep(2000)
await evalJs(`[...document.querySelectorAll('button')].find(x => x.innerText.includes('开始演奏'))?.click(); 1`)
await sleep(8000)

const info = await evalJs(`(() => {
  try {
    const c = document.querySelector('.sheet-container')
    if (!c) return 'no container'
    const svgs = c.querySelectorAll('svg')
    const nums = [...c.querySelectorAll('svg text')].map(t => t.textContent).filter(t => /^\\d+$/.test(t.trim()))
    const scroll = { top: c.scrollTop, sh: c.scrollHeight, ch: c.clientHeight }
    return JSON.stringify({ svgCount: svgs.length, firstNums: nums.slice(0, 12), lastNums: nums.slice(-6), scroll, win: window.scrollY, href: location.href })
  } catch (e) { return 'ERR ' + e.message }
})()`)
console.log('container:', info)
const rawHref = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
console.log('raw href:', JSON.stringify(rawHref).slice(0, 500))
const perf = await evalJs(`(() => {
  const c = document.querySelector('.sheet-container svg')
  const r = c?.getBoundingClientRect()
  const win = document.querySelector('.perform')
  return JSON.stringify({ svgRect: r ? { top: r.top, height: r.height } : null, winScroll: win?.scrollTop, docScroll: document.documentElement.scrollTop, bodyH: document.body.scrollHeight, vh: window.innerHeight })
})()`)
console.log('geom:', perf)
// 起奏后看光标是否推进：容器 scrollTop 应随光标 scrollIntoView 增长
await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('开始演奏'))
  b?.click(); return 1
})()`)
await sleep(9000)
const probe1 = await evalJs(`(() => {
  const c = document.querySelector('.sheet-container')
  const lit = [...document.querySelectorAll('[fill="#5fb8a8"]')].map(e => e.tagName + '.' + (e.getAttribute('class') ?? ''))
  return JSON.stringify({ scrollTop: c?.scrollTop, hud: [...document.querySelectorAll('.hud-stat .num')].map(e => e.textContent), lit: lit.slice(0, 6) })
})()`)
console.log('probe1:', probe1)
await sleep(8000)
const probe2 = await evalJs(`(() => {
  const c = document.querySelector('.sheet-container')
  return JSON.stringify({ scrollTop: c?.scrollTop, hud: [...document.querySelectorAll('.hud-stat .num')].map(e => e.textContent) })
})()`)
console.log('probe2:', probe2)
child.kill(); process.exit(0)

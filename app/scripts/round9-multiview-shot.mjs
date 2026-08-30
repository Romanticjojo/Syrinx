// 第八轮反馈（2026-08-31）多视口截图验证：
// ① 曲库页头 logo 小图 + 仅「Syrinx」文字；② 页脚/关于入口已删除；③ 演奏页背景视频 contain + 青绿底
// 用法: node scripts/round9-multiview-shot.mjs [vite端口]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9234
const OUT = 'D:/Syrinx/docs/screenshots'
mkdirSync(OUT, { recursive: true })
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-round9-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1280,800',
  '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', 'about:blank',
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
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', `${OUT}/${name}.png`)
}
const setViewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 })
  await new Promise(r => setTimeout(r, 600))
}
const clickBtn = async pred => evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = ${pred};
  if (b) { b.click(); return 'ok' }
  return 'no btn'
})()`)

await send('Page.enable')
await send('Runtime.enable')
const BASE = `http://localhost:${PORT}/`
// 跳过 Intro，直达曲库
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 3000))
await evalJs(`(() => { localStorage.setItem('syrinx_skip_intro','1'); return 1 })()`)
await send('Page.navigate', { url: BASE })
await new Promise(r => setTimeout(r, 2500))

for (const [w, h, tag] of [[1280, 800, 'desktop'], [800, 600, 'half'], [390, 844, 'phone']]) {
  await setViewport(w, h)
  await send('Page.navigate', { url: BASE })
  await new Promise(r => setTimeout(r, 2500))
  // —— 曲库页：logo 图 + 文案 + 页脚/关于入口检查
  const home = await evalJs(`(() => {
    const logo = document.querySelector('.home-logo')
    const img = logo?.querySelector('img')
    const cs = img ? getComputedStyle(img) : null
    return JSON.stringify({
      logoText: logo?.textContent?.trim(),
      logoImg: cs ? { w: cs.width, h: cs.height, radius: cs.borderRadius } : null,
      footerGone: !document.querySelector('.home-footer'),
      aboutBtnGone: ![...document.querySelectorAll('button')].some(b => b.textContent.includes('关于')),
    })
  })()`)
  console.log(`[${tag} ${w}x${h}] home:`, home)
  await shot(`round9-home-${tag}-${w}x${h}`)

  // —— 进演奏页：点卡片 → 开始演奏 → 点掉 ready 浮层 → 倒数后进入演奏，视频无遮挡时截图
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('[class*=card], a, button')];
    const c = cards.find(x => x.innerText.includes('Luv Letter'));
    if (c) { c.click(); return 'ok' }
    return 'no card'
  })()`)
  await new Promise(r => setTimeout(r, 2500))
  await clickBtn(`btns.find(x => (x.getAttribute('aria-label') || '').includes('开始演奏')) || btns.find(x => x.innerText.includes('开始演奏'))`)
  await new Promise(r => setTimeout(r, 5000))
  await clickBtn(`btns.find(x => (x.getAttribute('aria-label') || '').includes('开始演奏')) || btns.find(x => x.innerText.includes('开始演奏'))`)
  // 4 拍倒数 ≈3s，取 4.5s 后：已进入演奏、HUD 尚未完全淡出
  await new Promise(r => setTimeout(r, 4500))
  const perf = await evalJs(`(() => {
    const v = document.querySelector('video.perform-bg')
    if (!v) return 'no video.perform-bg'
    const cs = getComputedStyle(v)
    return JSON.stringify({ fit: cs.objectFit, bg: cs.backgroundColor, readyState: v.readyState, videoW: v.videoWidth, videoH: v.videoHeight, paused: v.paused })
  })()`)
  console.log(`[${tag}] perform video:`, perf)
  await shot(`round9-perform-${tag}-${w}x${h}`)
}

child.kill()
process.exit(0)

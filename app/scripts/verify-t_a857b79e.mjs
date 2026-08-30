// 验证 t_a857b79e 四项修复（dev 服 + CDP 实测）：
//   1. 曲库 hover 预览：200ms 延迟开播；mouseleave 暂停保活不卸载；再 hover 直接续播
//   2. 演奏页背景视频：playing 且可见（不被面板压没）
//   3. 音符变色：谱面上出现 accent 色符头，且随播放前进移动
//   4. HUD 时间轴：总时长 4:29，随播放推进
// 用法：先起 dev（npx vite --port 5199），再 node scripts/verify-t_a857b79e.mjs
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9240
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-ta857'
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

/* ---------- 1. 曲库 hover 预览 ---------- */
const card = await evalJs(`(() => {
  const c = document.querySelector('.song-card')
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
console.log('card:', JSON.stringify(card))
// hover 后 ~250ms 采样：应已（或即将）开播（新延迟 200ms）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y })
await sleep(250)
const early = await evalJs(`(() => {
  const v = document.querySelector('.song-card video.art-preview')
  return v ? { mounted: true, paused: v.paused, t: v.currentTime } : { mounted: false }
})()`)
await sleep(1000)
const h1 = await evalJs(`(() => {
  const v = document.querySelector('.song-card video.art-preview')
  if (!v) return { mounted: false }
  v.dataset.probe = 'warmed'
  return { mounted: true, paused: v.paused, t: v.currentTime, rs: v.readyState }
})()`)
console.log('hover: early(250ms)=', JSON.stringify(early), ' after1.25s=', JSON.stringify(h1))

// 移开鼠标：暂停但保留（预热）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: 40 })
await sleep(500)
const away = await evalJs(`(() => {
  const v = document.querySelector('.song-card video.art-preview')
  if (!v) return { mounted: false }
  return { mounted: true, kept: v.dataset.probe === 'warmed', paused: v.paused, t: v.currentTime }
})()`)
console.log('mouseleave:', JSON.stringify(away))

// 再 hover：直接续播（同一元素，不重新拉流）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y })
await sleep(150)
const back = await evalJs(`(() => {
  const v = document.querySelector('.song-card video.art-preview')
  if (!v) return { mounted: false }
  return { sameEl: v.dataset.probe === 'warmed', paused: v.paused, t: v.currentTime }
})()`)
console.log('re-hover(+150ms):', JSON.stringify(back))

/* ---------- 2/3/4. 演奏页 ---------- */
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: 40 }) // 先移开 hover
await evalJs(`document.querySelector('.home-hero')?.click(); 1`)
await sleep(2500)
const toPerform = await evalJs(`(() => {
  const b = document.querySelector('[aria-label="开始演奏"], .btn-play-big')
  if (b) { b.click(); return 'preview-clicked' }
  return 'not-found'
})()`)
await sleep(2000)
const play = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('开始演奏'))
  if (b) { b.click(); return 'perform-ready' }
  return 'not-found'
})()`)
console.log('start:', toPerform, play)
// 4 拍倒数（90bpm ≈ 2.67s）+ 启动余量
await sleep(5000)

const samples = []
for (let k = 0; k < 6; k++) {
  const s = await evalJs(`(() => {
    const v = document.querySelector('video.perform-bg')
    const hud = [...document.querySelectorAll('.hud-stat .num')].map(e => e.textContent)
    // accent 色符头：OSMD setColor 直接写 fill 属性
    const lit = document.querySelectorAll('[fill="#5fb8a8"]').length
    // 视频可见性：元素有尺寸且在视口内；面板半透（0.45）所以谱面区也能透出视频
    const corner = document.elementFromPoint(6, 400)
    let vis = 'unknown'
    if (v) {
      const cs = getComputedStyle(v)
      const r = v.getBoundingClientRect()
      vis = { display: cs.display, opacity: cs.opacity, w: r.width, h: r.height,
              inView: r.top < innerHeight && r.bottom > 0 && r.width > 100 }
    }
    return {
      video: v ? { paused: v.paused, t: +v.currentTime.toFixed(2), vis } : null,
      hud,
      litHeads: lit,
      measure: hud[0],
      corner: corner ? corner.className?.toString?.().slice(0, 40) ?? corner.tagName : null,
    }
  })()`)
  samples.push(s)
  console.log(`t+${k * 6}s:`, JSON.stringify(s))
  if (k === 1) await shot('verify-ta857-performing')
  if (k < 5) await sleep(6000)
}

// 变色符头应随播放移动：至少两个采样点的 litHeads > 0，且期间 HUD 时间在推进
const litOk = samples.filter(s => s.litHeads > 0).length
const times = samples.map(s => s.measure ?? '')
const timeAdvancing = new Set(samples.map(s => s.hud[1])).size > 1
const measureAdvancing = new Set(times).size > 1
const videoOk = samples.every(s => s.video && !s.video.paused && s.video.vis.display === 'block' && s.video.vis.inView)
console.log('---')
console.log('RESULT video playing+visible:', videoOk)
console.log('RESULT note coloring active:', litOk >= 3, `(${litOk}/6 samples lit)`)
console.log('RESULT hud time advancing:', timeAdvancing, samples.map(s => s.hud[1]).join(' → '))
console.log('RESULT measure hud advancing:', measureAdvancing, times.join(' → '))
console.log('RESULT hud total (expect 4:29):', samples[0]?.hud[1]?.split('/')[1]?.trim())
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(videoOk && litOk >= 3 && timeAdvancing && measureAdvancing ? 0 : 1)

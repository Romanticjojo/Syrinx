// 验证 t_b22f5467 项 2/4（dev 服 + CDP 实测）：
//   项 2：起奏 toast「录音已开启」；手动关录音 toast「录音已关闭」
//   项 4：进度轨点击/拖拽 seek（含回退）、点谱面小节跳转、seek 后 Take 重开 toast
// 用法：node scripts/verify-t_b22f5467.mjs [port]
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9246
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-b22'
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
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// 快照 HUD/toast/时间
const snap = () => evalJs(`(() => {
  const hud = [...document.querySelectorAll('.hud-stat .num')].map(e => e.textContent)
  const toast = document.querySelector('.perform-toast')?.textContent ?? null
  const played = document.querySelector('.progress-rail .played')?.style.width ?? null
  return { hud, toast, played }
})()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`document.querySelector('.home-hero')?.click(); 1`)
await sleep(2500)
const nav1 = await evalJs(`(() => { const b = document.querySelector('[aria-label="开始演奏"], .btn-play-big'); if (b) { b.click(); return 'ok' } return 'miss' })()`)
await sleep(2000)
const nav2 = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('开始演奏')); if (b) { b.click(); return 'ok' } return 'miss' })()`)
console.log('nav:', nav1, nav2)

// 倒数 ~2.67s（90bpm 4 拍）后 toast 应出现（3s 内采样）
await sleep(3000)
const s0 = await snap()
console.log('起奏后 3s:', JSON.stringify(s0))
await shot('verify-b22-rec-toast')

// 等 toast 消失 + 播到 ~8s
await sleep(6000)
const before = await snap()
console.log('seek 前:', JSON.stringify(before))

// ---- 项 4a：进度轨点击 50% → 前跳 ----
const rail = await evalJs(`(() => { const r = document.querySelector('.progress-rail').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x + rail.w * 0.5, y: rail.y + 8, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x + rail.w * 0.5, y: rail.y + 8, button: 'left', clickCount: 1 })
await sleep(800)
const afterSeek = await snap()
console.log('点击 50% 后:', JSON.stringify(afterSeek))

// ---- 项 4b：回退 —— 点击 20%（光标应 reset 快进回退，小节号变小） ----
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x + rail.w * 0.2, y: rail.y + 8, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x + rail.w * 0.2, y: rail.y + 8, button: 'left', clickCount: 1 })
await sleep(800)
const afterBack = await snap()
console.log('点击 20% 后(回退):', JSON.stringify(afterBack))

// ---- 项 4c：拖拽 20% → 60% ----
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x + rail.w * 0.2, y: rail.y + 8, button: 'left', clickCount: 1 })
for (let k = 1; k <= 5; k++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x + rail.w * (0.2 + k * 0.08), y: rail.y + 8 })
  await sleep(60)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x + rail.w * 0.6, y: rail.y + 8, button: 'left' })
await sleep(800)
const afterDrag = await snap()
console.log('拖拽到 60% 后:', JSON.stringify(afterDrag))
await shot('verify-b22-after-drag')

// ---- 项 4d：点谱面小节跳转（谱面第 10 行区域 ≈ m10） ----
// 每 system 一小节：谱面 y 均匀分布，点谱面中间偏上某行
const sheetPt = await evalJs(`(() => {
  const c = document.querySelector('.sheet-container')
  const r = c.getBoundingClientRect()
  const scrollable = c.scrollHeight - c.clientHeight
  // 点第 10 小节行：先滚回顶部，62 行均匀分布
  c.scrollTop = 0
  const y = r.top + Math.min(r.height, 260)
  const x = r.left + r.width / 2
  return { x, y }
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sheetPt.x, y: sheetPt.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sheetPt.x, y: sheetPt.y, button: 'left', clickCount: 1 })
await sleep(800)
const afterMeasure = await snap()
console.log('点谱面后:', JSON.stringify(afterMeasure))
await shot('verify-b22-after-measure-click')

// ---- 项 2b：手动关录音 → toast「录音已关闭」；随后 seek 不再报「重新录音」 ----
await evalJs(`(() => { const b = document.querySelector('[aria-label="录音"]') || [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('录音') || x.title?.includes('录音')); if (b) b.click(); return 1 })()`)
await sleep(300)
const afterRecOff = await snap()
console.log('关录音后:', JSON.stringify(afterRecOff))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x + rail.w * 0.3, y: rail.y + 8, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x + rail.w * 0.3, y: rail.y + 8, button: 'left', clickCount: 1 })
await sleep(300)
const afterSeekNoRec = await snap()
console.log('关录音后 seek(应无重新录音 toast):', JSON.stringify(afterSeekNoRec))

// ---- 断言 ----
const t0 = s0.toast ?? ''
const timeOf = s => s.hud[1]?.split(' / ')[0] ?? ''
const results = {
  '项2 起奏录音 toast': t0.includes('录音已开启'),
  '项2 关录音 toast': (afterRecOff.toast ?? '').includes('录音已关闭'),
  '项4 点击50% 前跳生效': timeOf(afterSeek) !== timeOf(before) && afterSeek.played !== before.played,
  '项4 回退生效(20%<50%)': timeOf(afterBack) < timeOf(afterSeek),
  '项4 拖拽生效(~60%)': timeOf(afterDrag) > timeOf(afterBack),
  '项4 点小节跳转生效': afterMeasure.hud[0] !== '-- / --' && timeOf(afterMeasure) !== timeOf(afterDrag),
  '项4 关录音后 seek 无重录 toast': !(afterSeekNoRec.toast ?? '').includes('重新录音'),
  'HUD 小节显示': !before.hud[0]?.includes('--'),
}
console.log('---')
let pass = true
for (const [k, v] of Object.entries(results)) { console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); if (!v) pass = false }
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : 'none')
child.kill()
process.exit(pass && consoleErrors.length === 0 ? 0 : 1)

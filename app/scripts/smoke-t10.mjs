// 冒烟自测（任务 t_10df852f）：首页/曲库/预览/演奏/回放页无白屏。
// 依赖：本机 Chrome/Edge headless + CDP；先手动启动 `npm run dev`。
// 用法：node scripts/smoke-t10.mjs [port]

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5173'
const CHROME_PORT = 9229
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-smoke-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
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
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(String(msg.params?.exceptionDetails?.text))
}
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const wait = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')

const check = async (label, expr) => {
  const v = await evalJs(expr)
  const ok = v === true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' → ' + JSON.stringify(v)}`)
  if (!ok) process.exitCode = 1
}

// —— 首页 ——
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await wait(4000)
await check('首页 root 有内容', `document.querySelector('#root')?.children.length > 0`)
await check('首页无 vite 错误浮层', `!document.querySelector('vite-error-overlay')`)
await check('首页无白屏（有文字）', `(document.body.innerText || '').length > 40`)

// —— 进曲库卡片 → 预览页 ——
await evalJs(`document.querySelector('.song-card, [class*=card]')?.click()`)
await wait(2500)
await check('预览页有内容', `(document.body.innerText || '').includes('演奏') || (document.body.innerText || '').length > 40`)
await check('预览页无 vite 错误浮层', `!document.querySelector('vite-error-overlay')`)

// —— 点开始演奏 → 演奏页 ——
await evalJs(`document.querySelector('.btn-play-big')?.click()`)
await wait(3500)
await check('演奏页挂载', `!!document.querySelector('.perform')`)
await check('演奏页无 vite 错误浮层', `!document.querySelector('vite-error-overlay')`)
await check('演奏页有控制条', `!!document.querySelector('.control-bar')`)
await check('演奏页有录音开关按钮', `!!document.querySelector('.ctl.rec')`)
await check('演奏页有实时音准表组件', `!!document.querySelector('.pitch-meter')`)
await check('演奏页有开始浮层', `(document.body.innerText || '').includes('开始演奏')`)

// —— 点开始（倒数 → 演奏态；fake mic/autoplay 已放开） ——
await evalJs(`document.querySelector('.ov-start')?.click()`)
await wait(6000)
await check('进入演奏态（无倒数浮层）', `!document.querySelector('.countdown')`)
await check('录音开关默认开启', `document.querySelector('.ctl.rec')?.classList.contains('on') === true`)

// —— 暂停/恢复 ——
await evalJs(`document.querySelector('.ctl.main')?.click()`)
await wait(400)
await evalJs(`document.querySelector('.ctl.main')?.click()`)
await wait(400)
await check('暂停/恢复后仍在演奏态', `!!document.querySelector('.perform')`)

// —— Esc 退出 → 预览 ——
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }))`)
await wait(1500)
console.log(`${errors.length === 0 ? 'PASS' : 'FAIL'} 无运行时异常`)
if (errors.length) process.exitCode = 1

console.log('runtime errors:', errors.length ? errors : 'none')
child.kill()
process.exit(process.exitCode || 0)

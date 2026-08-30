// Enter perform page directly via app store, verify cursor walk + real mp3
// timeline. The app's store is module scoped; simulate click on the big play
// button (the ▶) which navigates to perform.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const CHROME_PORT = 9230
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-perf-profile2'
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
  writeFileSync(`D:/Syrinx/resources/luv-letter/score/omr-work/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', name)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 3000))

// home -> click hero -> preview -> click ▶ (the play button)
await evalJs(`(() => { localStorage.setItem('syrinx_skip_intro','1'); return 1 })()`)
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 2500))
await evalJs(`document.querySelector('.home-hero, [class*=hero]')?.click()`)
await new Promise(r => setTimeout(r, 2000))
const play = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => x.innerText.includes('开始演奏'));
  if (b) { b.click(); return 'clicked' }
  return 'buttons: ' + btns.map(x => x.innerText.trim()).join('|')
})()`)
console.log('play:', play)
await new Promise(r => setTimeout(r, 5000))
console.log('view check:', (await evalJs('location.href')) )
const state1 = await evalJs(`(() => {
  const t = document.body.innerText;
  const times = t.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g) || t.match(/\\d{1,2}:\\d{2}/g) || [];
  return JSON.stringify({ times, hasSvg: document.querySelectorAll('svg').length, text: t.slice(0, 120).replace(/\\n/g, '|') })
})()`)
console.log('perform state:', state1)
await shot('perf-0')

// wait 15s and compare HUD
await new Promise(r => setTimeout(r, 15000))
const state2 = await evalJs(`(() => {
  const t = document.body.innerText;
  const times = t.match(/\\d{1,2}:\\d{2}\\s*\\/\\s*\\d{1,2}:\\d{2}/g) || t.match(/\\d{1,2}:\\d{2}/g) || [];
  return JSON.stringify({ times })
})()`)
console.log('perform +15s:', state2)
await shot('perf-15s')

// audio probe
const audio = await evalJs(`(() => {
  const a = document.querySelector('audio, video');
  if (!a) return 'no media el'
  return JSON.stringify({ tag: a.tagName, src: (a.currentSrc||a.src||'').split('/').slice(-2).join('/'), t: a.currentTime, dur: a.duration, ready: a.readyState, paused: a.paused })
})()`)
console.log('media:', audio)

console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 6)) : 'none')
child.kill()
process.exit(0)

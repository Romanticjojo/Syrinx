// Drive the real app: home -> click into luv-letter preview -> perform page.
// Screenshot each stage; verify OSMD svg renders the real score; verify no
// console errors; check cursor walk & timeline HUD advance.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const CHROME_PORT = 9229
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
  writeFileSync(`D:/Syrinx/resources/luv-letter/score/omr-work/${name}.png`, Buffer.from(s.result.data, 'base64'))
  console.log('shot:', name)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 3500))

// skip intro if present
await evalJs(`(() => { const b = document.querySelector('button'); localStorage.setItem('syrinx_skip_intro','1'); return document.body.innerText.slice(0, 80) })()`)
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 2500))
console.log('home text:', (await evalJs('document.body.innerText.slice(0,150)'))?.replace(/\n/g, ' | '))

// find luv letter card and click
const clicked = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('[class*=card],[class*=hero]')];
  const target = cards.find(c => c.innerText && c.innerText.includes('Luv Letter'));
  if (target) { target.click(); return target.className }
  return 'NOT_FOUND: ' + cards.length
})()`)
console.log('clicked:', clicked)
await new Promise(r => setTimeout(r, 2500))
console.log('preview text:', (await evalJs('document.body.innerText.slice(0,200)'))?.replace(/\n/g, ' | '))
await shot('e2e-preview')

// find start button on preview page
const startBtn = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => /开始|演奏|start/i.test(x.innerText) || /开始|演奏|start/i.test(x.getAttribute('aria-label') ?? ''));
  if (b) { b.click(); return b.innerText }
  return 'NO_START: ' + btns.map(x => x.innerText).join(',')
})()`)
console.log('start:', startBtn)
await new Promise(r => setTimeout(r, 4000))
console.log('perform text:', (await evalJs('document.body.innerText.slice(0,200)'))?.replace(/\n/g, ' | '))
const svgInfo = await evalJs(`(() => {
  const svg = document.querySelectorAll('svg');
  const notes = document.querySelectorAll('svg [class*=note], svg .vf-notehead');
  return JSON.stringify({ svgCount: svg.length, noteish: notes.length })
})()`)
console.log('score svg:', svgInfo)
await shot('e2e-perform')

// wait to observe cursor/timeline progress
await new Promise(r => setTimeout(r, 8000))
const hud = await evalJs(`(() => {
  const t = document.body.innerText;
  const m = t.match(/\\d{1,2}:\\d{2}/g);
  return JSON.stringify({ times: m, hasProgress: !!document.querySelector('[class*=progress]') })
})()`)
console.log('hud:', hud)
await shot('e2e-perform-later')

console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 8), null, 1) : 'none')
child.kill()
process.exit(consoleErrors.length ? 1 : 0)

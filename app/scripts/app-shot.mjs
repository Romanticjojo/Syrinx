// Screenshot the REAL app render page (OSMD) with merged score served by Vite.
// Steps: copy merged xml into app public, open /#/render-test? Simplest: use the
// preview page route that renders luv-letter score. We instead load the app's
// own preview page and screenshot the OSMD svg.
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const CHROME_PORT = 9227
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/osmd-app-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1280,2400', 'about:blank',
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

await send('Page.enable')
await send('Page.navigate', { url: 'http://localhost:5199/' })
await new Promise(r => setTimeout(r, 3000))
console.log('title:', await evalJs('document.title'))
console.log('url:', await evalJs('location.href'))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('D:/Syrinx/resources/luv-letter/score/omr-work/app-home.png', Buffer.from(shot.result.data, 'base64'))
console.log('screenshot saved: app-home.png')
child.kill()
process.exit(0)

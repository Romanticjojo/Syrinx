// Minimal CDP driver: launch real Chrome headless, load render page, wait title, screenshot.
// No playwright dependency - raw CDP over websocket using Node built-in fetch/WebSocket.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = 'D:/Syrinx/resources/luv-letter/score/omr-work'
const OSMD_JS = 'D:/Syrinx/app/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js'
const PORT = 8792
const CHROME_PORT = 9223

// prepare render.html + xml copy
let html = readFileSync(join(ROOT, 'render.html'), 'utf-8')
if (!html.includes('/osmd.js')) {
  html = html.replace('https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.4/build/opensheetmusicdisplay.min.js', '/osmd.js')
}
if (!html.includes("/fetch('/score-merged.xml')")) {
  html = html.replace(/fetch\('[^']+'\)/, "fetch('/score-merged.xml')")
}
writeFileSync(join(ROOT, 'render.html'), html)
copyFileSync(join(ROOT, 'luv-letter-merged.musicxml'), join(ROOT, 'score-merged.xml'))

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.xml': 'application/xml', '.png': 'image/png' }
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/render.html'
  if (p === '/osmd.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(readFileSync(OSMD_JS))
    return
  }
  const file = join(ROOT, p)
  if (existsSync(file)) {
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  } else { res.writeHead(404); res.end('nope') }
})
await new Promise(r => server.listen(PORT, r))

let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]) {
  if (existsSync(c)) { chrome = c; break }
}
if (!chrome) { console.error('NO CHROME FOUND'); process.exit(2) }
console.log('chrome:', chrome)

const prof = process.env.TEMP + '/osmd-check-profile'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  `--user-data-dir=${prof}`, '--window-size=1400,1900', 'about:blank',
], { stdio: 'ignore' })

// wait for CDP
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
function send(method, params = {}) {
  return new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
}

await send('Page.enable')
await send('Runtime.enable')
const errors = []
// collect console errors via Runtime.consoleAPICalled type=error & exceptionThrown
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
// surface page errors — attach BEFORE any script runs
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push(e.message + ' @' + (e.filename||'') + ':' + e.lineno));
  window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason)));
` })
// poll title
let title = ''
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 500))
  title = (await evalJs('document.title')) ?? ''
  const osmdLoaded = await evalJs("typeof OpenSheetMusicDisplay !== 'undefined'")
  if (i % 10 === 0) console.log(`poll ${i}: title="${title}" osmdLoaded=${osmdLoaded}`)
  if (title.startsWith('RENDER_OK') || title.startsWith('RENDER_ERR')) break
}
const errs = (await evalJs('JSON.stringify(window.__errs || [])')) ?? '[]'
console.log('PAGE ERRORS:', errs)
console.log('RESULT:', title)
if (title.startsWith('RENDER_OK')) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(ROOT + '/render-preview.png', Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot: render-preview.png')
}
child.kill()
server.close()
process.exit(title.startsWith('RENDER_OK') ? 0 : 1)

// Render luv-letter merged MusicXML with real Chromium via Vite preview + OSMD.
// Serves the omr-work dir statically, loads OSMD from app node_modules, screenshots result.
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = 'D:/Syrinx/resources/luv-letter/score/omr-work'
const OSMD_JS = 'D:/Syrinx/app/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js'

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.xml': 'application/xml', '.musicxml': 'application/xml', '.png': 'image/png' }
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
  } else {
    res.writeHead(404); res.end('nope')
  }
})

// patch render.html to use /osmd.js + fetch relative xml
let html = readFileSync(join(ROOT, 'render.html'), 'utf-8')
html = html.replace('https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.4/build/opensheetmusicdisplay.min.js', '/osmd.js')
html = html.replace("fetch('file:///D:/Syrinx/resources/luv-letter/score/omr-work/score-merged.xml')", "fetch('/score-merged.xml')")
import { writeFileSync } from 'node:fs'
writeFileSync(join(ROOT, 'render.html'), html)
// refresh the xml copy
import { copyFileSync } from 'node:fs'
copyFileSync(join(ROOT, 'luv-letter-merged.musicxml'), join(ROOT, 'score-merged.xml'))

await new Promise(r => server.listen(8791, r))

// find chrome
const { execSync } = await import('node:child_process')
let chromePath
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]) {
  if (existsSync(c)) { chromePath = c; break }
}
console.log('chrome:', chromePath)

const browser = await chromium.launch({ executablePath: chromePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } })
page.on('pageerror', e => console.log('PAGEERROR:', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()) })
await page.goto('http://localhost:8791/')
await page.waitForFunction(() => document.title.startsWith('RENDER_OK') || document.title.startsWith('RENDER_ERR'), { timeout: 60000 })
const title = await page.title()
console.log('RESULT:', title)
if (title.startsWith('RENDER_OK')) {
  await page.screenshot({ path: ROOT + '/render-preview.png', fullPage: true })
  console.log('screenshot: render-preview.png')
}
await browser.close()
server.close()
process.exit(title.startsWith('RENDER_OK') ? 0 : 1)

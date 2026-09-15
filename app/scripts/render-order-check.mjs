// 隔离渲染检查：OSMD 绘制的小节顺序 vs XML 文档顺序
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'

const ROOT = 'D:/Syrinx/resources/luv-letter/score/omr-work'
const OSMD_JS = 'D:/Syrinx/app/node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js'
const PORT = 8793
const CHROME_PORT = 9241

copyFileSync('D:/Syrinx/app/public/songs/luv-letter/score.musicxml', join(ROOT, 'score-clean.xml'))
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/osmd.js"></script>
<style>body{margin:0} #c{width:1200px}</style></head><body><div id="c"></div>
<script>
const osmd = new OpenSheetMusicDisplay(document.getElementById('c'), { backend: 'svg' });
fetch('/score-clean.xml').then(r => r.text()).then(t => osmd.load(t)).then(() => {
  osmd.render();
  // 收集 SVG 中按文档序出现的谱面小节号文本（OSMD measure number 标签）
  const nums = [...document.querySelectorAll('svg text')].map(t => t.textContent).filter(t => /^\\d+$/.test(t));
  document.title = 'OK:' + nums.join(',');
}).catch(e => { document.title = 'ERR:' + e.message })
</script></body></html>`
writeFileSync(join(ROOT, 'render-order.html'), html)

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.xml': 'application/xml' }
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/osmd.js') { res.writeHead(200, { 'content-type': mime['.js'] }); res.end(readFileSync(OSMD_JS)); return }
  const f = join(ROOT, p === '/' ? '/render-order.html' : p)
  if (existsSync(f)) { res.writeHead(200, { 'content-type': mime[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f)) }
  else { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(PORT, r))

const chromeExe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const child = spawn(chromeExe, [`--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-order-check`, '--window-size=1300,3000', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 50; i++) { try { await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) } }
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0; const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
let title = ''
for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); title = (await evalJs('document.title')) ?? ''; if (title.startsWith('OK') || title.startsWith('ERR')) break }
const nums = title.slice(3).split(',').map(Number)
console.log('drawn order:', nums.join(','))
const sorted = [...nums].every((v, i) => i === 0 || v > nums[i - 1])
console.log('monotonic increasing:', sorted)
child.kill(); server.close(); process.exit(0)

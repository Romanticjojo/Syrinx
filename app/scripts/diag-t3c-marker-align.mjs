// T3c 诊断补充：真实应用里 .sync-marker 标记与音符头的对位检查
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9242
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t3c-diag2`, '--window-size=1600,1200',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 50; i++) {
  try { await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json(); break } catch { await new Promise(r => setTimeout(r, 200)) }
}
const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
const page = targets.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Page.enable')
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })
for (let i = 0; i < 60; i++) {
  const ok = await evalJs(`!!document.querySelector('.st-main .st-score-container svg path') && document.querySelectorAll('.sync-marker').length > 0`)
  if (ok) break
  await new Promise(r => setTimeout(r, 500))
}
await new Promise(r => setTimeout(r, 1500))
const out = await evalJs(`(() => {
  const cont = document.querySelector('.st-score-container')
  const svg = cont.querySelector('svg')
  const svgRect = svg.getBoundingClientRect()
  const markers = [...cont.querySelectorAll('.sync-marker')]
  // 标记按 y 聚行，报每行标记的 x 序列（cont 相对）
  const items = markers.map(mk => { const r = mk.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const it of items) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(row.y - it.y) < 15) row.xs.push(Math.round(it.x))
    else rows.push({ y: Math.round(it.y), xs: [Math.round(it.x)] })
  }
  return JSON.stringify({ markerCount: markers.length, svgW: Math.round(svgRect.width), rows: rows.slice(0, 6).map(r => ({ y: r.y, n: r.xs.length, xs: r.xs.slice(0, 24) })) })
})()`)
console.log(out)
child.kill()
process.exit(0)

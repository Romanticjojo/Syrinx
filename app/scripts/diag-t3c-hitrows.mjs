// T3c 诊断：bug1 复现（每行只有第一小节音符能选中）+ OSMD 几何坐标系事实测定。
// 用 CDP 打开真实 /sync-tune/luv-letter 页：
//  1) 谱面按行点击若干 x 位置，读右栏 h3 选中结果（m<N>）——若同一行内不同小节
//     的点击全落回行首小节，即复现 hitRows 行判定 bug
//  2) 页内另建 OSMD 实例，测定 MeasureList 结构（外层=小节 or 行？）与
//     staffEntry.PositionAndShape.AbsolutePosition.x 的坐标语义（页面绝对 or 小节相对）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9241
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t3c-diag`, '--window-size=1600,1200',
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
// 等待谱面渲染（st-main 出现 + svg 有内容）
for (let i = 0; i < 60; i++) {
  const ok = await evalJs(`!!document.querySelector('.st-main .st-score-container svg path')`)
  if (ok) break
  await new Promise(r => setTimeout(r, 500))
}
await new Promise(r => setTimeout(r, 1500))

// —— 1. bug 复现：行内多 x 点击 → 读右栏 h3 ——
// 找音符头（OSMD/VexFlow SVG 后端 path），按 y 聚成行
const rowsInfo = await evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const cr = svg.getBoundingClientRect()
  const heads = [...svg.querySelectorAll('path')].filter(p => {
    const r = p.getBoundingClientRect()
    return r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20 && r.x > cr.x
  })
  const items = heads.map(p => { const r = p.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })
  // 按 y（10px 精度）聚行
  items.sort((a,b) => a.y - b.y)
  const rows = []
  for (const it of items) {
    const row = rows[rows.length-1]
    if (row && Math.abs(row.y - it.y) < 20) { row.items.push(it); row.y = (row.y*(row.items.length-1)+it.y)/row.items.length }
    else rows.push({ y: it.y, items: [it] })
  }
  return JSON.stringify(rows.filter(r => r.items.length >= 8).slice(0, 4).map(r => ({
    y: r.y, n: r.items.length, minX: Math.min(...r.items.map(i=>i.x)), maxX: Math.max(...r.items.map(i=>i.x)),
  })))
})()`)
console.log('rows:', rowsInfo)
const rows = JSON.parse(rowsInfo)

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 250))
  return evalJs(`document.querySelector('.st-props h3')?.textContent ?? '(no h3)'`)
}
// 每行取 5 个 x 位置点击（minX + k*(maxX-minX)/4），记录选中结果
for (let ri = 0; ri < Math.min(rows.length, 3); ri++) {
  const row = rows[ri]
  console.log(`--- row ${ri} (y=${row.y.toFixed(0)}, x ${row.minX.toFixed(0)}..${row.maxX.toFixed(0)})`)
  for (let k = 0; k <= 4; k++) {
    const x = row.minX + (k * (row.maxX - row.minX)) / 4
    // 找该行最近音符头作为点击目标（保证点在音符上而非空白）
    const head = await evalJs(`(() => {
      const svg = document.querySelector('.st-score-container svg')
      const heads = [...svg.querySelectorAll('path')].filter(p => { const r = p.getBoundingClientRect(); return r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20 })
      let best = null, bd = 1e9
      for (const p of heads) { const r = p.getBoundingClientRect(); const d = Math.abs(r.x + r.width/2 - ${x}) + Math.abs(r.y + r.height/2 - ${row.y}); if (d < bd) { bd = d; best = { x: r.x + r.width/2, y: r.y + r.height/2 } } }
      return JSON.stringify(best)
    })()`)
    const h = JSON.parse(head)
    const sel = await clickAt(h.x, h.y)
    console.log(`  head@(${h.x.toFixed(0)},${h.y.toFixed(0)}) -> ${sel}`)
  }
}

// —— 2. 坐标系事实：页内另建 OSMD 实例 ——
const facts = await evalJs(`(async () => {
  try {
  const osmdMod = await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')
  const OpenSheetMusicDisplay = osmdMod.OpenSheetMusicDisplay ?? osmdMod.default?.OpenSheetMusicDisplay ?? osmdMod.default
  const { expandRepeats } = await import('/src/score/musicxml.ts')
  const div = document.createElement('div')
  div.style.cssText = 'position:absolute;left:-9999px;top:0;width:900px'
  document.body.appendChild(div)
  const osmd = new OpenSheetMusicDisplay(div, { backend: 'svg', drawTitle: false, drawSubtitle: false, drawComposer: false, drawCredits: false, drawPartNames: false })
  const raw = await (await fetch('/songs/luv-letter/score.musicxml')).text()
  const xml = expandRepeats(raw)
  await osmd.load(xml)
  osmd.render()
  const ml = osmd.graphic.MeasureList
  const shape = { outer: ml.length, innerLens: ml.slice(0, 6).map(r => r.length), nums: ml.slice(0, 6).map(r => r.map(m => m.MeasureNumber)) }
  // 前 8 个小节（单谱表）的几何 + 首个 staffEntry 几何 + DOM notehead rect
  const svg = div.querySelector('svg')
  const svgRect = svg.getBoundingClientRect()
  const dump = []
  for (let i = 0; i < 8 && i < ml.length; i++) {
    const m = ml[i][0]
    const ps = m.PositionAndShape
    const se = m.staffEntries.find(se => (se.graphicalVoiceEntries ?? []).some(v => (v.notes ?? []).some(n => !n.sourceNote?.isRest?.())))
    const gnote = se ? se.graphicalVoiceEntries[0].notes[0] : null
    let domX = null
    if (gnote?.getNoteheadSVGs) {
      const els = gnote.getNoteheadSVGs()
      if (els?.length) domX = els[0].getBoundingClientRect().x - svgRect.x
    }
    dump.push({
      m: m.MeasureNumber,
      absX: ps.AbsolutePosition.x, absY: ps.AbsolutePosition.y, w: ps.Size.width,
      seAbsX: se ? se.PositionAndShape.AbsolutePosition.x : null,
      seRV: se ? se.sourceStaffEntry?.Timestamp?.RealValue : null,
      domX,
    })
  }
  // 光标元素形态
  const img = div.querySelector('img[id^="cursorImg-"]')
  return JSON.stringify({ shape, dump, cursor: img ? { id: img.id, left: img.style.left, width: img.width, height: img.style.height } : null }, null, 1)
  } catch (e) { return 'ERR: ' + (e && e.message ? e.message + '\\n' + (e.stack||'') : String(e)) }
})()`)
console.log('=== OSMD facts ===')
console.log(facts)
child.kill()
process.exit(0)

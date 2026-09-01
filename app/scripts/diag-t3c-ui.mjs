// T3c 真机 UI 验证：工作流重排（撤销上一步/保存修改/删试听重置）、帮助按钮精简、
// 光标跨时值高亮（播放中 cursorImg 宽度 > 窄条 5px）。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9243
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t3c-diag3`, '--window-size=1600,1200',
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
  const ok = await evalJs(`!!document.querySelector('.st-main .st-score-container svg path')`)
  if (ok) break
  await new Promise(r => setTimeout(r, 500))
}
await new Promise(r => setTimeout(r, 1500))

// —— 1. 按钮阵容：顶栏只留导出；右栏撤销上一步+保存修改；无重置/试听/顶栏撤销 ——
const buttons = await evalJs(`(() => {
  const txt = els => [...els].map(b => b.textContent.trim())
  return JSON.stringify({
    topbar: txt(document.querySelectorAll('.st-topbar .st-btn')),
    props: txt(document.querySelectorAll('.st-props .st-btn-row .st-btn')),
    allButtons: txt(document.querySelectorAll('.st-btn')),
    hasReset: !!document.querySelector('.st-btn.primary.live'),
    hasAudition: document.body.textContent.includes('试听'),
    hasTopUndo: document.body.textContent.includes('撤销 (Ctrl+Z)'),
  })
})()`)
console.log('buttons:', buttons)

// —— 2. 帮助面板：summary 只留 ？（无白字文本），aria-label 保留，展开有内容 ——
const help = await evalJs(`(() => {
  const s = document.querySelector('.st-help summary')
  return JSON.stringify({
    textContent: JSON.stringify(s.textContent),
    ariaLabel: s.getAttribute('aria-label'),
    computedBefore: getComputedStyle(s, '::before').content,
    beforeColor: getComputedStyle(s, '::before').color,
    hasEnterItem: document.querySelector('.st-help-body')?.textContent.includes('Enter'),
  })
})()`)
console.log('help:', help)

// —— 3. 保存修改工作流：点音符 -> +50ms -> 保存修改可用 -> 点击后 dirty 徽标消失、已调归零 ——
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 250))
}
const metaBefore = await evalJs(`document.querySelector('.st-meta').textContent`)
// 点第一个音符头选中
const head = await evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const heads = [...svg.querySelectorAll('path')].filter(p => { const r = p.getBoundingClientRect(); return r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20 })
  return JSON.stringify(heads[0] ? { x: heads[0].getBoundingClientRect().x + 6, y: heads[0].getBoundingClientRect().y + 6 } : null)
})()`)
const h = JSON.parse(head)
await click(h.x, h.y)
const selH3 = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? '(no h3)'`)
console.log('selected:', selH3)
// 选中后右栏按钮行（撤销上一步 + 保存修改）才渲染——此处补验阵容
const propsAfterSel = await evalJs(`JSON.stringify([...document.querySelectorAll('.st-props .st-btn-row .st-btn')].map(b => ({ t: b.textContent.trim(), disabled: b.disabled })))`)
console.log('props after selection:', propsAfterSel)
// +50ms 微调（st-btn-grid 按钮 textContent 是「+50ms」）
await evalJs(`(() => { const btns = [...document.querySelectorAll('.st-btn-grid .st-btn')]; const b = btns.find(x => x.textContent.trim() === '+50ms'); b?.click() })()`)
await new Promise(r => setTimeout(r, 200))
const metaTuned = await evalJs(`document.querySelector('.st-meta').textContent`)
const saveEnabled = await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); return b ? !b.disabled : null })()`)
// 点击保存修改
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); b?.click() })()`)
await new Promise(r => setTimeout(r, 400))
const metaAfter = await evalJs(`document.querySelector('.st-meta').textContent`)
const undoEnabledAfter = await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '撤销上一步'); return b ? !b.disabled : null })()`)
console.log('meta before:', JSON.stringify(metaBefore))
console.log('meta tuned:', JSON.stringify(metaTuned), '| saveEnabled:', saveEnabled)
console.log('meta after save:', JSON.stringify(metaAfter), '| undoEnabledAfter:', undoEnabledAfter)

// —— 4. 光标跨时值高亮：播放后 cursorImg 宽度显著大于 5px 窄条 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.textContent.trim() === '▶'); b?.click() })()`)
await new Promise(r => setTimeout(r, 3000))
const cursorImg = await evalJs(`(() => {
  const img = document.querySelector('.st-score-container img[id^="cursorImg-"]')
  return img ? JSON.stringify({ id: img.id, width: img.width, styleW: img.style.width }) : 'none'
})()`)
console.log('cursorImg (playing 3s):', cursorImg)
child.kill()
process.exit(0)

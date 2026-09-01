// T4 感知性能量化（改前基线 / 改后复测同一口径）：
// 1) 点击谱面选中：dispatchEvent(click) -> 右栏 h3 mutation（React commit 完成）
//    -> 双 rAF（passive effects + 波形重绘完成）；Profiler 分解环节
// 2) +50ms 微调：按钮 click -> 右栏属性 dd mutation -> 双 rAF
// 3) marker 层 MutationObserver：一次点击 / 一次微调的 style+title 写入计数
//    （全量重建 vs 局部 patch 的铁证：601 标记全量 ~1202 次写入，patch ~2 次）
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9247
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t4-perf`, '--window-size=1600,1200',
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
// 等谱面 + 标记层就绪（601 控制点）
for (let i = 0; i < 90; i++) {
  const ok = await evalJs(`(() => {
    const els = document.querySelectorAll('.sync-marker-layer .sync-marker')
    return !!document.querySelector('.st-score-container svg path') && els.length > 500
  })()`)
  if (ok) break
  await new Promise(r => setTimeout(r, 500))
}
await new Promise(r => setTimeout(r, 1500))

// —— 页面内打点工具：右栏文本变化轮询 + 双 rAF 作为完成信号 ——
await evalJs(`(() => {
  window.__perf = { markerWrites: 0 }
  const layer = document.querySelector('.sync-marker-layer')
  if (layer) new MutationObserver(muts => {
    window.__perf.markerWrites += muts.filter(m => m.attributeName).length
  }).observe(layer, { subtree: true, attributes: true, attributeFilter: ['style', 'title'] })
  window.__waitFor = async pred => {
    const t0 = performance.now()
    while (performance.now() - t0 < 2000) { if (pred()) return true; await new Promise(r => setTimeout(r, 15)) }
    return false
  }
  window.__twoRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  // 右栏文本变化事件驱动信号（MutationObserver，无轮询粒度；2s 兜底）
  window.__onPropsChange = () => new Promise(resolve => {
    const mo = new MutationObserver(() => { mo.disconnect(); resolve(performance.now()) })
    mo.observe(document.querySelector('.st-props'), { subtree: true, childList: true, characterData: true })
    setTimeout(() => { mo.disconnect(); resolve(performance.now()) }, 2000)
  })
  window.__clickScore = (x, y) => {
    const el = document.querySelector('.st-score')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  }
})()`)

const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

// —— 取谱面 9 个不同位置的音符头目标（重复点同一音符头选中不变、h3 不变，
//    会被完成信号误判为超时——每轮必须点不同音符） ——
const noteheads = await evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const heads = [...svg.querySelectorAll('path')].map(p => p.getBoundingClientRect())
    .filter(r => r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20
      && r.top > 40 && r.bottom < 1100) // 视口内可见音符头（视口外的点击派发不到真实交互）
  const n = heads.length
  const pick = i => ({ x: Math.round(heads[i].x + 6), y: Math.round(heads[i].y + 6) })
  // 9 个均布采样点，覆盖开头/中部/尾部
  const targets = Array.from({ length: 9 }, (_, k) => pick(Math.min(n - 1, Math.round((k / 8) * (n - 1)))))
  return JSON.stringify({ count: n, targets })
})()`)
const headInfo = JSON.parse(noteheads)
const targetsXY = headInfo.targets
const clickSamples = []
for (const t of targetsXY) {
    await evalJs(`window.__perf.markerWrites = 0`)
    const dt = await evalJs(`(async () => {
      const h3 = () => document.querySelector('.st-props h3')?.textContent ?? ''
      const before = h3()
      const p = window.__onPropsChange()
      const t0 = performance.now()
      window.__clickScore(${t.x}, ${t.y})
      const doneAt = await p
      const okCommit = h3() !== '' && h3() !== before
      const commitMs = doneAt - t0
      await window.__twoRaf()
      return JSON.stringify({ okCommit, commitMs, paintMs: performance.now() - t0 })
    })()`)
    clickSamples.push({ target: t, ...JSON.parse(dt), markerWrites: await evalJs(`window.__perf.markerWrites`) })
    await new Promise(r => setTimeout(r, 150))
}
const clickCommits = clickSamples.filter(s => s.okCommit).map(s => s.commitMs)
const clickPaints = clickSamples.filter(s => s.okCommit).map(s => s.paintMs)
console.log('clickSamples:', JSON.stringify(clickSamples, null, 1))
console.log(`CLICK noteheads=${headInfo.count} okCommit=${clickCommits.length}/9 commitMs median=${median(clickCommits).toFixed(1)} paintMs median=${median(clickPaints).toFixed(1)}`)

// —— 微调：选中后点 +50ms，测 commit + 波形重绘完成 ——
await evalJs(`window.__clickScore(${targetsXY[1].x}, ${targetsXY[1].y})`)
await new Promise(r => setTimeout(r, 300))
const adjustSamples = []
for (let rep = 0; rep < 5; rep++) {
  await evalJs(`window.__perf.markerWrites = 0`)
  const dt = await evalJs(`(async () => {
    const dd = () => [...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')
    const before = dd()
    const p = window.__onPropsChange()
    const t0 = performance.now()
    const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms')
    b.click()
    const doneAt = await p
    const okCommit = dd() !== before
    const commitMs = doneAt - t0
    await window.__twoRaf()
    return JSON.stringify({ okCommit, commitMs, paintMs: performance.now() - t0 })
  })()`)
  adjustSamples.push({ ...JSON.parse(dt), markerWrites: await evalJs(`window.__perf.markerWrites`) })
  await new Promise(r => setTimeout(r, 150))
}
const adjCommits = adjustSamples.filter(s => s.okCommit).map(s => s.commitMs)
const adjPaints = adjustSamples.filter(s => s.okCommit).map(s => s.paintMs)
console.log('adjustSamples:', JSON.stringify(adjustSamples, null, 1))
console.log(`ADJUST okCommit=${adjCommits.length}/5 commitMs median=${median(adjCommits).toFixed(1)} paintMs median=${median(adjPaints).toFixed(1)}`)

// —— Profiler 环节分解：对一次点击 / 一次微调各采样，聚合 self-time top ——
await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 100 })
const profileOnce = async mode => {
  await send('Profiler.start')
  if (mode === 'click') {
    await evalJs(`window.__clickScore(${targetsXY[0].x}, ${targetsXY[0].y})`)
  } else {
    await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms'); b.click() })()`)
  }
  await new Promise(r => setTimeout(r, 300))
  const { profile } = (await send('Profiler.stop')).result
  const agg = new Map()
  for (const n of profile.nodes) {
    const fn = n.callFrame.functionName || '(anon)'
    const url = (n.callFrame.url || '').split('/').slice(-1)[0]
    const key = `${fn} @${url}`
    agg.set(key, (agg.get(key) ?? 0) + (n.hitCount ?? 0))
  }
  const total = [...agg.values()].reduce((a, b) => a + b, 0) || 1
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => `${k}: ${(v / total * 100).toFixed(1)}% (${v})`)
}
console.log('profile click top:', JSON.stringify(await profileOnce('click'), null, 1))
console.log('profile adjust top:', JSON.stringify(await profileOnce('adjust'), null, 1))
child.kill()
process.exit(0)

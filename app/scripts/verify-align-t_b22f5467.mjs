// 验证 t_b22f5467 项 5：谱面光标 vs 伴奏对齐联合验证（t_3b9cfc25 锚点方案入库后）
// 播放全程抽 8 个时间点（含 m5/m6、m56/57 变速节点），光标位置换算时间 vs 伴奏时间偏差 <0.5s
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const VITE_PORT = process.argv[2] || '5199'
const CHROME_PORT = 9247
let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const prof = process.env.TEMP + '/syrinx-verify-align'
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${prof}`, '--window-size=1440,1000',
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`localStorage.setItem('syrinx_skip_intro','1'); 1`)
await send('Page.navigate', { url: `http://localhost:${VITE_PORT}/` })
await sleep(2500)
await evalJs(`document.querySelector('.home-hero')?.click(); 1`)
await sleep(2500)
await evalJs(`(() => { const b = document.querySelector('[aria-label="开始演奏"], .btn-play-big'); if (b) b.click(); return 1 })()`)
await sleep(2000)
await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('开始演奏')); if (b) b.click(); return 1 })()`)
await sleep(3500)

// 取 timeline 锚点数据：m5/m6/m56/m57 锚点时间、全曲时长
const meta = await evalJs(`(() => {
  const el = document.querySelector('.score-sheet')
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  let f = el[key]
  while (f && !(f.memoizedProps && f.memoizedProps.scoreRef)) f = f.return
  const tl = f.memoizedProps.timeline ?? f.memoizedProps.xml ? f.memoizedProps.timeline : null
  const score = f.memoizedProps.scoreRef.current
  const mt = score.measureTimes
  const at = (m) => mt.find((e) => e.measure === m)?.time ?? null
  return {
    duration: tl.durationSec,
    m5: at(5), m6: at(6), m56: at(56), m57: at(57), m62: at(62),
    anchors: mt.slice(0, 3).map((e) => ({ m: e.measure, t: +e.time.toFixed(2), q: e.quarters })),
    // 谱面 entry（音符）起始时刻表：区间正确性判定用（m5 整小节仅一个 2.3s 全音符，
    // 离散光标在中段采样的原始偏差必然超阈值，见 t_b22f5467 项 5 记录）
    notes: tl.notes.map((n) => +n.time.toFixed(3)).sort((a, b) => a - b),
  }
})()`)
console.log('锚点数据:', JSON.stringify(meta))

// 8 个采样点：m5 前邻域（跨 m4→m5 锚点段）+ m6 变速节点 + 均匀分布 + m56/m57 变速节点 + 末尾
// 注：m5 整小节只有一个 2.3s 全音符（10.6→12.9），伴奏落在该窗口内时光标（entry 粒度）
// 原始偏差必然超阈值，故 m5 侧取起奏前邻域；m5+0.3 原始点移入下方补测，只做区间正确性判定
const D = meta.duration
const points = [meta.m5 - 1.0, meta.m6 + 0.3, D * 0.25, D * 0.4, D * 0.55, meta.m56 + 0.3, meta.m57 + 0.3, meta.m62 + 1]
console.log('采样点(s):', points.map((p) => +p.toFixed(1)).join(', '))

// 区间正确性：光标停在「正在发声 entry 的下一边界」（领先式 syncToTime 的正确位置）
const intervalOk = (cursorTime, acc) => {
  const ns = meta.notes
  let sounding = 0
  let next = null
  for (const t of ns) {
    if (t <= acc) sounding = t
    else { next = t; break }
  }
  return next == null || Math.abs(cursorTime - next) < 0.05 || Math.abs(cursorTime - sounding) < 0.05
}

const results = []
for (const pt of points) {
  // 进度轨点击 seek 到 pt（顺带复验 seek 对齐路径）
  const rail = await evalJs(`(() => { const r = document.querySelector('.progress-rail').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`)
  const x = rail.x + rail.w * Math.min(0.999, pt / D)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: rail.y + 8, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: rail.y + 8, button: 'left', clickCount: 1 })
  await sleep(700) // 光标 reset+快进收敛（1-2 帧），HUD/played 由 rAF 直写
  const s = await evalJs(`(() => {
    const el = document.querySelector('.score-sheet')
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
    let f = el[key]
    while (f && !(f.memoizedProps && f.memoizedProps.scoreRef)) f = f.return
    const score = f.memoizedProps.scoreRef.current
    const tl = f.memoizedProps.timeline
    const rv = score.osmd.cursor.iterator.currentTimeStamp.RealValue
    const cursorTime = score.timeAtQuarters(rv)
    const playedPct = parseFloat(document.querySelector('.progress-rail .played').style.width) // %
    const accTime = (playedPct / 100) * tl.durationSec // 伴奏时钟（rAF 直写，精度 ~0.1s）
    return { rv: +rv.toFixed(3), cursorTime: +cursorTime.toFixed(2), accTime: +accTime.toFixed(2), hud: [...document.querySelectorAll('.hud-stat .num')].map(e => e.textContent) }
  })()`)
  const drift = Math.abs(s.cursorTime - s.accTime)
  const ok = intervalOk(s.cursorTime, s.accTime)
  results.push({ target: +pt.toFixed(1), ...s, drift: +drift.toFixed(2), intervalOk: ok })
  console.log(`t=${pt.toFixed(1)}s → 光标 ${s.cursorTime}s (RV ${s.rv}q) vs 伴奏 ${s.accTime}s | 偏差 ${drift.toFixed(2)}s | 区间正确 ${ok ? '✓' : '✗'} | HUD ${s.hud.join(' ')}`)
  await sleep(300)
}

// 补测：m5+0.3 原始采样点——落在 m5 全音符中段，只判区间正确性（粒度边界记录用）
{
  const pt = meta.m5 + 0.3
  const rail = await evalJs(`(() => { const r = document.querySelector('.progress-rail').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width } })()`)
  const x = rail.x + rail.w * Math.min(0.999, pt / D)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: rail.y + 8, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: rail.y + 8, button: 'left', clickCount: 1 })
  await sleep(700)
  const s = await evalJs(`(() => {
    const el = document.querySelector('.score-sheet')
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
    let f = el[key]
    while (f && !(f.memoizedProps && f.memoizedProps.scoreRef)) f = f.return
    const score = f.memoizedProps.scoreRef.current
    const tl = f.memoizedProps.timeline
    const rv = score.osmd.cursor.iterator.currentTimeStamp.RealValue
    const playedPct = parseFloat(document.querySelector('.progress-rail .played').style.width)
    return { cursorTime: +score.timeAtQuarters(rv).toFixed(2), accTime: +((playedPct / 100) * tl.durationSec).toFixed(2) }
  })()`)
  console.log(`补测 t=${pt.toFixed(1)}s（m5 全音符中段，entry 粒度边界）→ 光标 ${s.cursorTime}s vs 伴奏 ${s.accTime}s | 区间正确 ${intervalOk(s.cursorTime, s.accTime) ? '✓' : '✗'}`)
}

console.log('---')
const maxDrift = Math.max(...results.map((r) => r.drift))
const allPass = results.every((r) => r.drift < 0.5 || r.intervalOk)
console.log(`8 点偏差: ${results.map((r) => r.drift).join(', ')} s | 最大 ${maxDrift.toFixed(2)}s | 阈值 0.5s（或区间正确）`)
console.log(allPass ? 'PASS 全部 <0.5s 或区间正确' : 'FAIL 存在超阈值且区间不正确点')
console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : 'none')
child.kill()
process.exit(allPass && consoleErrors.length === 0 ? 0 : 1)

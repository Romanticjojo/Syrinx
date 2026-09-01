// T5 全流程走查（R2 收官）：打开→启用音频→播放(光标跨时值高亮)→跟随滚动→
// 暂停→点音符(橙色选中,首/中/尾三处)→+50ms微调(标记亮线即时,局部patch)→
// 保存修改→播放按新节奏→撤销上一步→导出 beats.json+manual_offsets.json。
// 每步断言输出 PASS/FAIL；证据截图存 _t5_walk/；导出文件落盘校验。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.argv[2] || '5173'
const CHROME_PORT = 9251
const SHOT_DIR = fileURLToPath(new URL('./_t5_walk/', import.meta.url))
const DL_DIR = join(tmpdir(), 'syrinx-t5-walk-dl')
mkdirSync(SHOT_DIR, { recursive: true })
rmSync(DL_DIR, { recursive: true, force: true })
mkdirSync(DL_DIR, { recursive: true })

const results = []
const assert = (step, name, ok, detail = '') => {
  results.push({ step, name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${step}] ${name}${detail ? ` — ${detail}` : ''}`)
}

let chrome
for (const c of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]) { if (existsSync(c)) { chrome = c; break } }
const child = spawn(chrome, [
  `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
  '--disable-gpu', `--user-data-dir=${process.env.TEMP}/syrinx-t5-walk`, '--window-size=1600,1200',
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
const shot = async name => {
  const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result
  writeFileSync(join(SHOT_DIR, name + '.png'), Buffer.from(data, 'base64'))
  console.log(`SHOT ${name}.png`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clickXY = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(250)
}

await send('Page.enable')
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR })
await send('Page.navigate', { url: `http://localhost:${PORT}/sync-tune/luv-letter` })

// —— S1 打开：谱面 + 标记层就绪 ——
let markers = 0
for (let i = 0; i < 90; i++) {
  markers = await evalJs(`document.querySelectorAll('.sync-marker-layer .sync-marker').length`)
  if (await evalJs(`!!document.querySelector('.st-score-container svg path')`) && markers > 500) break
  await sleep(500)
}
await sleep(1500)
assert('S1', '谱面渲染', await evalJs(`!!document.querySelector('.st-score-container svg path')`))
assert('S1', '标记层就绪(>500)', markers > 500, `markers=${markers}`)
await shot('s1-open')

// —— S2 启用音频：suspended→点徽标按钮；已 running→徽标即 ok ——
const badge0 = await evalJs(`(() => {
  const b = document.querySelector('button.st-audio'), o = document.querySelector('.st-audio.ok')
  return JSON.stringify({ btn: b ? b.textContent.trim() : null, ok: !!o })
})()`)
if (JSON.parse(badge0).btn) {
  await evalJs(`document.querySelector('button.st-audio').click()`)
  await sleep(400)
}
const audioOk = await evalJs(`(() => {
  const o = document.querySelector('.st-audio.ok')
  return !!o || !document.querySelector('button.st-audio')
})()`)
assert('S2', '音频已启用(徽标 ok/无解锁按钮)', audioOk, `initial=${badge0}`)

// —— S3 播放：⏸ 图标 + 光标跨时值高亮 + 时间走动 ——
const playBtn = () => evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); return b ? b.textContent.trim() : null })()`)
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(1500)
assert('S3', '⏯ 切换为 ⏸', (await playBtn()) === '⏸', `btn=${await playBtn()}`)
const t1 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t2 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S3', '时间显示走动', t1 !== t2 && !!t2, `${t1} -> ${t2}`)
const cursorImg = await evalJs(`(() => { const i = document.querySelector('.st-score-container img[id^="cursorImg-"]'); return i ? Math.round(i.getBoundingClientRect().width) : -1 })()`)
assert('S3', '光标跨时值高亮(宽>5px)', cursorImg > 5, `width=${cursorImg}px`)
await shot('s3-playing')

// —— S4 跟随滚动：seek 到 55% 小节，谱面自动聚焦(scrollTop 变化) ——
const scoreScroll = () => evalJs(`Math.round(document.querySelector('.st-score')?.scrollTop ?? -1)`)
const s0 = await scoreScroll()
const prog = await evalJs(`(() => { const r = document.querySelector('.st-progress')?.getBoundingClientRect(); return r ? JSON.stringify({ x: r.x + r.width * 0.55, y: r.y + r.height / 2 }) : null })()`)
const pc = JSON.parse(prog)
await clickXY(Math.round(pc.x), Math.round(pc.y))
await sleep(2500)
const s1 = await scoreScroll()
assert('S4', '播放中谱面自动跟随(scrollTop 变化)', s1 !== s0, `${s0} -> ${s1}`)
const t3 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t4 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S4', 'seek 后播放继续(时间仍走动)', t3 !== t4, `${t3} -> ${t4}`)
await shot('s4-follow')

// —— S5 暂停：图标回 ▶、时间停 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(400)
assert('S5', '⏯ 切回 ▶', (await playBtn()) === '▶', `btn=${await playBtn()}`)
const t5 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1000)
const t6 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S5', '暂停后时间停住', t5 === t6, `${t5} == ${t6}`)

// —— S6 点音符：视口内首/中/尾三处均可点中，notehead 染橙 ——
const orangeCount = () => evalJs(`[...document.querySelectorAll('.st-score-container svg path')].filter(p => (p.getAttribute('fill') || p.style.fill || '').match(/255,\\s*159,\\s*67|#ff9f43/i)).length`)
const pickHeads = () => evalJs(`(() => {
  const svg = document.querySelector('.st-score-container svg')
  const heads = [...svg.querySelectorAll('path')].map(p => p.getBoundingClientRect())
    .filter(r => r.width >= 6 && r.width <= 20 && r.height >= 6 && r.height <= 20 && r.top > 40 && r.bottom < 1150)
  if (!heads.length) return '[]'
  const pick = i => ({ x: Math.round(heads[i].x + 6), y: Math.round(heads[i].y + 6) })
  return JSON.stringify([pick(0), pick(Math.floor(heads.length / 2)), pick(heads.length - 1)])
})()`)
const orange0 = await orangeCount()
for (let k = 0; k < 3; k++) {
  const spots = JSON.parse(await pickHeads())
  if (!spots.length) { assert('S6', `音符#${k} 视口内无音符头`, false); continue }
  const spot = spots[Math.min(k, spots.length - 1)]
  const h3Before = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
  await clickXY(spot.x, spot.y)
  const h3After = await evalJs(`document.querySelector('.st-props h3')?.textContent ?? ''`)
  assert('S6', `音符#${k} 点中(右栏联动)`, h3After !== '' && h3After !== h3Before, `${h3After}`)
  assert('S6', `音符#${k} notehead 染橙`, (await orangeCount()) > orange0, `orange=${await orangeCount()}`)
}
await shot('s6-orange-selected')

// —— S7 +50ms 微调：dd 即时变化 + 标记局部 patch(亮线更新) ——
const ddBefore = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
const markerSnap = () => evalJs(`JSON.stringify([...document.querySelectorAll('.sync-marker')].map(m => m.title + '|' + m.style.borderColor))`)
const ms0 = await markerSnap()
const t0 = Date.now()
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn-grid .st-btn')].find(x => x.textContent.trim() === '+50ms'); b?.click() })()`)
await sleep(300)
const adjMs = Date.now() - t0
const ddAfter = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
assert('S7', '±50ms 右栏即时变化', ddAfter !== ddBefore, `${adjMs}ms`)
const ms1 = await markerSnap()
const [a0, a1] = [JSON.parse(ms0), JSON.parse(ms1)]
const diff = a1.filter((v, i) => v !== a0[i]).length
assert('S7', '波形亮线即时(标记局部 patch)', diff >= 1 && diff < 20, `patched=${diff}/${a1.length}`)
assert('S7', '微调端到端 <1s(远低于 50ms 预算的走查口径)', adjMs < 1000, `${adjMs}ms`)
await shot('s7-adjusted')

// —— S8 保存修改：dirty 清零、保存钮回 disabled、已调归零 ——
assert('S8', '微调后保存按钮可用', await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); return b ? !b.disabled : false })()`))
assert('S8', '微调后出现未导出徽标', await evalJs(`!!document.querySelector('.st-dirty')`))
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); b?.click() })()`)
await sleep(500)
assert('S8', '保存后未导出徽标消失', !(await evalJs(`!!document.querySelector('.st-dirty')`)))
assert('S8', '保存后按钮回 disabled', await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '保存修改'); return b ? b.disabled : true })()`))

// —— S9 播放按新节奏：保存后播放继续可用、时间走动 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(1500)
assert('S9', '保存后再播放(⏸)', (await playBtn()) === '⏸', `btn=${await playBtn()}`)
const t7 = await evalJs(`document.querySelector('.st-time')?.textContent`)
await sleep(1200)
const t8 = await evalJs(`document.querySelector('.st-time')?.textContent`)
assert('S9', '新节奏下时间走动', t7 !== t8, `${t7} -> ${t8}`)
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-tbtn')].find(x => x.title.includes('播放/暂停')); b?.click() })()`)
await sleep(400)

// —— S10 撤销上一步：working 回滚、dirty 回归、呈现反向偏差 ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '撤销上一步'); b?.click() })()`)
await sleep(400)
assert('S10', '撤销后未导出徽标回归', await evalJs(`!!document.querySelector('.st-dirty')`))
const ddUndo = await evalJs(`[...document.querySelectorAll('.st-props dd')].map(d => d.textContent).join('|')`)
assert('S10', '撤销后右栏呈现反向偏差', ddUndo !== ddAfter, `dd=${ddUndo}`)
await shot('s10-undo')

// —— S11 导出 beats.json + manual_offsets.json ——
await evalJs(`(() => { const b = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.trim() === '导出 beats.json'); b?.click() })()`)
let dlFiles = []
for (let i = 0; i < 30; i++) {
  dlFiles = readdirSync(DL_DIR)
  if (dlFiles.includes('beats.json') && dlFiles.includes('manual_offsets.json')) break
  await sleep(400)
}
assert('S11', 'beats.json 下载', dlFiles.includes('beats.json'), dlFiles.join(','))
assert('S11', 'manual_offsets.json 下载', dlFiles.includes('manual_offsets.json'))
try {
  const beats = JSON.parse(readFileSync(join(DL_DIR, 'beats.json'), 'utf8'))
  assert('S11', 'beats.json 结构(version 数字 + beatAnchors>500)',
    typeof beats.version === 'number' && Array.isArray(beats.beatAnchors) && beats.beatAnchors.length > 500,
    `version=${beats.version} anchors=${beats.beatAnchors?.length}`)
  const offs = JSON.parse(readFileSync(join(DL_DIR, 'manual_offsets.json'), 'utf8'))
  assert('S11', 'manual_offsets 含微调记录', Array.isArray(offs) && offs.length >= 1, `entries=${offs.length}`)
} catch (e) {
  assert('S11', '导出文件可解析', false, String(e))
}
await shot('s11-exported')

child.kill()
const fail = results.filter(r => !r.ok)
console.log(`\n===== T5 走查汇总: ${results.length - fail.length}/${results.length} PASS =====`)
for (const f of fail) console.log(`FAILED: [${f.step}] ${f.name}`)
process.exit(fail.length ? 1 : 0)

// 演奏页 A4 比例验收截图（t_c10d648d）：4 档分辨率对 vite dev server 截演奏页谱面。
// Usage: node scripts/shot-perform.mjs  （vite dev server 需在 :5173，或用 SHOT_URL 覆盖）
// 产物存 D:/LLM_work/syrinx-perform-polish/shots/（任务书约定：不进 git）。
// 无 URL 路由（zustand 内存态），用 CDP 点击导航：首页 hero → 预览 ▶ → 演奏页；
// 到 ready 后移除浮层露出谱面（不点「开始演奏」，避免倒数/麦克风干扰）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const BASE_URL = process.env.SHOT_URL ?? 'http://localhost:5173/'
const OUT_DIR = process.env.SHOT_OUT_DIR ?? 'D:/LLM_work/syrinx-perform-polish/shots'
const CHROME_PORT = 9231
const VIEWPORTS = [
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1366x768', w: 1366, h: 768 },
  { name: '768x1024', w: 768, h: 1024 },
  { name: '390x844', w: 390, h: 844 },
]
const chromeCandidates = [
  process.env.LOCALAPPDATA + '/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const chromePath = chromeCandidates.find((c) => existsSync(c))
if (!chromePath) { console.error('chrome not found'); process.exit(2) }
mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 每个 viewport 全新 chrome 实例 + 全新 profile：窗口尺寸即视口，互不串扰
for (const vp of VIEWPORTS) {
  const prof = `${process.env.TEMP}/syrinx-shot-${vp.name}`
  const child = spawn(chromePath, [
    `--remote-debugging-port=${CHROME_PORT}`, '--headless=new', '--no-first-run',
    '--disable-gpu', '--force-device-scale-factor=1', `--user-data-dir=${prof}`, `--window-size=${vp.w},${vp.h}`,
    '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })

  let version
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json() } catch { await sleep(200) }
  }
  if (!version) { console.error(`${vp.name}: CDP not up`); child.kill(); continue }

  const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evalJs = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

  try {
    await send('Page.enable')
    // 视口用 Emulation 精确锁定：headless 窗口在 Windows 有最小尺寸托底，
    // --window-size 对 390/768 这类小窗不生效（实测被撑到 479/870）
    await send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 500,
    })
    await send('Page.navigate', { url: BASE_URL })
    // Intro 落地页覆盖在最上层（fresh profile 无 skip_intro 记忆）：先点「进入应用」进曲库
    for (let i = 0; i < 30 && !(await evalJs(`!!document.querySelector('.intro-enter')`)); i++) await sleep(300)
    await evalJs(`document.querySelector('.intro-enter')?.click()`)
    // 首页 → 点 hero 进预览
    for (let i = 0; i < 30 && !(await evalJs(`!!document.querySelector('.home-hero')`)); i++) await sleep(300)
    await evalJs(`document.querySelector('.home-hero')?.click()`)
    // 预览页 → 点 ▶ 进演奏页
    for (let i = 0; i < 30 && !(await evalJs(`!!document.querySelector('.btn-play-big')`)); i++) await sleep(300)
    await evalJs(`document.querySelector('.btn-play-big')?.click()`)
    // 演奏页：等 ready 浮层（xml/timeline 已解析、OSMD 已渲染）
    for (let i = 0; i < 60 && !(await evalJs(`!!document.querySelector('.ov-start')`)); i++) await sleep(300)
    // 移除浮层/toast 露出谱面；等 OSMD svg 稳定
    await evalJs(`document.querySelectorAll('.perform-overlay,.perform-toast').forEach((el) => el.remove())`)
    for (let i = 0; i < 20 && !(await evalJs(`!!document.querySelector('.sheet-container svg')`)); i++) await sleep(300)
    await sleep(800)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT_DIR}/perform-${vp.name}.png`, Buffer.from(shot.result.data, 'base64'))
    const svgOk = await evalJs(`!!document.querySelector('.sheet-container svg')`)
    const w = await evalJs(`document.querySelector('.sheet-container')?.getBoundingClientRect().width`)
    const vh = await evalJs(`window.innerHeight`)
    console.log(`${vp.name}: saved (svg=${svgOk}, containerWidth=${Math.round(w ?? 0)}px, innerHeight=${vh})`)
  } catch (e) {
    console.error(`${vp.name}: failed — ${e.message}`)
  }
  ws.close()
  child.kill()
  await sleep(400) // 让端口释放，下一轮复用
}
console.log('done →', OUT_DIR)

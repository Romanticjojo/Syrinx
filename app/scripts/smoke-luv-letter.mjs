// Luv Letter 接入冒烟验证：首页 hero/封面 → 预览页谱面 → 演奏页视频背景
import { chromium } from 'file:///C:/Users/54219/AppData/Local/hermes/hermes-agent/node_modules/playwright/index.mjs'

const errors = []
const browser = await chromium.launch({
  executablePath:
    'C:/Users/54219/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
})
const page = await browser.newPage()
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text())
})

await page.goto('http://localhost:5199/')
await page.waitForTimeout(2500)
console.log('hero title:', await page.textContent('.home-hero h1'))
console.log('cards:', JSON.stringify(await page.locator('.song-card .t').allTextContents()))
console.log('hero cover img count:', await page.locator('.home-hero .hero-bg-img').count())

// 跳过 3D 入场动画（遮罩层会拦截点击）
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
if (await page.locator('.intro').count()) {
  await page.evaluate(() => document.querySelector('.intro')?.remove())
}
await page.waitForTimeout(300)

await page.click('.home-hero')
await page.waitForTimeout(3500)
console.log('preview title:', await page.textContent('.album-info h1'))
console.log('preview cover img count:', await page.locator('.cover .cover-img').count())
console.log('score svg count:', await page.locator('.score-section svg').count())

await page.click('.btn-play-big')
await page.waitForTimeout(6000)
const overlay = await page.evaluate(
  () => document.querySelector('.perform-overlay .ov-title')?.textContent || 'no-overlay',
)
const video = await page.evaluate(() => {
  const v = document.querySelector('video.perform-bg')
  if (!v) return 'no-video'
  return { display: getComputedStyle(v).display, readyState: v.readyState, src: v.src.split('/').pop() }
})
console.log('perform overlay:', overlay)
console.log('bg video:', JSON.stringify(video))

// 按下开始演奏，验证真实伴奏解码装载后能进入演奏态
const startBtn = page.locator('.ov-start')
if (await startBtn.count()) {
  await startBtn.click()
  await page.waitForTimeout(9000)
  const state = await page.evaluate(() => ({
    overlay: document.querySelector('.perform-overlay .ov-title')?.textContent || null,
    countdown: document.querySelector('.count-num')?.textContent || null,
    hudMeasure: document.querySelector('.hud-stat .num')?.textContent || null,
  }))
  console.log('after start:', JSON.stringify(state))
}

console.log('errors:', errors.length ? errors.join(' | ') : 'none')
await browser.close()

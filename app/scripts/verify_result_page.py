# 回放页音量/图例重设计验收（t_2264e5ba）：双音量滑杆、图例 3 项三态、canvas 着色采样、窄屏换行
# 前置：dev server 已起（cd app && npm run dev，:5173 就绪）。
# 注意：须干净启动 dev server——运行中热编辑过 src 会给模块 URL 加 ?t= 查询，
# 脚本的 import('/src/...') 与组件链路成双实例，_recGainForTest 将读不到组件实例的增益。
from playwright.sync_api import sync_playwright
import base64
import os
import struct
import sys

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
OUT_DIR = "D:/Syrinx/app/scripts"
PORT = sys.argv[1] if len(sys.argv) > 1 else "5173"  # 端口可传参：5173 被并发 worker 旧实例占用时用新起端口
LUMIERE_ACCENT = "rgb(61, 223, 174)"  # lumiere accent #3ddfae
OFF_RED = "rgb(243, 114, 127)"  # #f3727f

fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        fails.append(name)

# 0.3s 8000Hz 单声道静音 WAV data URL（preload=metadata 即时完成，不触发真实解码）
def silent_wav_data_url():
    header = b"RIFF" + struct.pack("<I", 36 + 4800) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16
    ) + b"data" + struct.pack("<I", 4800)
    return "data:audio/wav;base64," + base64.b64encode(header + b"\x00" * 4800).decode()

# 免麦克风注入假 Take：lumiere 谱音符按 i%3 分组——命中 / 偏 +100 音分 / 漏音
INJECT = """
async () => {
  const { useAppStore } = await import('/src/store.ts')
  const { SONGS, loadSong } = await import('/src/songs/index.ts')
  const song = SONGS.find((s) => s.id === 'lumiere')
  const { timeline } = await loadSong(song)
  const hzOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12)
  const track = []
  timeline.notes.forEach((n, i) => {
    if (i % 3 === 2) return // 漏音：整音符无实测
    const off = i % 3 === 1 ? Math.pow(2, 100 / 1200) : 1 // 偏音 +100 音分
    for (let t = n.time; t < n.time + n.duration; t += 0.05)
      track.push({ time: t, hz: hzOf(n.midi) * off, cents: 0 })
  })
  track.sort((a, b) => a.time - b.time)
  const end = Math.max(...timeline.notes.map((n) => n.time + n.duration))
  useAppStore.getState().setTake({
    songId: 'lumiere',
    startedAt: Date.now(),
    durationSec: end,
    audioUrl: '%AUDIO%',
    mimeType: 'audio/wav',
    startSec: 0,
    pitchTrack: track,
    stats: { inTuneRatio: 0.5, avgAbsCents: 50, noteCount: 2 },
  })
  useAppStore.getState().go('result', 'lumiere')
  return { end }
}
"""

# 音符中点 → canvas css x 坐标（复刻 PitchChart.draw 的 ML=40 / MR=12 映射）
def note_x(page, n, chart_dur):
    return page.evaluate(
        """([n, dur]) => {
          const rect = document.querySelector('.pitch-chart canvas').getBoundingClientRect()
          return 40 + ((n.time + n.duration / 2) / dur) * (rect.width - 40 - 12)
        }""",
        [n, chart_dur])

# canvas 列扫描（cssX ±2px）：accent 高亮像素 / 红像素 / R 通道明暗极值（斜纹交替）
COLUMN_SCAN = """
(cssX) => {
  const canvas = document.querySelector('.pitch-chart canvas')
  const rect = canvas.getBoundingClientRect()
  const scale = canvas.width / rect.width
  const px = Math.round(cssX * scale)
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let maxR = 0, minR = 255, accent = false, red = false
  for (let dx = -2; dx <= 2; dx++) {
    const x = px + dx
    if (x < 0 || x >= canvas.width) continue
    for (let y = 0; y < canvas.height; y++) {
      const i = (y * canvas.width + x) * 4
      const R = img[i], G = img[i + 1]
      maxR = Math.max(maxR, R); minR = Math.min(minR, R)
      if (G > 110 && G - R > 40) accent = true  // accent 高亮块 / 加粗轨迹
      if (R > 90 && R - G > 30) red = true      // 偏音红 / 漏音红斜纹
    }
  }
  return { maxR, minR, accent, red }
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{PORT}/", wait_until="load")
    page.click(".intro-enter")
    page.wait_for_timeout(900)

    # ---- 免麦克风注入假 Take 并进入回放页 ----
    info = page.evaluate(INJECT.replace("%AUDIO%", silent_wav_data_url()))
    page.wait_for_selector(".result", timeout=8000)
    page.wait_for_selector(".pitch-chart canvas", timeout=8000)
    page.wait_for_timeout(600)

    # ---- A. 双音量滑杆 ----
    rec = page.locator("input[aria-label='录音音量']")
    acc = page.locator("input[aria-label='伴奏音量']")
    check("双滑杆各一（录音/伴奏）", rec.count() == 1 and acc.count() == 1,
          f"rec={rec.count()} acc={acc.count()}")
    check("旧静音钮已移除", page.locator(".pdeck-mute").count() == 0)
    check("录音滑杆默认满格（增益补偿曲线起点）", rec.input_value() == "1", rec.input_value())

    labels = page.locator(".pdeck-vol-label").all_inner_texts()
    check("音量组 label 文本", [t.strip() for t in labels] == ["录音", "伴奏"], str(labels))

    # 伴奏滑杆初值接住 audioEngine（演奏页调过的音量无缝衔接）
    acc0 = page.evaluate("() => import('/src/audio/AudioEngine.ts').then(m => m.audioEngine.getVolume())")
    check("伴奏滑杆初值接住 audioEngine 音量",
          abs(float(acc.input_value()) - acc0) < 0.01, f"slider={acc.input_value()} engine={acc0}")
    # 拖伴奏滑杆（未开对照播放也应生效）
    page.evaluate(
        "() => { const el = document.querySelector(\"input[aria-label='伴奏音量']\");"
        " const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
        " s.call(el, '0.4'); el.dispatchEvent(new Event('input', { bubbles: true })); }")
    page.wait_for_timeout(200)
    vol = page.evaluate("() => import('/src/audio/AudioEngine.ts').then(m => m.audioEngine.getVolume())")
    check("拖伴奏滑杆 → audioEngine.setVolume 生效", abs(vol - 0.4) < 0.001, f"getVolume={vol}")

    # 拖录音滑杆 → WebAudio 增益按平方曲线×3（0.5 → 0.75），元素 volume 固定 1
    page.evaluate(
        "() => { const el = document.querySelector(\"input[aria-label='录音音量']\");"
        " const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
        " s.call(el, '0.5'); el.dispatchEvent(new Event('input', { bubbles: true })); }")
    page.wait_for_timeout(200)
    # 鲁棒断言（不依赖模块实例）：走增益路径时元素 volume 恒 1；fallback 直控会变 0.5
    el_vol = page.evaluate("() => document.querySelector('.pdeck audio').volume")
    check("录音走 WebAudio 增益路径（滑杆 0.5 而元素 volume 恒 1）", el_vol == 1, f"el.volume={el_vol}")
    gain = page.evaluate(
        "() => import('/src/audio/recGraph.ts').then(m => {"
        " const el = document.querySelector('.pdeck audio');"
        " const g = m._recGainForTest(el);"
        " return g ? { gain: g.gain.value } : null; })")
    check("录音元素已接 WebAudio 增益图", gain is not None)
    if gain:
        check("录音滑杆 0.5 → 增益 0.75（平方曲线×3）", abs(gain["gain"] - 0.75) < 0.001, str(gain))

    # 进度条尺寸硬断言（回归哨兵：进度条不塌成 0 宽）
    box = page.locator(".pdeck-track").bounding_box()
    check("进度条不塌（宽≥300 高10）", bool(box) and box["width"] >= 300 and box["height"] == 10, str(box))

    # ---- B. 图例 3 项三态 ----
    legend = page.locator(".chart-legend span").all_inner_texts()
    check("图例 3 项", len(legend) == 3, str(legend))
    check("图例文案（命中/偏音/漏音）",
          any("命中" in t for t in legend) and any("偏音" in t for t in legend) and any("漏音" in t for t in legend),
          str(legend))
    check("旧图例项（实测·准/目标音符）已删",
          page.locator(".chart-legend .sw.in").count() == 0 and page.locator(".chart-legend .sw.note").count() == 0)
    sw_hit = page.locator(".chart-legend .sw.hit").evaluate("el => getComputedStyle(el).backgroundColor")
    check("sw.hit = song accent 实心", sw_hit == LUMIERE_ACCENT, sw_hit)
    sw_off = page.locator(".chart-legend .sw.off").evaluate("el => getComputedStyle(el).backgroundColor")
    check("sw.off = 偏音红", sw_off == OFF_RED, sw_off)
    sw_miss = page.locator(".chart-legend .sw.miss").evaluate("el => getComputedStyle(el).backgroundImage")
    check("sw.miss = 45° 斜纹", "repeating-linear-gradient" in sw_miss and "45deg" in sw_miss, sw_miss)

    # ---- C. canvas 三态着色列采样（注入分组：i%3 → 命中/偏音/漏音） ----
    notes_meta = page.evaluate(
        "() => import('/src/songs/index.ts').then(async m => {"
        " const { SONGS, loadSong } = m;"
        " const { timeline } = await loadSong(SONGS.find(s => s.id === 'lumiere'));"
        " return timeline.notes.map(n => ({ time: n.time, duration: n.duration })); })")
    hit_col = off_col = miss_col = None
    for i, n in enumerate(notes_meta):
        col = page.evaluate(COLUMN_SCAN, note_x(page, n, info["end"]))
        if i % 3 == 0 and hit_col is None: hit_col = col
        if i % 3 == 1 and off_col is None: off_col = col
        if i % 3 == 2 and miss_col is None: miss_col = col
        if hit_col and off_col and miss_col: break

    check("命中音符列：accent 高亮像素出现", bool(hit_col and hit_col["accent"]), str(hit_col))
    check("偏音音符列：红像素出现", bool(off_col and off_col["red"]), str(off_col))
    check("漏音音符列：斜纹明暗交替（maxR-minR>40 且有红）",
          bool(miss_col and miss_col["maxR"] - miss_col["minR"] > 40 and miss_col["maxR"] > 90), str(miss_col))
    check("漏音音符列：无 accent 高亮（没吹到不会亮）", bool(miss_col and not miss_col["accent"]), str(miss_col))

    check("页面无 JS 错误", not errors, str(errors[:3]))

    # ---- 截图存档 ----
    page.screenshot(path=f"{OUT_DIR}/_result_page_full.png", full_page=True)
    page.locator(".chart-section").screenshot(path=f"{OUT_DIR}/_result_pitch_chart.png")

    # ---- D. 窄屏 700px：音量区可换行但不丢控件 ----
    page.set_viewport_size({"width": 700, "height": 1000})
    page.wait_for_timeout(400)
    both = page.locator(".pdeck-vol").evaluate_all("els => els.map(e => e.getBoundingClientRect().width > 0)")
    check("窄屏双音量组仍可见", both == [True, True], str(both))
    grid_cols = page.evaluate(
        "() => getComputedStyle(document.querySelector('.result-grid')).gridTemplateColumns.split(' ').length")
    check("窄屏 result-grid 单列", grid_cols == 1, str(grid_cols))

    browser.close()

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL -> {fails}")
sys.exit(0 if not fails else 1)

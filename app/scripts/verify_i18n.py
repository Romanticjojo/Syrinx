# -*- coding: utf-8 -*-
"""验收中英文切换（i18n，t_830700ea）。

默认 zh 零变化 + .lang-switch 分段切换 + localStorage 记忆 + manifest 双语
字段（descriptionEn/keyLabelEn/tagsEn 生效、titleEn 缺失回落原 title）+
html lang/meta 同步 + 全程零 pageerror。

用法: python verify_i18n.py <port>
前置: dev server 已起；Chromium 走 %LOCALAPPDATA%/ms-playwright。
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

PORT = sys.argv[1]
BASE = f"http://localhost:{PORT}"
CHROME = rf"C:\Users\54219\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe"
SHOTS = pathlib.Path(r"D:\LLM_work\syrinx-i18n\shots")
FLOWER_MANIFEST = pathlib.Path(r"D:\Syrinx\app\public\songs\flower-dance\manifest.json")

results = []
page_errors = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def enter_app(page):
    """reload 后 Intro 覆盖层重出（内存态）：统一走 JS click 进应用"""
    page.wait_for_timeout(600)
    page.evaluate("document.querySelector('.intro-enter')?.click()")
    page.wait_for_timeout(1000)


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=CHROME,
        headless=True,
        args=["--autoplay-policy=no-user-gesture-required"],
    )
    # 新 context = 无 localStorage：验证默认 zh、行为零变化
    context = browser.new_context(viewport={"width": 1600, "height": 900})
    page = context.new_page()
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(800)
    enter_app(page)

    # ---- 1) 默认中文（新 context 无存储）----
    check("默认中文：顶栏「曲库」", page.locator(".home-nav .nav-pill", has_text="曲库").count() == 1)
    check("默认中文：顶栏「关于」", page.locator(".home-nav .nav-pill", has_text="关于").count() == 1)
    check("默认中文：「为你精选」", page.locator(".home-section h3", has_text="为你精选").count() == 1)
    check("默认 html lang=zh-CN", page.evaluate("document.documentElement.lang") == "zh-CN", page.evaluate("document.documentElement.lang"))
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / "home-zh.png"))

    # ---- 2) .lang-switch 结构 ----
    ls = page.locator(".lang-switch")
    check("首页顶栏有 .lang-switch", ls.count() == 1, f"count={ls.count()}")
    seg_texts = page.locator(".lang-switch .seg").all_inner_texts()
    check("两段「中 / EN」", seg_texts == ["中", "EN"], str(seg_texts))
    zh_on = page.evaluate("document.querySelector('.lang-switch .seg')?.classList.contains('on')")
    check("默认「中」段 on", zh_on is True)
    kicker_zh = page.locator(".home-hero .hero-slide.is-active .kicker").inner_text(timeout=2000)
    check("默认中文：hero 标签中文", kicker_zh == "钢琴 · 节拍 · 首发正式曲", kicker_zh)

    # ---- 3) 点 EN：首页整体切英文 ----
    page.locator(".lang-switch .seg", has_text="EN").click()
    page.wait_for_timeout(400)
    check("点 EN：顶栏变 Library", page.locator(".home-nav .nav-pill", has_text="Library").count() == 1)
    check("点 EN：顶栏变 About", page.locator(".home-nav .nav-pill", has_text="About").count() == 1)
    check("点 EN：Featured for You", page.locator(".home-section h3", has_text="Featured for You").count() == 1)
    check("点 EN：html lang=en", page.evaluate("document.documentElement.lang") == "en")
    check("点 EN：localStorage syrinx_lang=en", page.evaluate("localStorage.getItem('syrinx_lang')") == "en")
    kicker = page.locator(".home-hero .hero-slide.is-active .kicker").inner_text(timeout=2000)
    # .kicker 有 text-transform:uppercase（既有设计），inner_text 返回渲染后文本
    check("点 EN：hero 标签变英文（Piano · Beats · Debut）", kicker.upper() == "PIANO · BEATS · DEBUT", kicker)
    n_adv = page.locator(".song-card .diff span", has_text="●●● Advanced").count()
    check("点 EN：曲库卡难度标签 ●●● Advanced", n_adv >= 1, f"count={n_adv}")
    page.screenshot(path=str(SHOTS / "home-en.png"))

    # ---- 4) 刷新仍英文（localStorage 持久化）----
    page.reload(wait_until="networkidle")
    enter_app(page)
    check("刷新后仍英文 Library", page.locator(".home-nav .nav-pill", has_text="Library").count() == 1)
    check("刷新后 html lang=en", page.evaluate("document.documentElement.lang") == "en")

    # ---- 5) titleEn 缺失回落原 title（临时改 manifest 验证后还原）----
    # 现状所有 manifest 均未提供 titleEn：英文态曲库卡标题 = 原 title（回落生效）
    flower_title = page.evaluate(
        "[...document.querySelectorAll('.song-card .t')].map(e => e.textContent.trim()).find(t => t.includes('Flower Dance'))"
    )
    check("无 titleEn 时英文态回落原 title", flower_title == "Flower Dance", str(flower_title))
    original = FLOWER_MANIFEST.read_text(encoding="utf-8")
    try:
        data = json.loads(original)
        data["titleEn"] = "Flower Dance EN-TEST"
        FLOWER_MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        page.reload(wait_until="networkidle")
        enter_app(page)
        flower_title_en = page.evaluate(
            "[...document.querySelectorAll('.song-card .t')].map(e => e.textContent.trim()).find(t => t.includes('Flower Dance'))"
        )
        check("补 titleEn 后英文态显示 En 值", flower_title_en == "Flower Dance EN-TEST", str(flower_title_en))
    finally:
        FLOWER_MANIFEST.write_text(original, encoding="utf-8")
    page.reload(wait_until="networkidle")
    enter_app(page)
    flower_title_back = page.evaluate(
        "[...document.querySelectorAll('.song-card .t')].map(e => e.textContent.trim()).find(t => t.includes('Flower Dance'))"
    )
    check("还原 manifest 后回落原 title", flower_title_back == "Flower Dance", str(flower_title_back))

    # ---- 6) 预览页：info 区英文（descriptionEn/keyLabelEn）+ 预览页也有切换按钮 ----
    page.locator(".song-card").first.click()
    page.wait_for_timeout(2000)
    check("预览页有 .lang-switch", page.locator(".preview .lang-switch").count() == 1)
    desc = page.locator(".album-desc").inner_text(timeout=3000)
    check("预览页 descriptionEn 生效", desc.startswith("A modern classic of piano and strings"), desc[:60])
    key_value = page.evaluate("document.querySelector('.spec-value')?.textContent")
    check("预览页 keyLabelEn 生效", key_value == "D♭ major / B♭ minor (5 flats)", str(key_value))
    page.screenshot(path=str(SHOTS / "preview-en.png"))

    # ---- 7) 切回中：立即恢复中文 + lang=zh-CN ----
    page.locator(".lang-switch .seg", has_text="中").click()
    page.wait_for_timeout(400)
    check("切回中：预览页「曲谱预览」恢复", page.locator("h3", has_text="曲谱预览").count() == 1)
    check("切回中：html lang=zh-CN", page.evaluate("document.documentElement.lang") == "zh-CN")
    check("切回中：localStorage syrinx_lang=zh", page.evaluate("localStorage.getItem('syrinx_lang')") == "zh")
    desc_zh = page.locator(".album-desc").inner_text(timeout=3000)
    check("切回中：description 恢复中文", desc_zh.startswith("DJ OKAWARI"), desc_zh[:40])

    browser.close()

check("全程 pageerror 为零", len(page_errors) == 0, "; ".join(page_errors[:3]))

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} PASS ===")
sys.exit(1 if fails else 0)

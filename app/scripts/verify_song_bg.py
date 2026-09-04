# -*- coding: utf-8 -*-
"""验收两首新曲的动态背景：曲库悬停视频 / 预览页背景视频 / 演奏页背景视频。
用法: python verify_song_bg.py <port> <song-slug> <SongTitle>
前置: dev server 已起；Chromium 走 %LOCALAPPDATA%/ms-playwright。
"""
import sys
from playwright.sync_api import sync_playwright

PORT, SLUG, TITLE = sys.argv[1], sys.argv[2], sys.argv[3]
BASE = f"http://localhost:{PORT}"
CHROME = rf"C:\Users\54219\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe"

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True,
        args=["--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.intro-enter')?.click()")
    page.wait_for_timeout(1200)

    # 1) 曲库卡片悬停视频
    card = page.locator(f".song-card").filter(has_text=TITLE).first
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    card.hover()
    page.wait_for_timeout(1500)
    n_video = card.locator("video.art-preview").count()
    check("卡片悬停视频挂载", n_video == 1, f"count={n_video}")
    if n_video:
        v = card.locator("video.art-preview").first
        visible = v.evaluate("el => getComputedStyle(el).visibility === 'visible'")
        playing = v.evaluate("el => !el.paused && el.currentTime > 0")
        src_ok = v.evaluate("el => el.currentSrc", "").find(SLUG) is not None
        check("悬停视频可见", visible)
        check("悬停视频在播", playing, f"paused={not playing}")
        check("悬停视频源正确", src_ok, SLUG)
    page.mouse.move(10, 10)

    # 2) 预览页背景视频
    card.click()
    page.wait_for_timeout(2500)
    pv = page.locator(".preview-bg-media").first
    tag = pv.evaluate("el => el.tagName.toLowerCase()")
    check("预览页背景是视频", tag == "video", tag)
    if tag == "video":
        src_ok = pv.evaluate("el => el.currentSrc", "").find(SLUG) is not None
        playing = pv.evaluate("el => !el.paused && el.currentTime > 0")
        cov = pv.evaluate("el => getComputedStyle(el).objectFit")
        check("预览视频源正确", src_ok, SLUG)
        check("预览视频在播", playing)
        check("预览视频 cover 铺满", cov == "cover", cov)

    # 3) 演奏页背景视频 + 垫底色
    page.evaluate("document.querySelector('.btn-play-big')?.click()")
    page.wait_for_timeout(2000)
    bg = page.locator("video.perform-bg").first
    check("演奏页背景视频存在", bg.count() == 1)
    src_ok = bg.evaluate("el => el.currentSrc", "").find(SLUG) is not None
    pad = bg.evaluate("el => getComputedStyle(el).backgroundColor")
    disp = bg.evaluate("el => getComputedStyle(el).display")
    check("演奏页视频源正确", src_ok, SLUG)
    check("演奏页视频显示", disp == "block", disp)
    check("演奏页垫底色已设", pad not in ("rgba(0, 0, 0, 0)", ""), pad)
    page.evaluate("document.querySelector('.ov-start')?.click()")
    page.wait_for_timeout(3000)
    playing = bg.evaluate("el => !el.paused && el.currentTime > 0")
    check("演奏页视频在播", playing)

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results)-len(fails)}/{len(results)} PASS ===")
sys.exit(1 if fails else 0)

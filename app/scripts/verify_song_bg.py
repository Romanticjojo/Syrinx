# -*- coding: utf-8 -*-
"""验收动态背景曲目：曲库悬停视频 / 预览页背景视频 / 演奏页背景视频。

manifest 驱动：自动读 public/songs/<slug>/manifest.json 的 playOnce /
backgroundPadColor / hoverVideoUrl / backgroundVideoUrl 分支断言——
loop 曲目（缺省）：三处视频须 loop，演奏页主视频垫底色 == manifest 精确值；
playOnce 曲目（如 expedition-33）：三处视频 loop=false，演奏页多一层
perform-bg-blur 模糊垫底层（cover+blur46px），主视频不留纯色垫底，播放一次后定格末帧。

用法: python verify_song_bg.py <port> <song-slug> <SongTitle>
覆盖曲目: python verify_song_bg.py <port> luv-letter "Luv Letter"  (回归 loop)
          python verify_song_bg.py <port> flower-dance "Flower Dance"  (loop 新曲)
          python verify_song_bg.py <port> expedition-33 "Expedition 33"  (playOnce)
前置: dev server 已起；Chromium 走 %LOCALAPPDATA%/ms-playwright。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PORT, SLUG, TITLE = sys.argv[1], sys.argv[2], sys.argv[3]
BASE = f"http://localhost:{PORT}"
CHROME = rf"C:\Users\54219\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe"
MANIFEST = json.loads(
    Path(rf"D:\Syrinx\app\public\songs\{SLUG}\manifest.json").read_text(encoding="utf-8")
)
PLAY_ONCE = bool(MANIFEST.get("playOnce"))
HOVER_ONCE = bool(MANIFEST.get("hoverPlayOnce"))
PAD = MANIFEST.get("backgroundPadColor")
HOVER_URL = MANIFEST.get("hoverVideoUrl")
BG_URL = MANIFEST.get("backgroundVideoUrl")
WANT_LOOP = not PLAY_ONCE

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def ended_hold(v):
    """playOnce 视频应已播完并定格末帧（浏览器对非 loop 视频的原生行为）。"""
    st = v.evaluate(
        "el => ({ended: el.ended, t: el.currentTime, d: el.duration, paused: el.paused})"
    )
    return st["ended"] and st["t"] > 0.3 and abs(st["d"] - st["t"]) < 0.25, st


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=CHROME,
        headless=True,
        args=["--autoplay-policy=no-user-gesture-required"],
    )
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.intro-enter')?.click()")
    page.wait_for_timeout(1200)

    # ---- 1) 曲库卡片悬停视频 ----
    card = page.locator(".song-card").filter(has_text=TITLE).first
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
        cur_src = v.evaluate("el => el.currentSrc")
        src_ok = SLUG in cur_src and (HOVER_URL is None or cur_src.endswith(HOVER_URL.split("/")[-1]))
        loop_ok = v.evaluate("el => el.loop") == (not (PLAY_ONCE or HOVER_ONCE))
        check("悬停视频可见", visible)
        check("悬停视频在播", playing, f"paused={not playing}")
        check("悬停视频源=hover 文件", src_ok, cur_src.split("/")[-1])
        check(f"悬停视频 loop={'开' if WANT_LOOP else '关(playOnce)'}", loop_ok)
    page.mouse.move(10, 10)

    # ---- 2) 预览页背景视频 ----
    card.click()
    page.wait_for_timeout(2500)
    pv = page.locator(".preview-bg-media").first
    tag = pv.evaluate("el => el.tagName.toLowerCase()")
    check("预览页背景是视频", tag == "video", tag)
    if tag == "video":
        cur_src = pv.evaluate("el => el.currentSrc")
        src_ok = SLUG in cur_src and (BG_URL is None or cur_src.endswith(BG_URL.split("/")[-1]))
        playing = pv.evaluate("el => !el.paused && el.currentTime > 0")
        cov = pv.evaluate("el => getComputedStyle(el).objectFit")
        loop_ok = pv.evaluate("el => el.loop") == WANT_LOOP
        check("预览视频源正确", src_ok, cur_src.split("/")[-1])
        check("预览视频在播", playing, f"paused={not playing}")
        check("预览视频 cover 铺满", cov == "cover", cov)
        check(f"预览视频 loop={'开' if WANT_LOOP else '关(playOnce)'}", loop_ok)
        if PLAY_ONCE:
            try:
                page.wait_for_function(
                    "el => el.ended", arg=pv.element_handle(), timeout=8000
                )
                ok, st = ended_hold(pv)
            except Exception:
                ok, st = False, pv.evaluate(
                    "el => ({ended: el.ended, t: el.currentTime, d: el.duration, paused: el.paused})"
                )
            check("playOnce 预览播完定格末帧", ok, str(st))

    # ---- 3) 演奏页背景视频 + 垫底层 ----
    page.evaluate("document.querySelector('.btn-play-big')?.click()")
    page.wait_for_timeout(2000)
    if PLAY_ONCE:
        blur_v = page.locator("video.perform-bg-blur").first
        main_v = page.locator("video.perform-bg:not(.perform-bg-blur)").first
        check("playOnce 模糊垫底层挂载", blur_v.count() == 1, f"count={blur_v.count()}")
        if blur_v.count() == 1:
            b_src = blur_v.evaluate("el => el.currentSrc")
            b_fit = blur_v.evaluate("el => getComputedStyle(el).objectFit")
            b_flt = blur_v.evaluate("el => getComputedStyle(el).filter")
            b_vis = blur_v.evaluate("el => getComputedStyle(el).display")
            check("垫底层源=主视频源", SLUG in b_src, b_src.split("/")[-1])
            check("垫底层 cover+blur46px", b_fit == "cover" and "blur(46px)" in b_flt, f"fit={b_fit} flt={b_flt[:60]}")
            check("垫底层可见", b_vis == "block", b_vis)
        bg = main_v
    else:
        bg = page.locator("video.perform-bg").first
    check("演奏页主背景视频存在", bg.count() == 1, f"count={bg.count()}")
    src_ok = SLUG in bg.evaluate("el => el.currentSrc")
    pad = bg.evaluate("el => getComputedStyle(el).backgroundColor")
    disp = bg.evaluate("el => getComputedStyle(el).display")
    loop_ok = bg.evaluate("el => el.loop") == WANT_LOOP
    check("演奏页视频源正确", src_ok)
    check("演奏页视频显示", disp == "block", disp)
    check(f"演奏页视频 loop={'开' if WANT_LOOP else '关(playOnce)'}", loop_ok)
    if PLAY_ONCE:
        check("playOnce 主视频无纯色垫底(交给模糊层)", pad == "rgba(0, 0, 0, 0)", pad)
    else:
        want = PAD or "rgba(0, 0, 0, 0)"
        check("演奏页垫底色==manifest 精确值", pad == want, f"{pad} vs {want}")
    page.evaluate("document.querySelector('.ov-start')?.click()")
    page.wait_for_timeout(3500)
    st = bg.evaluate("el => ({paused: el.paused, t: el.currentTime, ended: el.ended})")
    ran = (st["t"] > 0.2) and (st["paused"] is False or st["ended"] is True)
    check("演奏页视频已播放", ran, str(st))

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} PASS ===")
sys.exit(1 if fails else 0)

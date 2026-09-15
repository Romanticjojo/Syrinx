# -*- coding: utf-8 -*-
"""验收曲库英雄位 Netflix 式轮播（t_743b9839）。

三曲广告页（luv-letter / interstellar / expedition-33）crossfade 切换：
箭头循环切换、指示点直达+accent 点亮、键盘 ←/→、Enter 进详情、
自动轮播 7s、hover 暂停、曲库网格/关于弹窗回归。

用法: python verify_hero_carousel.py <port>
前置: dev server 已起；Chromium 走 %LOCALAPPDATA%/ms-playwright。
"""
import sys

from playwright.sync_api import sync_playwright

PORT = sys.argv[1]
BASE = f"http://localhost:{PORT}"
CHROME = rf"C:\Users\54219\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe"
FADE_WAIT = 900          # crossfade 600ms + 余量
AUTOPLAY_WAIT = 8500     # AUTOPLAY_MS 7000 + 余量（放宽到 8s 以上）

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def hero_title(page):
    loc = page.locator(".home-hero .hero-slide.is-active h1")
    return loc.inner_text(timeout=2000) if loc.count() else "<none>"


def dot_color(page, i):
    loc = page.locator(".home-hero .hero-dot").nth(i)
    if loc.count() == 0:
        return "<none>"
    return loc.evaluate("el => getComputedStyle(el, '::after').backgroundColor")


def safe_click(loc):
    """元素缺失时快速返回（让后续断言 FAIL），不等 30s 超时。"""
    if loc.count() == 0:
        return False
    loc.click(timeout=3000)
    return True


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

    # ---- 1) 初始渲染：仅当前张挂载，luv-letter 可见，无离场张 ----
    n_slides = page.locator(".home-hero .hero-slide").count()
    check("初始仅挂载当前张(1)", n_slides == 1, f"count={n_slides}")
    check("初始无离场张", page.locator(".hero-slide.is-leaving").count() == 0)
    check("初始显示 Luv Letter", hero_title(page) == "Luv Letter", hero_title(page))
    n_dots = page.locator(".home-hero .hero-dot").count()
    check("指示点 3 枚", n_dots == 3, f"count={n_dots}")
    c0 = dot_color(page, 0)
    check("当前点以曲目 accent 点亮", c0 == "rgb(95, 184, 168)", c0)  # #5fb8a8

    # ---- 2) 右箭头循环：luv → interstellar → expedition → luv ----
    safe_click(page.locator(".home-hero .hero-arrow.next"))
    n_mid = page.locator(".home-hero .hero-slide").count()
    check("切换瞬间仅两张(当前+离场)", n_mid == 2, f"count={n_mid}")
    page.wait_for_timeout(FADE_WAIT)
    check("右箭头→Interstellar", hero_title(page) == "Interstellar", hero_title(page))
    safe_click(page.locator(".home-hero .hero-arrow.next"))
    page.wait_for_timeout(FADE_WAIT)
    check("再右→Lumière", hero_title(page) == "Lumière", hero_title(page))
    c2 = dot_color(page, 2)
    check("expedition 当前点点亮(#b9a0d8)", c2 == "rgb(185, 160, 216)", c2)
    safe_click(page.locator(".home-hero .hero-arrow.next"))
    page.wait_for_timeout(FADE_WAIT)
    check("末张再右循环回 Luv Letter", hero_title(page) == "Luv Letter", hero_title(page))
    check("fade 完成后离场张卸载", page.locator(".hero-slide.is-leaving").count() == 0)

    # ---- 3) 左箭头反向循环：luv → expedition ----
    safe_click(page.locator(".home-hero .hero-arrow.prev"))
    page.wait_for_timeout(FADE_WAIT)
    check("首张再左反向循环→Lumière", hero_title(page) == "Lumière", hero_title(page))

    # ---- 4) 指示点直达 ----
    safe_click(page.locator(".home-hero .hero-dot").nth(1))
    page.wait_for_timeout(FADE_WAIT)
    check("指示点直达 Interstellar", hero_title(page) == "Interstellar", hero_title(page))
    on_idx = page.evaluate(
        "[...document.querySelectorAll('.home-hero .hero-dot')].findIndex(d => d.classList.contains('on'))"
    )
    check("当前指示点高亮下标=1", on_idx == 1, f"idx={on_idx}")

    # ---- 5) 键盘 ←/→（hero 获得焦点时）----
    page.focus(".home-hero")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(FADE_WAIT)
    check("键盘 → 切到 Lumière", hero_title(page) == "Lumière", hero_title(page))
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(FADE_WAIT)
    check("键盘 ← 切回 Interstellar", hero_title(page) == "Interstellar", hero_title(page))

    # ---- 6) Enter 进详情 + 返回恢复（重挂载回首张）----
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)
    in_preview = page.locator(".preview").count() == 1 and page.locator(".home-hero").count() == 0
    check("Enter 进预览页", in_preview)
    safe_click(page.locator(".back-ghost"))
    page.wait_for_timeout(1200)
    back_ok = page.locator(".home-hero").count() == 1 and hero_title(page) == "Luv Letter"
    check("返回曲库英雄位恢复", back_ok, hero_title(page))

    # ---- 7) 自动轮播（鼠标移开避免 hover 暂停）----
    page.mouse.move(10, 10)
    page.wait_for_timeout(AUTOPLAY_WAIT)
    check("7s+ 自动切到下一张", hero_title(page) == "Interstellar", hero_title(page))

    # ---- 8) hover 暂停 ----
    page.locator(".home-hero").hover()
    before = hero_title(page)
    page.wait_for_timeout(AUTOPLAY_WAIT)
    check("hover 期间 8s+ 不切换", hero_title(page) == before, f"{before} -> {hero_title(page)}")
    page.mouse.move(10, 10)

    # ---- 9) 回归：曲库网格 + 关于弹窗 ----
    n_cards = page.locator(".song-card").count()
    check("曲库网格卡片数不变(6)", n_cards == 6, f"count={n_cards}")
    safe_click(page.locator(".nav-pill", has_text="关于"))
    page.wait_for_timeout(400)
    about_open = page.locator('.about[role="dialog"]').count() == 1
    check("关于弹窗可打开", about_open)
    safe_click(page.locator(".about-close"))
    page.wait_for_timeout(400)
    check("关于弹窗可关闭", page.locator('.about[role="dialog"]').count() == 0)

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} PASS ===")
sys.exit(1 if fails else 0)

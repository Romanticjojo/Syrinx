#!/usr/bin/env python3
"""t_e031ae5d 手机端四案修复 + 触屏封面动画 Playwright 验收。

用法:
  python app/scripts/verify_mobile_fixes.py --only all --port 5173
  python app/scripts/verify_mobile_fixes.py --only bug1 --port 5174

断言（与任务书验收标准一一对应）:
  bug1  390/360/320 三档视口起奏后 .pitch-meter 与谱面 SVG「可见区」零交集；
        1280 桌面 pitch-meter 仍可见可用（回归）
  bug2  预览页谱面区域 CDP 触摸上滑 doc scrollTop 移动>200 + 鼠标滚轮跟随；
        演奏页 .sheet-container overscroll 仍 contain（回归）
  bug3  底部切曲 / 首页长滚进详情，doc scrollTop==0（谱面加载后复核仍 0）
  bug4  exp33 详情页切换控件存在；切钢琴谱 SVG 渲染（宽高>0、glyph>50）；
        切回长笛谱正常；无 console error / pageerror
  bug5  (hover:none)+(pointer:coarse) 语境卡片进视口自动播放（playing|ended），
        hoverPlayOnce 曲播完定格（ended 后 currentTime 不变）；桌面 hover 回归
  全程  pageerror==0

入口链（全 JS click）: .intro-enter → 曲库卡 .song-card → .btn-play-big → .ov-start
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import Locator, Page, sync_playwright

CHROME_DEFAULT = r"C:\Users\54219\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe"
SHOTS_DEFAULT = r"D:/LLM_work/syrinx-mobile-fixes/shots"
LAUNCH_ARGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
]
MOBILE_VIEWPORTS = [(390, 844), (360, 780), (320, 720)]
# (hover:none)+(pointer:coarse) 注入：matchMedia 覆写（组件挂载时读取，确定性最高）
COARSE_INIT = """
(() => {
  const orig = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    const m = orig(q);
    if (String(q).includes('(hover: none)') && String(q).includes('pointer: coarse')) {
      const wrapped = Object.create(m);
      Object.defineProperty(wrapped, 'matches', { value: true });
      return wrapped;
    }
    return m;
  };
})();
"""

RESULTS: list[tuple[bool, str]] = []
PAGE_ERRORS: list[str] = []
CONSOLE_ERRORS: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    RESULTS.append((ok, f"{label}{(' —— ' + detail) if detail else ''}"))
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" —— {detail}" if detail else ""))
    return ok


def watch(page: Page) -> None:
    page.on("pageerror", lambda e: PAGE_ERRORS.append(f"{page.url}: {e}"))
    page.on(
        "console",
        lambda m: CONSOLE_ERRORS.append(f"{page.url}: {m.text}") if m.type == "error" else None,
    )


def shot(page: Page, shots: Path, name: str) -> None:
    shots.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(shots / f"{name}.png"))


def entry_home(page: Page, base: str) -> None:
    """打开首页并穿过入场动画（每次 goto 都会重放 intro，统一在此处理）"""
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_selector(".intro-enter", timeout=15000)
    page.click(".intro-enter")
    page.wait_for_selector(".song-card", timeout=15000)


def entry_preview(page: Page, base: str, card_title: str | None = None) -> None:
    """首页 → 详情页（card_title 传曲名前缀，None 取首卡）"""
    entry_home(page, base)
    card = (
        page.locator(f".song-card[title^='{card_title}']")
        if card_title
        else page.locator(".song-card").first
    )
    card.click()
    page.wait_for_selector(".preview", timeout=15000)


def entry_perform(page: Page, base: str, card_title: str | None = None) -> None:
    """详情页 → 演奏页起奏（倒数结束进入 performing）"""
    entry_preview(page, base, card_title)
    page.click(".btn-play-big")
    page.wait_for_selector(".ov-start", timeout=45000)  # 伴奏解码/合成
    page.click(".ov-start")
    page.wait_for_selector(".perform-overlay.countdown", state="detached", timeout=20000)


def overlap_area(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    return ix * iy


def visible_svg_rect(page: Page) -> dict | None:
    """谱面 SVG rect 裁剪到 .sheet-container 可视框（OSMD 整谱一张高 SVG，
    bounding rect 未裁剪全高，直接求交恒非零——语义是「不遮挡可见部分」）"""
    return page.evaluate(
        """() => {
        const svg = document.querySelector('.sheet-container svg');
        const cont = document.querySelector('.sheet-container');
        if (!svg || !cont) return null;
        const s = svg.getBoundingClientRect(), c = cont.getBoundingClientRect();
        const top = Math.max(s.top, c.top), bottom = Math.min(s.bottom, c.bottom);
        return { x: s.left, y: top, width: s.width, height: Math.max(0, bottom - top) };
    }"""
    )


# ---------------- bug1：手机端音高条零遮谱 + 桌面回归 ----------------


def run_bug1(page: Page, base: str, shots: Path) -> None:
    for w, h in MOBILE_VIEWPORTS:
        page.set_viewport_size({"width": w, "height": h})
        entry_perform(page, base)
        page.wait_for_selector(".pitch-meter.active", timeout=20000)
        time.sleep(0.4)  # 等进场动画落定
        meter = page.locator(".pitch-meter").bounding_box()
        vis_svg = visible_svg_rect(page)
        tag = f"{w}x{h}"
        if meter is None or vis_svg is None:
            check(False, f"bug1/{tag}: rect 采集失败", f"meter={meter} svg={vis_svg}")
            continue
        area = overlap_area(meter, vis_svg)
        check(
            area == 0.0,
            f"bug1/{tag}: pitch-meter 与谱面可见区零交集",
            f"交集面积={area:.0f}px² meter=({meter['x']:.0f},{meter['y']:.0f},{meter['width']:.0f}x{meter['height']:.0f})",
        )
        shot(page, shots, f"bug1_perform_{tag}")
    # 桌面回归：1280 视口悬浮条可见可用
    page.set_viewport_size({"width": 1280, "height": 800})
    entry_perform(page, base)
    page.wait_for_selector(".pitch-meter.active", timeout=20000)
    time.sleep(0.4)
    meter = page.locator(".pitch-meter").bounding_box()
    vp = page.viewport_size
    ok = (
        meter is not None
        and meter["x"] >= 0
        and meter["y"] >= 0
        and meter["x"] + meter["width"] <= vp["width"]
        and meter["y"] + meter["height"] <= vp["height"]
    )
    check(ok, "bug1/1280x800: 桌面 pitch-meter 可见且完整在视口内（回归）", str(meter))
    shot(page, shots, "bug1_perform_desktop_1280")


# ---------------- bug2：预览页滚动链 + 演奏页 contain 回归 ----------------


def cdp_swipe_up(cdp, x: float, y: float, distance: float) -> None:
    """CDP 触摸上滑手势（产生真实滚动链传播）"""
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    steps = 8
    for i in range(1, steps + 1):
        cdp.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchMove",
                "touchPoints": [{"x": x, "y": y - distance * i / steps}],
            },
        )
        time.sleep(0.016)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def run_bug2(page: Page, base: str, shots: Path) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    entry_preview(page, base)
    page.wait_for_selector(".sheet-container svg", timeout=30000)

    def in_viewport_point() -> tuple[float, float]:
        """谱面区滚入视口后，返回视口内的作用点（中心偏上）"""
        page.evaluate("document.querySelector('.sheet-container').scrollIntoView({block: 'start'})")
        time.sleep(0.3)
        box = page.locator(".sheet-container").bounding_box()
        cx = box["x"] + box["width"] / 2
        cy = min(box["y"] + 200, 844 - 40)
        return cx, max(cy, 40)

    cx, cy = in_viewport_point()
    before = page.evaluate("document.scrollingElement.scrollTop")
    cdp = page.context.new_cdp_session(page)
    cdp_swipe_up(cdp, cx, cy, 500)
    time.sleep(1.2)  # 等惯性滚动收敛
    after = page.evaluate("document.scrollingElement.scrollTop")
    check(
        after - before > 200,
        "bug2: 预览页谱面区域触摸上滑页面跟随",
        f"scrollTop 移动={after - before:.0f}（起点 {before:.0f}）",
    )
    # 鼠标滚轮在谱面上同样滚动页面
    cx, cy = in_viewport_point()
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, 600)
    time.sleep(0.6)
    after_wheel = page.evaluate("document.scrollingElement.scrollTop")
    check(after_wheel > 50, "bug2: 预览页谱面上鼠标滚轮滚动页面", f"scrollTop={after_wheel:.0f}")
    shot(page, shots, "bug2_preview_after_swipe")
    # 演奏页回归：谱面容器滚动语义仍 contain
    entry_perform(page, base)
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    ob = page.evaluate(
        "getComputedStyle(document.querySelector('.sheet-container')).overscrollBehavior"
    )
    check(ob == "contain", "bug2: 演奏页 .sheet-container overscroll 仍 contain（回归）", ob)


# ---------------- bug3：切曲/进入详情回顶 ----------------


def run_bug3(page: Page, base: str, shots: Path) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    # 场景 1：详情页底部点 more-card 切曲
    entry_preview(page, base)
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    page.evaluate("document.scrollingElement.scrollTop = 1e9")
    time.sleep(0.3)
    bottom = page.evaluate("document.scrollingElement.scrollTop")
    first_title = page.locator(".album-info h1").inner_text()
    page.locator(".more-card").first.click()
    page.wait_for_function(
        f"document.querySelector('.album-info h1').innerText !== {first_title!r}", timeout=15000
    )
    st = page.evaluate("document.scrollingElement.scrollTop")
    check(st == 0, "bug3: 详情页底部切曲后回顶", f"切前 scrollTop={bottom:.0f} 切后={st}")
    page.wait_for_selector(".sheet-container svg", timeout=30000)  # 新谱面加载
    time.sleep(0.5)
    st2 = page.evaluate("document.scrollingElement.scrollTop")
    check(st2 == 0, "bug3: 谱面加载完成后复核仍为 0", f"scrollTop={st2}")
    shot(page, shots, "bug3_preview_after_switch")
    # 场景 2：首页长滚进详情
    page.evaluate("document.scrollingElement.scrollTop = 1e9")
    time.sleep(0.2)
    page.locator(".back-ghost").first.click()  # 回曲库
    page.wait_for_selector(".song-card", timeout=15000)
    page.evaluate("document.scrollingElement.scrollTop = 1e9")
    time.sleep(0.2)
    page.locator(".song-card").first.click()
    page.wait_for_selector(".preview", timeout=15000)
    st3 = page.evaluate("document.scrollingElement.scrollTop")
    check(st3 == 0, "bug3: 首页滚动后进详情在顶部", f"scrollTop={st3}")
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    time.sleep(0.5)
    st4 = page.evaluate("document.scrollingElement.scrollTop")
    check(st4 == 0, "bug3: 场景 2 谱面加载后复核仍为 0", f"scrollTop={st4}")


# ---------------- bug4：exp33 钢琴伴奏谱集成 ----------------


def glyph_count(page: Page) -> int:
    return page.evaluate(
        """() => {
        const svg = document.querySelector('.sheet-container svg');
        if (!svg) return 0;
        return svg.querySelectorAll('use, path, g.vf-notehead').length;
    }"""
    )


def run_bug4(page: Page, base: str, shots: Path) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    entry_preview(page, base, "Lumière")
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    if not check(
        page.locator(".score-switch").count() == 1,
        "bug4: exp33 详情页出现曲谱版本切换控件",
    ):
        return
    segs = page.locator(".score-switch .seg")
    check(segs.count() == 2, "bug4: 切换控件含长笛谱/钢琴伴奏谱两段", f"segs={segs.count()}")
    segs.nth(1).click()  # 切钢琴伴奏谱
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    time.sleep(0.8)  # OSMD 渲染落定
    box = page.locator(".sheet-container svg").bounding_box()
    n = glyph_count(page)
    ok = box is not None and box["width"] > 0 and box["height"] > 0 and n > 50
    check(ok, "bug4: 钢琴伴奏谱 SVG 渲染", f"svg={box and (round(box['width']), round(box['height']))} glyph={n}")
    shot(page, shots, "bug4_piano_score")
    segs.nth(0).click()  # 切回长笛谱
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    time.sleep(0.8)
    n2 = glyph_count(page)
    check(n2 > 50, "bug4: 切回长笛谱渲染正常", f"glyph={n2}")
    shot(page, shots, "bug4_back_flute")


# ---------------- bug5：触屏自动预览 + 桌面 hover 回归 ----------------


def video_state(page: Page, card: Locator) -> str | None:
    v = card.locator(".art-preview")
    if v.count() == 0:
        return None
    return v.first.evaluate("el => el.paused ? (el.ended ? 'ended' : 'paused') : 'playing'")


def run_bug5(page: Page, base: str, shots: Path) -> None:
    # 触屏语境：matchMedia 覆写 + CDP 真实媒体特性模拟
    ctx = page.context.browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
    ctx.add_init_script(COARSE_INIT)
    tp = ctx.new_page()
    watch(tp)
    cdp = ctx.new_cdp_session(tp)
    cdp.send(
        "Emulation.setEmulatedMedia",
        {"features": [{"name": "hover", "value": "none"}, {"name": "pointer", "value": "coarse"}]},
    )
    entry_home(tp, base)
    probe = tp.evaluate("matchMedia('(hover: none) and (pointer: coarse)').matches")
    check(probe, "bug5: 触屏语境模拟生效", f"matchMedia={probe}")
    card = tp.locator(".song-card").first  # 首卡 luv-letter 进视口即自动播
    card.scroll_into_view_if_needed()
    time.sleep(1.5)  # IO 触发 + 200ms 延迟 + 视频起播
    state = video_state(tp, card)
    check(state in ("playing", "ended"), "bug5: 触屏卡片进视口自动播放", f"video={state}")
    shot(tp, shots, "bug5_touch_autoplay")
    # hoverPlayOnce 定格：exp33 卡播完 ended 后 currentTime 不变
    card_e33 = tp.locator(".song-card[title^='Lumière']")
    card_e33.scroll_into_view_if_needed()
    try:
        tp.wait_for_function(
            """() => {
            const c = document.querySelector(".song-card[title^='Lumière']");
            const v = c && c.querySelector('.art-preview');
            return v && v.ended;
        }""",
            timeout=45000,
        )
        t1 = card_e33.locator(".art-preview").first.evaluate("el => el.currentTime")
        time.sleep(0.6)
        t2 = card_e33.locator(".art-preview").first.evaluate("el => el.currentTime")
        vis = card_e33.locator(".art-preview").first.evaluate("el => getComputedStyle(el).visibility")
        check(
            abs(t1 - t2) < 0.01 and t1 > 0 and vis == "visible",
            "bug5: hoverPlayOnce 曲播完定格末帧",
            f"t={t1:.2f}s 不再推进 visibility={vis}",
        )
    except Exception:
        check(False, "bug5: hoverPlayOnce 曲播完定格末帧", "ended 未在 45s 内到达")
    shot(tp, shots, "bug5_touch_freeze")
    ctx.close()
    # 桌面回归：hover 仍触发预览播放
    page.set_viewport_size({"width": 1280, "height": 800})
    entry_home(page, base)
    dcard = page.locator(".song-card").first
    dcard.hover()
    time.sleep(1.5)
    state_d = video_state(page, dcard)
    check(state_d == "playing", "bug5: 桌面 hover 预览回归", f"video={state_d}")
    shot(page, shots, "bug5_desktop_hover")


# ---------------- desktop：1440 关键页零回归存档 ----------------


def run_desktop(page: Page, base: str, shots: Path) -> None:
    page.set_viewport_size({"width": 1440, "height": 900})
    entry_home(page, base)
    shot(page, shots, "desktop_home_1440")
    entry_preview(page, base)
    page.wait_for_selector(".sheet-container svg", timeout=30000)
    shot(page, shots, "desktop_preview_1440")
    entry_perform(page, base)
    time.sleep(0.5)
    shot(page, shots, "desktop_perform_1440")
    check(True, "desktop: 1440x900 关键页截图存档（home/preview/perform）")


RUNNERS = {
    "bug1": run_bug1,
    "bug2": run_bug2,
    "bug3": run_bug3,
    "bug4": run_bug4,
    "bug5": run_bug5,
    "desktop": run_desktop,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="all", help="bug1,bug2,bug3,bug4,bug5,desktop 或 all")
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--chrome", default=CHROME_DEFAULT)
    ap.add_argument("--shots", default=SHOTS_DEFAULT)
    args = ap.parse_args()
    base = f"http://localhost:{args.port}/"
    shots = Path(args.shots)
    only = list(RUNNERS) if args.only == "all" else [s.strip() for s in args.only.split(",")]

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chrome, args=LAUNCH_ARGS)
        context = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
        page = context.new_page()
        watch(page)
        for name in only:
            if name not in RUNNERS:
                sys.exit(f"未知分段: {name}")
            print(f"\n===== {name} =====")
            try:
                RUNNERS[name](page, base, shots)
            except Exception as e:  # 段内异常记 FAIL 继续（超时/选择器缺失等）
                check(False, f"{name}: 段内异常", repr(e))
        context.close()
        browser.close()

    print("\n===== 汇总 =====")
    for ok, label in RESULTS:
        print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    print(f"\npageerror: {len(PAGE_ERRORS)} 条; console error: {len(CONSOLE_ERRORS)} 条")
    for e in (PAGE_ERRORS + CONSOLE_ERRORS)[:10]:
        print(f"  ! {e[:200]}")
    fails = [l for ok, l in RESULTS if not ok]
    if PAGE_ERRORS:
        fails.append("存在 pageerror")
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} 通过")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())

# 预览页曲目规格条（spec-grid）几何验收：四格布局、accent 刻度、眉标/值分层、响应式降级
from playwright.sync_api import sync_playwright
import os
import sys

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
OUT_DIR = "D:/Syrinx/app/scripts"
ACCENT = "rgb(95, 184, 168)"  # luv-letter accent #5fb8a8

fails = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)

    # ---- 桌面 1600px：四格一行 ----
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto("http://localhost:5173/", wait_until="load")
    page.click(".intro-enter")
    page.wait_for_timeout(900)
    page.locator(".song-card, [class*='card']").filter(has_text="Luv Letter").first.click()
    page.wait_for_timeout(2500)
    page.locator(".info-list").scroll_into_view_if_needed()
    page.wait_for_timeout(400)

    specs = page.locator(".spec")
    check("spec count == 4", specs.count() == 4, str(specs.count()))

    labels = page.locator(".spec-cn").all_inner_texts()
    check("labels", labels == ["调性", "速度", "伴奏", "技巧要求"], str(labels))

    ens = page.locator(".spec-en").all_inner_texts()
    check("en eyebrows", ens == ["KEY", "TEMPO", "AUDIO", "TECHNIQUE"], str(ens))

    values = page.locator(".spec-value").all_inner_texts()
    check("key value", "D♭ 大调 / B♭ 小调" in values[0], values[0])
    check("tempo value has 90+BPM unit", "90" in values[1] and "BPM" in values[1], values[1])
    check("accomp value", values[2] == "钢琴伴奏", values[2])
    check("technique value", "连奏气息" in values[3], values[3])

    badge = page.locator(".spec-badge")
    check("badge text", badge.count() == 1 and "难度" in badge.inner_text() and "●●●" in badge.inner_text(),
          badge.inner_text() if badge.count() else "none")

    # 签名刻度：每格 ::before 宽 26px 高 2px、accent 色
    ticks = specs.evaluate_all(
        "els => els.map(el => { const s = getComputedStyle(el, '::before');"
        " return { w: s.width, h: s.height, bg: s.backgroundColor }; })"
    )
    check("tick size 26x2", all(t["w"] == "26px" and t["h"] == "2px" for t in ticks), str(ticks))
    check("tick accent color", all(t["bg"] == ACCENT for t in ticks), str(ticks))

    # 分层几何：eyebrow 在 value 上方；value 右缘不溢出格子；badge 不压 value
    geo = page.locator(".spec").evaluate_all(
        """els => els.map(el => {
          const box = el.getBoundingClientRect();
          const en = el.querySelector('.spec-en').getBoundingClientRect();
          const val = el.querySelector('.spec-value').getBoundingClientRect();
          const badge = el.querySelector('.spec-badge');
          return { row: box.top, col: box.left, right: box.right,
                   enBottom: en.bottom, valTop: val.top, valRight: val.right,
                   badgeLeft: badge ? badge.getBoundingClientRect().left : null,
                   badgeTop: badge ? badge.getBoundingClientRect().top : null };
        })"""
    )
    check("eyebrow above value", all(g["valTop"] >= g["enBottom"] for g in geo), str(geo))
    check("no horizontal overflow", all(g["valRight"] <= g["right"] + 1 for g in geo))
    check("badge below value", geo[3]["badgeTop"] is not None and geo[3]["badgeTop"] >= geo[3]["valTop"])
    check("4 in one row", len({round(g["row"]) for g in geo}) == 1, str([round(g["row"]) for g in geo]))

    page.screenshot(path=f"{OUT_DIR}/_spec_grid_desktop.png")

    # ---- 平板 900px：2×2 ----
    page.set_viewport_size({"width": 900, "height": 900})
    page.wait_for_timeout(400)
    geo2 = page.locator(".spec").evaluate_all(
        "els => els.map(el => { const b = el.getBoundingClientRect(); return { row: b.top, col: b.left }; })"
    )
    rows = sorted({round(g["row"] / 20) for g in geo2})
    check("tablet 2x2 rows", len(rows) == 2, str(geo2))
    # 第 3 格（新行行首）无左线，第 4 格（右列）保留
    bl = page.locator(".spec").evaluate_all(
        "els => els.map(el => getComputedStyle(el).borderLeftWidth)"
    )
    check("tablet 3rd cell no left border", bl[2] == "0px", str(bl))
    check("tablet 4th cell keeps left border", bl[3] == "1px", str(bl))

    # ---- 手机 700px：单列 ----
    page.set_viewport_size({"width": 700, "height": 900})
    page.wait_for_timeout(400)
    geo3 = page.locator(".spec").evaluate_all(
        "els => els.map(el => { const b = el.getBoundingClientRect(); return { row: b.top, col: b.left }; })"
    )
    check("mobile single column", len({round(g["row"] / 20) for g in geo3}) == 4, str(geo3))
    page.locator(".info-list").scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT_DIR}/_spec_grid_mobile.png")

    browser.close()

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL -> {fails}")
sys.exit(0 if not fails else 1)

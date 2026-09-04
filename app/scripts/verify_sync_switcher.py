# -*- coding: utf-8 -*-
# R3 歌曲切换器浏览器验收（/sync-tune 全曲目同步微调工作台）。
# 覆盖：裸路径重定向 luv-letter；切换器 6 行（5 可用 + lumiere 禁用「无 beats」）；
# 5 首曲逐一切换装配（音符列表非空 + 波形有能量 + URL 同步 + 无错误态）；
# dirty 切曲确认条（取消不动 / 确认才切且 store 干净：未导出消失、已调归零）；
# 浏览器回退/前进跟随；未知曲 id 装配失败态。
# Usage: python scripts/verify_sync_switcher.py  (vite dev server on :5173)
import os
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
BASE = "http://localhost:5173"

fails = []


def check(name, ok, extra=""):
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" | {extra}" if extra and not ok else ""))
    if not ok:
        fails.append(name)


def wave_energy(page):
    """波形画布中带与背景 #10151a(16,21,26) 的色差像素数（能量条/刻度/线均计入）"""
    return page.evaluate(
        """() => {
          const c = document.querySelector('.st-wave canvas');
          if (!c) return 0;
          const ctx = c.getContext('2d');
          const y0 = Math.max(0, Math.floor(c.height / 2) - 20);
          const d = ctx.getImageData(0, y0, c.width, 40).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i]-16) + Math.abs(d[i+1]-21) + Math.abs(d[i+2]-26) > 30) n++;
          }
          return n;
        }"""
    )


def row_count(page):
    return page.locator(".st-list-body .st-row").count()


def open_panel(page):
    page.click(".st-sw-btn")
    page.wait_for_selector(".st-sw-panel")


def wait_assembled(page, old_rows, timeout_s=30):
    """切曲装配完成：旧行集合已卸载、新行出现（行数与上曲不同即视为换新）"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        n = row_count(page)
        if n > 0 and n != old_rows:
            return n
        page.wait_for_timeout(200)
    raise TimeoutError(f"assembly timeout (rows still {row_count(page)}, old {old_rows})")


def switch(page, idx, expect_path):
    open_panel(page)
    old = row_count(page)
    page.click(f".st-sw-item >> nth={idx}")
    page.wait_for_url(f"**{expect_path}")
    # loading 一闪而过捕不到也算过（行数变化兜底）
    try:
        page.wait_for_selector(".st-status:not(.err)", state="attached", timeout=3000)
    except Exception:
        pass
    return wait_assembled(page, old)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 950})

    # A. 裸 /sync-tune 重定向默认曲 luv-letter 并完成装配
    page.goto(f"{BASE}/sync-tune", wait_until="load")
    page.wait_for_selector(".st-list-body .st-row", timeout=30000)
    check("A bare /sync-tune redirects to /sync-tune/luv-letter",
          page.url.endswith("/sync-tune/luv-letter"), page.url)

    # B. 切换器面板：全曲库 7 行（5 可用 + lumiere/aurora-scale 禁用标注「无 beats」）
    open_panel(page)
    panel_info = page.evaluate(
        """() => [...document.querySelectorAll('.st-sw-item')].map(b => ({
             off: b.getAttribute('aria-disabled') === 'true',
             nobeats: b.textContent.includes('无 beats'),
             title: b.querySelector('.st-sw-item-title')?.textContent ?? '',
           }))"""
    )
    check("B panel lists all 7 songs", len(panel_info) == 7, str(len(panel_info)))
    disabled_ok = (
        len(panel_info) == 7
        and panel_info[5]["off"] and panel_info[5]["nobeats"]
        and panel_info[6]["off"] and panel_info[6]["nobeats"]
        and not any(panel_info[i]["off"] for i in range(5))
    )
    check("B rows 5-6 (no beats) disabled with tag, rows 0-4 enabled", disabled_ok,
          str(panel_info[5:]))
    check("B current song highlighted (aria-selected on row 0)",
          page.evaluate("() => document.querySelectorAll('.st-sw-item')[0].getAttribute('aria-selected') === 'true'")
          and page.evaluate("() => document.querySelectorAll('.st-sw-item')[0].classList.contains('cur')"))
    page.keyboard.press("Escape")
    page.wait_for_selector(".st-sw-panel", state="detached")

    # C. 5 首有 beats 的曲逐一切换：URL / 曲名 / 音符非空 / 波形能量 / 无错误态
    paths = [
        "/sync-tune/luv-letter",
        "/sync-tune/flower-dance",
        "/sync-tune/river-flows-in-you",
        "/sync-tune/expedition-33",
        "/sync-tune/birds-poem",
    ]
    row_totals = {}
    # 从 idx1 起切（首曲已是 luv-letter，点当前曲是 no-op，行数不变会误判超时）
    for i in [1, 2, 3, 4, 0]:
        path = paths[i]
        rows = switch(page, i, path)
        row_totals[i] = rows
        open_panel(page)  # 行在面板内，需展开才能比对
        title_ok = page.evaluate(
            """() => {
              const t = document.querySelector('.st-sw-title')?.textContent ?? '';
              return [...document.querySelectorAll('.st-sw-item')]
                .some(b => (b.querySelector('.st-sw-item-title')?.textContent ?? '') === t);
            }"""
        )
        page.keyboard.press("Escape")
        page.wait_for_selector(".st-sw-panel", state="detached")
        err_visible = page.locator(".st-status.err").count() > 0
        check(f"C switch #{i} assembled ({path})", True)
        check(f"C switch #{i} notes non-empty", rows > 0, f"rows={rows}")
        check(f"C switch #{i} topbar title matches a row", title_ok)
        check(f"C switch #{i} no error state", not err_visible)
        check(f"C switch #{i} waveform has energy", wave_energy(page) > 200,
              f"energy={wave_energy(page)}")

    # D. dirty 切曲确认条：微调一次 → 切曲先确认；取消不动；确认才切且状态干净
    # （C 循环已以切回 luv-letter 收尾，此处直接在 luv-letter 上制造 dirty）
    page.click(".st-list-body .st-row >> nth=0")  # 选中一个音符
    page.click(".st-btn-grid .st-btn >> nth=0")  # -200ms → dirty
    check("D dirty badge appears after adjust", page.locator(".st-dirty").count() == 1)
    open_panel(page)
    page.click(".st-sw-item >> nth=1")  # 选 flower-dance
    check("D confirm bar appears on dirty switch", page.locator(".st-confirm").count() == 1)
    check("D url unchanged while confirming", page.url.endswith("/sync-tune/luv-letter"), page.url)
    page.click(".st-confirm .st-btn:not(.primary)")  # 取消
    check("D cancel keeps song and dirty state",
          page.url.endswith("/sync-tune/luv-letter") and page.locator(".st-dirty").count() == 1
          and page.locator(".st-confirm").count() == 0)
    open_panel(page)
    page.click(".st-sw-item >> nth=1")
    page.click(".st-confirm .st-btn.primary")  # 放弃微调并切换
    wait_assembled(page, row_totals[0])  # 此刻 DOM 是 luv 行集，等换成 flower 行集
    tuned_txt = page.evaluate("() => document.querySelector('.st-meta em')?.textContent ?? ''")
    check("D confirmed switch lands flower-dance", page.url.endswith("/sync-tune/flower-dance"), page.url)
    check("D store clean after switch (no 未导出, tuned=0, no confirm bar)",
          page.locator(".st-dirty").count() == 0 and tuned_txt == "0"
          and page.locator(".st-confirm").count() == 0, f"tuned={tuned_txt}")

    # E/F. 浏览器回退/前进：popstate 跟随切曲并重新装配
    page.go_back()
    page.wait_for_url("**/sync-tune/luv-letter")
    rows_back = wait_assembled(page, row_count(page))
    check("E back returns to luv-letter and reassembles", rows_back > 0, f"rows={rows_back}")
    page.go_forward()
    page.wait_for_url("**/sync-tune/flower-dance")
    rows_fwd = wait_assembled(page, rows_back)
    check("F forward returns to flower-dance and reassembles", rows_fwd > 0, f"rows={rows_fwd}")

    # G. 未知曲 id → 装配失败态（错误信息含「未知曲目」）
    page.goto(f"{BASE}/sync-tune/not-a-song", wait_until="load")
    page.wait_for_selector(".st-status.err", timeout=10000)
    err_txt_ok = page.evaluate("() => (document.querySelector('.st-status.err')?.textContent ?? '').includes('未知曲目')")
    check("G unknown song id shows assembly error", err_txt_ok)

    browser.close()

print()
if fails:
    print(f"FAIL - {len(fails)} check(s) failed: {fails}")
    sys.exit(1)
print("PASS - all song-switcher checks passed")

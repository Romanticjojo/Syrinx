# Screenshot the Luv Letter preview page to verify the info-row layout.
from playwright.sync_api import sync_playwright
import os

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
OUT = "D:/Syrinx/app/scripts/_preview_info.png"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto("http://localhost:5173/", wait_until="load")
    # 进入应用 → 曲库
    page.click(".intro-enter")
    page.wait_for_timeout(900)
    # 打开 Luv Letter 预览（第一张卡）
    page.locator(".song-card, [class*='card']").filter(has_text="Luv Letter").first.click()
    page.wait_for_timeout(2500)
    # 滚到曲目信息区
    page.locator(".info-list").scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    texts = page.locator(".info-row").all_inner_texts()
    print("info rows:")
    for t in texts:
        print(" |", t.replace("\n", " / "))
    page.screenshot(path=OUT)
    print("screenshot:", OUT)
    browser.close()

# Verify the Intro overlay is fully opaque from its very first frame (no flash of HomePage behind it).
# Samples opacity + elementFromPoint continuously via requestAnimationFrame from DOM insertion onward.
# Usage: python scripts/verify_intro_flash.py  (vite dev server on :5173)
from playwright.sync_api import sync_playwright
import os

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
OUT = "D:/Syrinx/app/scripts/_intro_frames"
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 900})

    # Inject a rAF sampler BEFORE any page script: records .intro opacity every frame for 2s.
    page.add_init_script("""
        window.__samples = [];
        const tick = () => {
            const el = document.querySelector('.intro');
            if (el) {
                const cs = getComputedStyle(el);
                const under = document.elementFromPoint(innerWidth/2, innerHeight/2);
                window.__samples.push({
                    t: performance.now(),
                    opacity: cs.opacity,
                    anim: cs.animationName,
                    covered: !!under?.closest('.intro'),
                });
            }
            if (performance.now() < 2000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    """)

    page.goto("http://localhost:5173/", wait_until="load")
    page.wait_for_timeout(2200)
    samples = page.evaluate("window.__samples")
    print(f"samples: {len(samples)}")
    if samples:
        print("first:", samples[0])
        bad = [s for s in samples if s["opacity"] != "1" or not s["covered"]]
        print("bad frames (opacity!=1 or HomePage visible through):", len(bad))
        if bad:
            print("worst:", bad[:3])
        shot_ok = page.evaluate("!!document.querySelector('.intro-enter')")
        print("enter button present:", shot_ok)
        page.screenshot(path=f"{OUT}/final.png")
        print("PASS - overlay opaque & covering in every sampled frame" if not bad else "FAIL - flash detected")
    else:
        print("FAIL - intro never appeared")

    browser.close()

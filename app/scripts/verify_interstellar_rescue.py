# -*- coding: utf-8 -*-
# interstellar 拼谱修复 UI 收尾验收（任务卡 t_7518c69e）。
# 覆盖：
#   A 预览页双谱切换：interstellar 有「长笛谱/钢琴伴奏谱」切换器；钢琴谱 svg 渲染
#     出大谱表（svg 显著变高 + 谱线数近翻倍 + staff 间距双峰成对）；切回长笛谱恢复；luv-letter 无切换器
#   B 演奏页换行缓动滚动：自然播放跨行时 rAF 帧级采样 .sheet-container scrollTop——
#     连续变化无单帧跳变 >50px；wheel 一下后 seek 跨行，让位期内 scrollTop 不被程序改动
#   C prefers-reduced-motion=reduce：换行一步直达目标（无中间帧）
# 全程 JS click（背景 video 拦截 locator click）；pageerror 必须为零（rAF 异常前科）。
# Usage: python scripts/verify_interstellar_rescue.py  (vite dev server on :5173)
import os
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe")
BASE = os.environ.get("BASE", "http://localhost:5173")
LAUNCH_ARGS = [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
]

fails = []


def check(name, ok, extra=""):
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" | {extra}" if extra else ""))
    if not ok:
        fails.append(name)


def js_click(page, sel, **kw):
    page.locator(sel, **kw).first.evaluate("el => el.click()")


def enter_interstellar_preview(page):
    """UI 链：intro（如有）→ 曲库 → Interstellar 卡片 → 详情页（等谱面渲染）"""
    if page.locator(".intro-enter").count() > 0:
        js_click(page, ".intro-enter")
    page.wait_for_selector(".song-card", timeout=15000)
    js_click(page, ".song-card", has_text="Interstellar")
    page.wait_for_selector(".score-section-title", timeout=15000)
    page.wait_for_selector(".sheet-container svg", timeout=30000)


def score_geometry(page):
    """谱面几何签名：svg 显示高度 + 横长细 path（谱线）y 去重计数 + staff 顶距序列"""
    return page.evaluate(
        """() => {
          const svg = document.querySelector('.sheet-container svg');
          if (!svg) return null;
          const ys = new Set();
          for (const p of svg.querySelectorAll('path')) {
            const b = p.getBBox();
            if (b.width > 150 && b.height < 3) ys.add(Math.round(b.y));
          }
          const arr = [...ys].sort((a, b) => a - b);
          const groups = [];
          let g = [arr[0]];
          for (let i = 1; i < arr.length; i++) {
            if (arr[i] - arr[i - 1] <= 16) g.push(arr[i]);
            else { groups.push(g); g = [arr[i]]; }
          }
          groups.push(g);
          const tops = groups.filter((x) => x.length >= 4).map((x) => x[0]);
          return {
            height: Math.round(svg.getBoundingClientRect().height),
            lineYs: ys.size,
            gaps: tops.slice(1).map((t, i) => t - tops[i]),
          };
        }"""
    )


def is_paired(gaps):
    """大谱表签名（宽松双峰）：staff 顶距呈双峰分布（对内 ≪ 组间）。
    IQR 截尾去异常后找最大断点，两簇各占 30%+ 且均值差 >20%"""
    gs = sorted(gaps)
    if len(gs) < 8:
        return False
    q1, q3 = gs[len(gs) // 4], gs[3 * len(gs) // 4]
    iqr = q3 - q1
    core = sorted(g for g in gs if q1 - 1.5 * iqr <= g <= q3 + 1.5 * iqr)
    if len(core) < 8:
        return False
    i = max(range(len(core) - 1), key=lambda k: core[k + 1] - core[k])
    if core[i + 1] - core[i] < 10:  # 无双峰分离
        return False
    small, big = core[: i + 1], core[i + 1 :]
    return (
        len(small) >= len(core) * 0.3
        and len(big) >= len(core) * 0.3
        and sum(big) / len(big) > sum(small) / len(small) * 1.2
    )


def install_scroll_sampler(page, frames):
    """rAF 帧级采样 .sheet-container.scrollTop（演奏页滚动容器即它）"""
    page.evaluate(
        """(n) => {
          window.__scrollLog = [];
          let k = 0;
          const tick = () => {
            window.__scrollLog.push(
              Math.round((document.querySelector('.sheet-container')?.scrollTop ?? -1) * 10) / 10);
            if (++k < n) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }""",
        frames,
    )


def scroll_top(page):
    return page.evaluate("() => document.querySelector('.sheet-container')?.scrollTop ?? -1")


def hud(page):
    return page.evaluate(
        """() => ({
          measure: document.querySelector('.hud-stat .num')?.textContent ?? '',
          time: document.querySelectorAll('.hud-stat .num')[1]?.textContent ?? '',
        })"""
    )


def rail_seek(page, ratio):
    """真实鼠标点 .progress-rail 到 ratio 处（trusted pointer 事件，
    onRailDown 的 setPointerCapture 需要真实 pointerId）。须在 performing 阶段调用"""
    box = page.locator(".progress-rail").bounding_box()
    x = box["x"] + box["width"] * ratio
    y = box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.up()


def wait_performing(page, timeout_s=20):
    """等 4 拍倒数结束进入演奏（时间 HUD 开始走）"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        t = hud(page)["time"]
        if t and not t.startswith("0:00"):
            return True
        page.wait_for_timeout(250)
    return False


def enter_interstellar_perform(page):
    """UI 链 → 演奏页起奏（等 performing）"""
    if page.locator(".intro-enter").count() > 0:
        js_click(page, ".intro-enter")
    page.wait_for_selector(".song-card", timeout=15000)
    js_click(page, ".song-card", has_text="Interstellar")
    page.wait_for_selector(".btn-play-big", timeout=15000)
    js_click(page, ".btn-play-big")
    page.wait_for_selector(".ov-start", timeout=30000)
    js_click(page, ".ov-start")
    page.wait_for_selector(".sheet-container", timeout=30000)


def run_check_ab(browser):
    """A 预览页双谱切换 + B 演奏页换行缓动/让位（同一 context）"""
    ctx = browser.new_context(viewport={"width": 1680, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---- A. 预览页双谱切换 ----
    page.goto(BASE, wait_until="load")
    enter_interstellar_preview(page)
    time.sleep(2)  # 等 OSMD 完整渲染

    segs = page.evaluate(
        """() => [...document.querySelectorAll('.score-switch .seg')].map(b => b.textContent)"""
    )
    check("A interstellar 显示双谱切换器（长笛谱/钢琴伴奏谱）", segs == ["长笛谱", "钢琴伴奏谱"], str(segs))

    flute = score_geometry(page)
    check("A 默认长笛谱为单排谱（staff 间距无双峰）",
          flute and flute["lineYs"] >= 80 and not is_paired(flute["gaps"]),
          f"lineYs={flute and flute['lineYs']}, h={flute and flute['height']}")

    js_click(page, ".score-switch .seg", has_text="钢琴伴奏谱")
    time.sleep(4)  # 钢琴谱拉取 + OSMD 大谱表渲染
    piano = score_geometry(page)
    check("A 钢琴伴奏谱渲染出大谱表（谱面显著变高 + 谱线数近翻倍 + staff 间距双峰成对）",
          piano
          and piano["height"] >= flute["height"] * 1.22
          and piano["lineYs"] >= flute["lineYs"] * 1.45
          and is_paired(piano["gaps"]),
          f"lineYs={piano and piano['lineYs']} vs {flute and flute['lineYs']}, "
          f"h={piano and piano['height']} vs {flute and flute['height']}")

    js_click(page, ".score-switch .seg", has_text="长笛谱")
    time.sleep(2)
    back = score_geometry(page)
    check("A 切回长笛谱恢复单排谱（缓存路径）",
          back and abs(back["lineYs"] - flute["lineYs"]) <= 10 and not is_paired(back["gaps"]),
          f"lineYs={back and back['lineYs']} vs {flute and flute['lineYs']}")

    js_click(page, ".more-card", has_text="Luv Letter")
    page.wait_for_timeout(2500)
    check("A luv-letter 详情无谱面切换器", page.locator(".score-switch").count() == 0)

    # ---- B. 演奏页换行缓动滚动 ----
    js_click(page, ".back-ghost")  # 回曲库（详情页顶栏返回）
    page.wait_for_selector(".song-card", timeout=15000)
    js_click(page, ".song-card", has_text="Interstellar")
    page.wait_for_selector(".btn-play-big", timeout=15000)
    js_click(page, ".btn-play-big")
    page.wait_for_selector(".ov-start", timeout=30000)
    js_click(page, ".ov-start")
    if not wait_performing(page):
        check("B 起奏进入演奏阶段", False, f"HUD 停留 {hud(page)}")
        ctx.close()
        return False
    check("B 起奏进入演奏阶段", True, f"HUD {hud(page)}")

    # 自然播放跨行（m29 附近首次行跟随，~45s @120bpm 4/4）：
    # 轻轮询等首次滚动起步（st>1），随即外部高频直读 3s 捕获动画中间帧。
    # （页内 rAF 采样器在 headless 下不可靠——evaluate 与 rAF 互相节流，测得恒 0；
    #   外部直读已被 C 场景与探针证实稳定，且不影响「单帧跳变 >50px」判定有效性：
    #   若实现退回 scrollTop 直写，高频直读会捕捉到旧值→新值一步大跳。）
    t0 = time.time()
    first_at = None
    while time.time() - t0 < 75:
        if scroll_top(page) > 1:
            first_at = round(time.time() - t0, 1)
            break
        page.wait_for_timeout(150)
    samples = []
    if first_at is not None:
        t_end = time.time() + 3
        while time.time() < t_end:
            samples.append(round(scroll_top(page), 1))
        time.sleep(2.5)  # 平台期 + 确保动画收尾，取最终位复核
        samples.append(round(scroll_top(page), 1))

    if first_at is None:
        check("B 自然播放跨行触发行跟随滚动", False,
              f"75s 内 scrollTop 恒 0；HUD 停留 {hud(page)}")
    else:
        deltas = [abs(b - a) for a, b in zip(samples, samples[1:])]
        distinct = len(set(samples))
        check("B 自然播放跨行触发行跟随滚动", True,
              f"首次滚动 @{first_at}s, HUD {hud(page)['measure']}, "
              f"终值={samples[-1]:.0f}")
        check("B 跨行滚动连续变化无单帧跳变 >50px",
              len(samples) >= 5 and max(deltas) <= 50,
              f"maxΔ={max(deltas):.1f}px, 不同值={distinct}, "
              f"首段={sorted(set(samples))[:14]}")
        check("B 滚动为渐进动画而非一步跳变（多中间值）", distinct >= 5, f"distinct={distinct}")

    # wheel 一下（原生滚动 settle 后取基线）→ seek 到 80%（触发跨行小节变化）
    # → 让位期内（wheel/rail pointerdown 各 bump 5s）scrollTop 不许被程序改动
    box = page.locator(".sheet-container").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(box["height"] / 2, 400))
    page.mouse.wheel(0, -120)
    time.sleep(0.8)  # Chrome 原生平滑滚动收尾
    before = scroll_top(page)
    rail_seek(page, 0.8)
    page.wait_for_timeout(400)
    m_now = hud(page)["measure"]
    still = True
    samples = set()
    t_end = time.time() + 2.5
    while time.time() < t_end:
        st = scroll_top(page)
        samples.add(round(st))
        if abs(st - before) > 0.5:
            still = False
        page.wait_for_timeout(60)
    check("B wheel 后 seek 跨行（HUD 已进新小节）而让位期内 scrollTop 不被程序改动",
          still and m_now.split("/")[0].strip() not in ("--", "01", "1"),
          f"HUD={m_now}, before={round(before)}, 采样值={sorted(samples)[:8]}")

    check("A+B 全程无 pageerror", errors == [], str(errors[:3]))
    ctx.close()
    return errors == []


def run_check_c(browser):
    """C. prefers-reduced-motion=reduce：换行一步直达（无中间帧）"""
    ctx = browser.new_context(viewport={"width": 1680, "height": 950}, reduced_motion="reduce")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="load")
    enter_interstellar_perform(page)
    if not wait_performing(page):
        check("C reduce 下起奏进入演奏阶段", False, f"HUD 停留 {hud(page)}")
        ctx.close()
        return False

    install_scroll_sampler(page, 1500)  # ~25s @60fps
    base_top = scroll_top(page)
    time.sleep(1)  # 播放推进一拍以上，避免 seek 落回第 1 小节
    rail_seek(page, 0.5)  # 跳到 ~m50：seek 快进触发一次换行
    log = []
    deadline = time.time() + 10
    while time.time() < deadline:
        log = page.evaluate("() => window.__scrollLog ?? []")
        if any(abs(v - base_top) > 1 for v in log):
            break
        page.wait_for_timeout(150)
    time.sleep(0.8)
    log = page.evaluate("() => window.__scrollLog ?? []")

    changed = [v for v in log if abs(v - base_top) > 1]
    if not changed:
        check("C reduce 下换行直达（无中间帧）", False,
              f"10s 内未见滚动，log n={len(log)}, HUD {hud(page)}")
    else:
        i0 = next(i for i, v in enumerate(log) if abs(v - base_top) > 1)
        win = log[max(0, i0 - 2): i0 + 30]
        distinct = len(set(win))
        # 直达 = 旧值→新值一步跳变：窗口内只有 2 个不同值
        check("C reduce 下换行直达（无中间帧）", distinct <= 2,
              f"distinct={distinct}, win={[round(v) for v in win[:10]]}, HUD {hud(page)['measure']}")

    check("C 全程无 pageerror", errors == [], str(errors[:3]))
    ctx.close()
    return errors == []


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=LAUNCH_ARGS)
    ok_ab = run_check_ab(browser)
    ok_c = run_check_c(browser)
    browser.close()

print()
if fails:
    print(f"FAIL - {len(fails)} check(s) failed: {fails}")
    sys.exit(1)
print("PASS - all interstellar rescue UI checks passed")

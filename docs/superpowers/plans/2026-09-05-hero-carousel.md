# 曲库英雄位 Netflix 式轮播 实施计划（t_743b9839）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 曲库页 `.home-hero` 从单张广告页升级为三曲（luv-letter / interstellar / expedition-33）Netflix 式轮播：crossfade 切换、两侧箭头、底部指示点、键盘可达、7s 自动轮播（hover/隐藏页暂停）。

**Architecture:** 新建 `HeroCarousel.tsx` 组件（含单张广告页渲染），HomePage 用它替换现有 hero section；轮播专属样式进新文件 `HeroCarousel.css`，版式沿用 HomePage.css 既有 `.home-hero` 体系（hero-bg/shade/body/kicker/meta/desc/btn-play-big 全部不动）。验收用 Playwright 无头脚本（TDD：先写脚本、先见 FAIL、实现后转 PASS）。

**Tech Stack:** React 19 + zustand（视图状态机，无路由库）、Vite、既有全局 token（`--on-media`/`--media-shade`/`--serif`/`--line-strong` 等）、Playwright（chromium-1223）。

**Spec:** 任务书 t_743b9839（本计划头部需求即其全文要点）；设计 token：`D:/Syrinx/docs/设计/style-tokens.md`。

## Global Constraints

- 分支 `dev`，严禁碰 master；只 add 自己改的文件（工作区有他人 untracked 截图/脚本）
- 参与曲目显式钦定：`['luv-letter', 'interstellar', 'expedition-33']` 按此顺序取，禁用 `SONGS.slice`
- 素材引用走 `assetUrl()`；不动 manifest、不动 public/songs、不动 song-grid/关于弹窗/sync-tune 入口
- 样式只用既有 token，媒体层之上白字用 `--on-media` 系；不引入新依赖库
- 常量：`AUTOPLAY_MS = 7000`、`CROSSFADE_MS = 600`（CSS 变量 `--hero-fade` 由 JS 常量内联注入，单一来源）
- 切换期间只渲染当前张 + 离场张（≤2 张），避免文字重影

---

### Task 1: Playwright 验收脚本（先失败）

**Files:**
- Create: `app/scripts/verify_hero_carousel.py`

**Interfaces:**
- Produces: `python scripts/verify_hero_carousel.py <port>`，退出码 0=全 PASS；输出逐条 PASS/FAIL 与 `=== N/M PASS ===` 汇总
- 依赖选择器（Task 2/3 必须产出）：`.home-hero`、`.hero-slide`（`is-active`/`is-leaving`）、`.hero-arrow.prev/.next`、`.hero-dots .hero-dot`（`.on`）、`.home-hero h1`；进详情回库用 `.back-ghost`；回归用 `.song-card`、`.nav-pill`、`.about[role="dialog"]`、`.about-close`、`.intro-enter`

- [ ] **Step 1: 写脚本**（完整代码见下；仿 `verify_song_bg.py`：chromium-1223 显式路径、端口参数化、`.intro-enter` 进曲库、`check()` 收集 PASS/FAIL）

```python
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
    return page.locator(".home-hero .hero-slide.is-active h1").inner_text()


def dot_color(page, i):
    return page.locator(".home-hero .hero-dot").nth(i).evaluate(
        "el => getComputedStyle(el, '::after').backgroundColor"
    )


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
    page.locator(".home-hero .hero-arrow.next").click()
    n_mid = page.locator(".home-hero .hero-slide").count()
    check("切换瞬间仅两张(当前+离场)", n_mid == 2, f"count={n_mid}")
    page.wait_for_timeout(FADE_WAIT)
    check("右箭头→Interstellar", hero_title(page) == "Interstellar", hero_title(page))
    page.locator(".home-hero .hero-arrow.next").click()
    page.wait_for_timeout(FADE_WAIT)
    check("再右→Expedition 33", hero_title(page) == "Expedition 33", hero_title(page))
    c2 = dot_color(page, 2)
    check("expedition 当前点点亮(#b9a0d8)", c2 == "rgb(185, 160, 216)", c2)
    page.locator(".home-hero .hero-arrow.next").click()
    page.wait_for_timeout(FADE_WAIT)
    check("末张再右循环回 Luv Letter", hero_title(page) == "Luv Letter", hero_title(page))
    check("fade 完成后离场张卸载", page.locator(".hero-slide.is-leaving").count() == 0)

    # ---- 3) 左箭头反向循环：luv → expedition ----
    page.locator(".home-hero .hero-arrow.prev").click()
    page.wait_for_timeout(FADE_WAIT)
    check("首张再左反向循环→Expedition 33", hero_title(page) == "Expedition 33", hero_title(page))

    # ---- 4) 指示点直达 ----
    page.locator(".home-hero .hero-dot").nth(1).click()
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
    check("键盘 → 切到 Expedition 33", hero_title(page) == "Expedition 33", hero_title(page))
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(FADE_WAIT)
    check("键盘 ← 切回 Interstellar", hero_title(page) == "Interstellar", hero_title(page))

    # ---- 6) Enter 进详情 + 返回恢复（重挂载回首张）----
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)
    in_preview = page.locator(".preview").count() == 1 and page.locator(".home-hero").count() == 0
    check("Enter 进预览页", in_preview)
    page.locator(".back-ghost").click()
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
    page.locator(".nav-pill", has_text="关于").click()
    page.wait_for_timeout(400)
    about_open = page.locator('.about[role="dialog"]').count() == 1
    check("关于弹窗可打开", about_open)
    page.locator(".about-close").click()
    page.wait_for_timeout(400)
    check("关于弹窗可关闭", page.locator('.about[role="dialog"]').count() == 0)

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} PASS ===")
sys.exit(1 if fails else 0)
```

- [ ] **Step 2: 起 dev server 并跑脚本，确认 FAIL（hero-slide 不存在）**

```powershell
npm run dev -- --port 5199   # 后台
python scripts/verify_hero_carousel.py 5199
```

Expected: FAIL（初始仅挂载当前张等断言失败）——证明断言真的在测新行为

### Task 2: HeroCarousel 组件 + 样式

**Files:**
- Create: `src/views/HeroCarousel.tsx`
- Create: `src/views/HeroCarousel.css`

**Interfaces:**
- Consumes: `SONGS`/`DIFFICULTY_LABEL`（`../songs`）、`assetUrl`（`../lib/assetUrl`）、`SongManifest`（`../types`）
- Produces: `export default function HeroCarousel({ onOpen }: { onOpen: (song: SongManifest) => void })`；`export const AUTOPLAY_MS = 7000`、`export const CROSSFADE_MS = 600`；DOM 契约见 Task 1 选择器

- [ ] **Step 1: 写 HeroCarousel.tsx**（完整代码：HERO_IDS 显式钦定 + show() 循环取模 + crossfade 离场张 600ms 卸载 + 自动轮播 effect 依赖 [active, hovering, hidden] + visibilitychange + 键盘 ←/→/Enter（Enter 仅 section 自身焦点，避免与内部按钮冲突）+ 箭头/圆点 stopPropagation）
- [ ] **Step 2: 写 HeroCarousel.css**（slide 绝对定位 crossfade 动画 hero-in/hero-out；箭头 44px 圆形半透明 rgba(8,9,9,.55) hover 提亮；指示点 24px 命中区 + ::after 8px 视觉点、当前点用每曲 accent（`--dot` 内联注入）；720px 断点缩小；prefers-reduced-motion 关动画）
- [ ] **Step 3: `npx tsc --noEmit` 无新错**

### Task 3: HomePage 接线

**Files:**
- Modify: `src/views/HomePage.tsx`（hero section JSX 整块替换为 `<HeroCarousel onOpen={(song) => go('preview', song.id)} />`；`featured = SONGS[0]` 保留给 sync-tune debug-link；其余不动）

- [ ] **Step 1: 替换 hero section，import HeroCarousel**
- [ ] **Step 2: 浏览器实跑脚本 → 全 PASS**

```powershell
python scripts/verify_hero_carousel.py 5199
```

Expected: `=== 21/21 PASS ===`（条数以实际为准，须全 PASS）

### Task 4: 全量回归 + 记录 + 提交

- [ ] **Step 1: `npx tsc --noEmit` 无新错；`npm test` 全绿；`npm run build` 成功**
- [ ] **Step 2: 脚本输出全文存 `D:/LLM_work/hero-carousel/verify-output.txt`（含 tsc/test/build 摘要）**
- [ ] **Step 3: 只 add 本任务四个文件，提交 dev：**

```bash
git add src/views/HeroCarousel.tsx src/views/HeroCarousel.css src/views/HomePage.tsx scripts/verify_hero_carousel.py
git commit -m "feat(home): 曲库英雄位 Netflix 式轮播——三曲广告页左右切换+自动轮播+键盘可达"
```

---

## Self-Review

- **Spec 覆盖**：版式一致(T2 复用 .home-hero 体系)、箭头/圆点/循环/键盘/crossfade≤2张(T2)、自动轮播+hover/visibility 暂停+重计时机(T2 effect)、点击进详情+stopPropagation(T2)、a11y role/tabIndex/aria-label/aria-current(T2)、移动端断点(T2 css)、三曲钦定(T2 HERO_IDS)、验证脚本≥10条(T1 共 21 条)、tsc/test/build/记录/提交(T4) —— 全有对应任务
- **占位符扫描**：T2 Step1/2 标注「完整代码」但代码体在执行时落地——执行者为本会话，组件代码已在前文设计定型（HERO_IDS/show/crossfade/键盘细节/Enter 守卫/`--dot` accent 注入/reduced-motion），无 TBD
- **类型一致性**：`HeroCarousel({ onOpen })` 与 T3 调用一致；`show(index)` 取模循环；选择器清单与组件类名一一对应（hero-slide/hero-arrow prev|next/hero-dot on/hero-fade）

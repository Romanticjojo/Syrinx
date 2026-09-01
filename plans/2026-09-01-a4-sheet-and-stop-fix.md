# 计划：谱面 A4 比例缩窄 + 停止按钮语义修复（看板卡 t_c10d648d）

日期：2026-09-01 · 来源：D:/LLM_work/syrinx-perform-polish/cc-brief-2.md

## 任务 1a 诊断结论（已核实源码）

- `app/public/songs/luv-letter/score.musicxml` 含 **23 处** `<print new-system="yes"/>`（无 `new-page`）。
- `app/public/songs/lumiere/score.musicxml` 无强制换行。
- 这就是「880px 限宽失效」的根因：OSMD 遇到 `new-system` 硬换行，容器再窄也不重排。
- **修复方式**：运行时剥离。在 `app/src/score/musicxml.ts` 新增纯函数 `stripForcedBreaks(xml)`（DOMParser 遍历 `<print>` 删 `new-system`/`new-page` 属性），在 `app/src/songs/index.ts` 的 `loadSong` 里于 `expandRepeats` 之后调用。XML 源文件不动。happy-dom 测试环境与 musicxml.test.ts 现有做法一致。
- 注意顺序：`stripForcedBreaks(expandRepeats(raw))`，展开后的谱也干净；剥离不影响 timeline 解析。

## 任务 1b/1c：A4 比例容器

- `PerformPage.css` `.sheet-container`：`max-width: min(880px, 100%)` → `width: min(62vh, 720px, 100%)`（A4 纵版观感，宽:高≈1:1.414）。
- `PreviewPage.css` `.score-section .sheet-container`：`min(820px,100%)` → 同一公式。
- 演奏页 `PerformPage.tsx` zoom：1.15 → **1.3**（行宽占用不变、音符放大）。预览页 zoom 保持 1.1（任务书未要求）。
- 移动端 `@media (max-width: 640px)`：谱面全宽 + 左右 10px 边距。
- 响应式依赖 OSMD `autoResize: true`（L70 已开），无 CSS 阻断。

## 任务 2：✕/Esc 语义修复

- `PerformPage.tsx` `exit` 回调：`phaseRef.current` 为 `performing`/`countdown` → `finish()`（封存流程不变）；其余（loading/ready/ended/error）→ `go('home')`。Esc 与 ✕ 共用该回调（已共用，无需改监听）。
- `ControlBar.tsx`：✕ 的 title/aria-label 动态——演奏中（`playing`）「停止并保存，进入回放」，否则「退出演奏」。props 不改。
- `ControlBar.css`：■ 与右侧（音量+✕）之间加分隔线 `.ctl-sep`。
- 回归：vitest 全量跑，`compare.test.ts`（timelineUpTo）必须绿。

## 步骤与提交

| Commit | 内容 |
| --- | --- |
| A | `stripForcedBreaks` + 测试（TDD：先写失败测试）+ loadSong 接线 |
| B | A4 容器宽（perform+preview）+ zoom 1.3 + 移动端全宽 |
| C | ✕/Esc 语义 + ControlBar 分隔线 |
| D | `app/scripts/shot-perform.mjs` 截图脚本 |

验证：`cd app && npx vitest run && npm run build && npx oxlint`；Playwright Chromium（chromium-1223）对 vite dev server 截 4 张演奏页（1920×1080 / 1366×768 / 768×1024 / 390×844）存 `D:/LLM_work/syrinx-perform-polish/shots/`。

红线：不打包、不 `git add -A`、不碰 OSMDScore T3 成果、不动 shot-entry.mjs、不 push。

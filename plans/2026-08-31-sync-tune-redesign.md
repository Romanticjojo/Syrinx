# 任务：sync-tune 微调界面重设计（R2）——可用性优先的工作台化改造

> 背景：v1 调试页（/sync-tune/luv-letter，t_b3080db9 产线）性能已优化（O(N²) 消除、按需重绘、标记池化、backgroundThrottling:false），但用户实测报告 5 个可用性硬伤，判定为「根本没法用」。本任务对该页面做可用性重设计，产出 R2 版本。
> 约束：**只改 sync-tune 调试页及其直属依赖（AudioEngine/OSMDScore 的可选扩展），不动演奏页（PerformPage）、不动 musicxml.ts/anchors.ts 现有行为。**
> 工作目录：D:\Syrinx\app（Vite + React + TS + zustand + OSMD + Web Audio）。

## 用户实测问题清单（2026-08-31，原话归纳）

| # | 现象 | 根因分析（已定位） |
|---|------|--------------------|
| 1 | 无法播放背景音乐 | AudioEngine.play() 中 `ctx.resume()` 是 fire-and-forget，suspended 状态下 `src.start()` 先于 resume 完成执行 → 静音；且无任何「音频被阻塞」的用户可见提示 |
| 2 | 点了音符，乐谱没反应/看不出选中 | 选中反馈只有右栏数字变化 + 601 根淡色标记里换一根边框色，谱面上选中的**音符本身**无任何染色/高亮；点谱面命中 staffEntry 后最近邻匹配也偶发错位 |
| 3 | 不知道怎么播放/暂停 | 播放唯一入口是空格键，页面只有一行小字 hint，无可见播放按钮 |
| 4 | 底部波形看不懂 | 波形区 5 种线条/刻度无图例、无标注；拖拽/缩放/点刻度交互不可发现；「期望线」等术语无解释 |
| 5 | 点击后反应慢 | 窗口被遮挡时 Chromium 节流（已修：backgroundThrottling:false）+ 点击谱面触发全量标记 effect + React 渲染链路 ~300ms；感知卡顿主要来自反馈弱（问题 2 放大了它） |

## 设计决策（已定稿，执行时不要反问）

1. **播放控制实体化**：顶栏新增播放控制条 `⏮ ⏯ ⏭ + 当前小节/总小节 + 进度条（可点可拖 seek）+ 时间显示`。空格键保留。⏯ 图标随状态切换。
2. **音频解锁修复**：AudioEngine.play() 改 async，先 `await this.ctx.resume()` 再建 src；AudioEngine 暴露 `get state()`（running/suspended/closed）。SyncTunePage 顶栏显示音频状态徽标：suspended 时显示「🔊 点击启用音频」按钮（用户手势内调用 resume）。
3. **谱面选中可视化**：OSMDScore 新增可选方法 `highlightNoteAt(measure, rvInMeasure): void`——把选中音符的 notehead 染成 accent 色（复用 updateHighlight 的 setColor 机制，单音符操作），切换时旧选恢复白色。点谱面/列表/波形三向选中都必须触发谱面染色。
4. **点击命中强化**：noteAtPoint 命中半径内无 staffEntry 时，fallback 到最近小节行 + 该行最近音符（现有逻辑），但额外返回距离；距离超过阈值（120px）时仍选最近并在右栏提示「已选最近音符」。三向选中同步保持。
5. **波形区图例 + 折叠**：波形顶部加图例行（色块+文字：`白细线=基线期望 ｜ 青线=当前网格 ｜ 橙刻度=已调 ｜ 亮刻度=选中 ｜ 白竖线=播放头`）；波形面板可折叠（默认展开，点击标题行收起为 32px 条）。
6. **当前小节聚焦**：播放/选中变化时，谱面自动滚动使当前小节居中（scrollIntoView 到 OSMD 小节几何 x 坐标，OSMDScore 新增可选方法 `scrollToMeasure(m: number)`，用 markerGeom 同源的 MeasureList 几何）。手动滚动谱面时暂停自动跟随 5 秒（wheel/pointerdown 时间戳判断），避免抢滚动条。
7. **操作说明面板**：右栏底部固定「? 操作说明」可展开块，列出全部快捷键与鼠标操作（替代现在挤在一行的 hint）。
8. **性能预算**：点击谱面选中 → 视觉反馈 < 100ms（染色用单音符 setColor，不重建标记层）；±ms 微调 → 波形亮线更新 < 50ms（已达标，保持）。所有新增交互不得引入每帧 React 渲染。
9. **文案**：页面内所有提示用中文；波形图例与操作说明是本次新增 UI 的验收重点。
10. **命名**：新代码符号用英文，注释/文案中文；遵守项目现有风格（tabular-nums、暗色系 #0b0f12 基调）。

## 分任务（流水线串行，依赖 T1→T2→T3→T4→T5，全部完成后整体验收）

### T1 音频播放修复（阻塞后续一切验证的前置）
- AudioEngine：`play()` 改 async（await resume）、`get state()`、resume 失败 catch 后置 suspended 提示。
- SyncTunePage：顶栏音频徽标 + 「点击启用音频」按钮；togglePlay/runAudition 均 await play()。
- 测试：store/logic 不动；新增 AudioEngine 状态单测（mock AudioContext）。
- 验收：dev 窗口冷启动 → 点 ⏯ 或按空格 → 伴奏出声；AudioContext suspended 时 UI 有可见提示。

### T2 播放控制条 + 波形图例/折叠 + 帮助面板（纯 UI 层）
- 顶栏控制条（决策 1）+ 进度条 seek（拖拽中不触发音频重启，松手才 seek）。
- 波形图例行 + 折叠（决策 5）；「? 操作说明」面板（决策 7）。
- 验收：不碰键盘，纯鼠标完成 播放/暂停/seek 到任意小节/看懂波形图例/展开帮助。

### T3 谱面选中可视化 + 点击命中 + 小节聚焦（谱面交互层）
- OSMDScore.highlightNoteAt / scrollToMeasure（决策 3/6，可选方法，缺省行为不变）。
- SyncTunePage：三向选中 → highlightNoteAt；播放/选中变化 → scrollToMeasure 聚焦（决策 6 的 5 秒让位逻辑）；命中 fallback 提示（决策 4）。
- 验收：点击谱面音符 → 音符染 accent 色 + 右栏联动 < 100ms；播放时谱面自动跟随当前小节；手动滚轮 5 秒内不被抢滚动。

### T4 感知性能收尾
- 标记层更新局部化：微调/选中变化只更新受影响 marker 的 borderColor（元素池已支持），不改其他 marker。
- 谱面点击路径 profile（OSMD noteAtPoint + React 渲染链），>100ms 的环节修掉。
- 验收：CDP 实测 点击选中 < 100ms、微调 < 50ms；被遮挡窗口下操作不退化（backgroundThrottling:false 已在 main.cjs）。

### T5 集成走查 + 文档收尾
- 手动全流程走查：打开 → 启用音频 → 播放 → 跟随 → 暂停 → 点音符 → ±50ms → 试听 A/B → 导出 beats.json。
- vitest 全绿 + `tsc -b` 通过 + `npm run build` 成功；SyncTunePage.tsx 头注释更新为 R2 行为描述。
- git commit：`feat: sync-tune R2 —— 播放控制/选中可视化/波形图例/小节聚焦/感知性能`。

## 执行纪律

- 工作流：writing-plans（只做本文件已定稿内容的实现细化，不再产出新设计问题）→ executing-plans → verification-before-completion。
- 每个任务完成即 `git commit`（原子提交，message 前缀 T1/T2/...）。
- 禁止改动：PerformPage*、musicxml.ts、anchors.ts、songs/、全局 store.ts；OSMDScore/AudioEngine 只做「新增可选方法/向后兼容改动」。
- 现有 88 个 vitest 用例不许回归。

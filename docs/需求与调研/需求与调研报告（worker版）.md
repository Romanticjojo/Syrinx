# 长笛演奏辅助应用（Flute App）需求与调研报告

> 版本 v1.0 ｜ 2026-08-30 ｜ 状态：**调研完成，待 UI 初稿**
> 说明：本报告为需求整理 + 可复用项目调研，未进入开发阶段。

---

## 1. 项目概述

一款**长笛演奏辅助应用（兼具游戏沉浸感）**，定位介于"智能乐谱播放器"与"音乐节奏游戏"之间：

- 用户吹奏**真实长笛**，应用负责：按伴奏时间轴引导演奏进度（光标跟随谱子）、自动翻页、播放伴奏、录制用户演奏并回放。
- 整体体验走"音乐会/电影开场"路线：华丽动态背景、每首歌专属主题视觉、Netflix 式预览开场。
- **内容全部由用户自行准备**（动态背景动画、3D 蓝图模型、曲谱、伴奏音频），应用只负责"播放编排 + 交互引导"，不做内容生成。

**核心卖点**：① 界面华丽酷炫、沉浸感强；② 每首歌的动态背景与音乐匹配；③ 曲谱在不牺牲可读性的前提下适配歌曲视觉风格；④ 支持录制演奏并回放。

**示例曲**：《Clair Obscur: Expedition 33（33号远征队）》主题曲 **Lumière**——作曲家 Lorien Testard & Alice Duport-Percier（2025），"Nocturne pour Lumière" 为夜曲风格（平静、反思性），钢琴/弦乐主导、法式浪漫气质。主题"明暗对照（clair-obscur）"与"光"非常适合作为 UI 设计语言（明暗对比、法式衬线字体、光影粒子）。原曲有长笛参与的管弦编曲版本，旋律线适合长笛演奏。

---

## 2. 产品流程（用户视角）

```
启动应用
  └─① 开场：长笛结构蓝图动画（3D 拼装视频，外部生成）→ 可跳过
  └─② 曲库大厅（类似 Netflix/Spotify 首页：卡片流 + 分类行）
  └─③ 曲目详情/预览页（Netflix 式：自动播放动画片段+伴奏试听，展示曲名/难度/时长，[开始演奏] 按钮）
  └─④ 演奏界面（核心）：动态背景动画 + 中央曲谱 + 进度光标跟随伴奏时间轴
        ├─ 点击"开始"→ 伴奏播放 → 光标按节奏走谱 → 自动翻页
        ├─ 录制开关开启 → 麦克风录制用户演奏
        └─ 演奏结束 → ⑤ 回放页：播放录音（可叠加伴奏对比），显示录制时长/可重新演奏
```

---

## 3. 功能需求分级

### P0（MVP 必备）

| 模块 | 需求 | 说明 |
|---|---|---|
| 开场蓝图动画 | 播放外部生成的 3D 拼装视频 + 跳过按钮 | 简单 `<video>` 全屏播放即可 |
| 曲库大厅 | 曲目卡片列表（封面/标题/难度/时长），风格 Netflix 暗色 | 支持按歌曲切换主题色 |
| 曲目预览页 | Netflix 式：自动播放背景动画 + 伴奏片段 + 进入按钮 | 静音/有声自动播放，进入演奏前给用户"预告" |
| 演奏界面 | 动态背景视频（暗化处理保证谱面可读）+ 中央曲谱渲染 + 进度光标 | **核心界面** |
| 进度引导 | 光标按伴奏时间轴逐音符/逐小节高亮（跟随谱子走） | 见 §6 技术方案 |
| 自动翻页 | 光标到当前页底部时平滑过渡到下一页 | |
| 伴奏播放 | 本地音频文件播放，支持暂停/继续/进度跳转 | |
| 录制回放 | MediaRecorder 录制麦克风 → 回放录音 | 回放页可听自己的演奏 |
| 控制条 | 开始/暂停、录制开关、音量、进度条、返回 | 演奏时尽量隐藏，保持沉浸 |

### P1（增强体验）

- **音高检测（可选增强）**：麦克风实时检测是否吹对音（吹对时音符高亮/发光），演奏结束给出准确性评分——即 Tonara/Yousician 式"听你演奏"。技术上可行（见 §6），但**不是 MVP 必需**。
- 录音与伴奏**混音回放**、速度调节（0.75x/1x/1.25x）、循环练习某小节。
- 每首歌的**主题 UI 适配**（配色、字体、粒子效果随曲目切换）。
- 练习统计（本次演奏时长、完成度）。

### P2（远期）

- 乐谱导入/编辑（MusicXML/ABC 上传）、多乐器声部、蓝牙翻页踏板、多端（iOS PWA）、社区分享。

---

## 4. 可复用开源项目调研（重点）

### 4.1 曲谱渲染 + 播放（核心组件，可直接复用）

| 项目 | 定位 | 许可证 | 可复用点 |
|---|---|---|---|
| **[OSMD](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay)**（~1.9k★） | MusicXML → 浏览器 SVG 曲谱渲染引擎 | BSD-3 | ✅ **首选**。内置 `cursor` API：逐音符光标、小节高亮、**多光标 + follow 属性**、音符变色（`noteheadColor`）；数据模型可改任意音符样式——**正好满足"光标跟谱 + 主题化染色"**。官方 Wiki 有 cursor/highlight demo。局限：不内置音频播放（需自己接时间轴） |
| **[abcjs](https://github.com/paulrosen/abcjs)**（~2.3k★） | ABC 记谱法渲染 + **内置音频回放** | MIT | ✅ 自带"播放 + 音符高亮同步"（Obsidian 插件即基于此）；ABC 是纯文本格式，**单旋律长笛谱手写/生成都极方便**。适合作为备选或快速原型 |
| **[musicxml-player](https://github.com/infojunkie/musicxml-player)** | MusicXML 播放（Web Audio + Web MIDI） | — | ✅ 关键参考：它产出 **timemap（每个小节 → 时间戳）**——这正是"光标跟随伴奏时间轴 + 自动翻页"需要的核心数据结构，可直接借鉴其设计 |
| VexFlow | 底层谱表渲染引擎（OSMD 的基础） | MIT | 需要手动布局每个音符，**不建议直接用**；OSMD 已封装好 |
| Verovio | MEI 曲谱 SVG 渲染 | — | 谱源若是 MEI 才考虑 |
| alphaTab | Guitar Pro/吉他谱 | — | 与长笛无关，跳过 |
| MuseScore（桌面） | 开源制谱软件 | GPL | 不是 Web 组件，但**可用它把用户找的 PDF/图片谱转为 MusicXML**，供 OSMD 加载 |

> **结论**：渲染层用 **OSMD（MusicXML）**，光标跟随用 OSMD cursor API + 自建 timemap（参考 musicxml-player）；若谱源是简单单旋律，ABC 格式 + abcjs 是最快路径。

### 4.2 音频技术（伴奏播放 / 录音 / 同步）

| 技术 | 用途 | 要点 |
|---|---|---|
| Web Audio API + howler.js/Tone.js | 伴奏播放、音频分析 | 播放走 AudioContext 保证低延迟 |
| MediaRecorder API | 录制用户演奏 | 浏览器原生，可存 WAV 回放 |
| `outputLatency` + `getOutputTimestamp`（[web.dev](https://web.dev/articles/audio-output-latency)） | **音画同步关键** | 动态背景视频 + 伴奏 + 光标三方同步全靠它；桌面 Chrome 最稳 |
| [microdsp](https://github.com/rfwatson/microdsp-web)（WASM, MPM 算法） | P1 音高检测 | 轻量、实时、浏览器可用，比 CREPE 小得多 |
| CREPE（TensorFlow.js） | P1 音高检测（备选） | 官方有浏览器 demo；模型大、需精简版，略重 |

> **注意风险**：外放伴奏时麦克风会录进伴奏声（长笛录音质量下降）。MVP 建议提示用户戴耳机；v2 可研究回声消除/分轨处理。

### 4.3 商业产品参照（不开放源码，但 UX/交互设计最佳参照）

| 产品 | 参照价值 |
|---|---|
| **[Tonara](https://www.tonara.com)** | **最接近本项目的商业产品**：智能乐谱 App，麦克风"听"演奏 → 光标跟随 → **自动翻页** → 录音 → 练习统计评分。2014 年就已实现"跟随演奏自动翻页"，其交互流程值得完整借鉴（含脚踩翻页踏板、练习统计） |
| **Yousician** | 麦克风实时音高检测 + 游戏化，全平台。单音检测技术成熟；本项目 P1 音高检测的体验标杆 |
| **tonestro（长笛版）** | **长笛专用**练习 App，听演奏评分 + 曲库 + 课程——直接竞品参照 |
| **Simply Piano / JoyTunes** | 麦克风检测标杆（和弦级），其检测算法不可复用（闭源），但"新手 30 分钟弹会一首歌"的引导设计可借鉴 |
| **[Sky: Children of the Light 乐谱系统](https://sky-children-of-the-light.fandom.com/wiki/Music_Sheets)** | **乐器演奏游戏化的最佳 UI 参照**：下一音符放大 + 外层方框收缩提示"该吹的时刻"、音符连线 + 弹跳星星指示节奏、吹对音符发光/准确性仪表盘、多乐器声部。这些交互模式可直接迁移到"长笛跟谱" |
| Lost in Harmony | 节奏游戏 + 叙事 + 手绘场景，音乐沉浸感的体验参照 |
| Flute Master / The Bansuri App | 竖笛/竹笛学习 App，入门向交互参考 |

### 4.4 动态背景技术方案

用户自行生成背景动画，应用侧只需播放：

- **首选**：预渲染视频（MP4/WebM）+ `<video loop>` + 半透明遮罩压暗保证谱面可读 → 最简单、效果最可控、性能最好。
- 备选：Three.js 音频反应可视化（如 [phase-viz](https://github.com/7g3n/phase-viz)、[audio-reactive-shaders](https://github.com/TjardoOrtan/audio-reactive-shaders)，均 MIT），适合想做"背景随音乐律动"时参考，但不是必须。

### 4.5 Netflix 式预览（设计模式）

进入曲目后全屏自动播放"预告片"（动画片段 + 伴奏高潮段落），叠加曲名/难度/时长 + [开始演奏] 大按钮，自动播放 5-10 秒后若未操作则回到静默封面。这是纯 UI 模式，无开源组件，直接按此模式实现即可（可用 `<video autoplay muted loop>` + 叠加层）。

---

## 5. 技术选型建议

| 层 | 推荐方案 | 备选 |
|---|---|---|
| 平台 | **Web 应用（桌面 Chrome/Edge 优先），可 Tauri/Electron 包装成桌面 App** | PWA（手机） |
| 前端框架 | React + Vite（或 Next.js） | Svelte/Vue |
| 曲谱渲染 | **OSMD（MusicXML）** | abcjs（ABC，适合快速原型） |
| 进度跟随 | OSMD cursor + 自建 timemap（借鉴 musicxml-player） | abcjs 内置播放高亮 |
| 伴奏/音频 | Web Audio API + howler.js | Tone.js |
| 录音 | MediaRecorder → WAV | AudioWorklet 采集（低延迟场景） |
| 动态背景 | `<video>` 预渲染循环 + 遮罩 | Three.js 音频反应 |
| 音高检测（P1） | microdsp WASM（轻量） | CREPE TF.js |
| 蓝图动画 | `<video>` 全屏播放 + 跳过 | — |

**架构草图**：

```
┌────────────────────────────────────────────┐
│ 演奏界面（React）                            │
│  ┌──────────┐  ┌──────────────────────┐    │
│  │ 动态背景   │  │ 曲谱区 (OSMD SVG)     │    │
│  │ <video>  │  │  + 光标跟随 + 高亮      │    │
│  │ + 遮罩    │  │  + 自动翻页            │    │
│  └──────────┘  └──────────────────────┘    │
│  控制条：开始/暂停 · 录制 · 音量 · 进度      │
└────────────────────────────────────────────┘
        │ 时间轴驱动（单一时钟源）
        ▼
  timemap（小节/音符 → 时间戳）
  = MusicXML 解析 + 伴奏音频时长对齐
```

---

## 6. 关键设计决策点（需要用户确认）

1. **进度引导模式（最重要）**：
   - 方案 A（推荐 MVP）：**纯时间轴光标**——光标按伴奏时间轴匀速走谱，用户跟着吹，不检测对错。实现简单、稳定。
   - 方案 B（P1）：麦克风音高检测驱动——吹到哪个音光标到哪，吹对高亮/评分（Tonara 式）。体验更强但复杂度显著上升（降噪、吹奏识别、延迟）。
2. **谱子格式来源**：用户找的谱是 PDF/图片？需要先转 MusicXML（用 MuseScore 转换）或抄成 ABC。→ 决定走 OSMD 还是 abcjs。
3. **录音环境**：外放伴奏会串入录音。MVP 是否接受"戴耳机演奏"提示？
4. **端优先**：先桌面 Web（推荐，麦克风/音频最稳）还是先手机？

---

## 7. 推荐的 Skill / Agent（UI 初稿产出方案）

用户可直接指挥本 Agent（我）执行，无需额外安装：

| 步骤 | Skill / 工具 | 产出 |
|---|---|---|
| ① 初稿探索 | **`sketch`**（Hermes 内置） | 一次产出 **2-3 个 HTML 设计变体**（如：极简暗色编辑风 / 法式浪漫光晕风 / 游戏化霓虹风），可交互、可对比，用于定方向 |
| ② 高保真精修 | **`claude-design`**（Hermes 内置） | 选定方向后做**单个高保真原型**：完整演奏界面 + 预览页 + 曲库大厅；自带 Tweaks 面板可现场调主题色，模拟"每首歌 UI 适配" |
| ③ 视觉词汇 | **`popular-web-designs`**（Hermes 内置） | 提供 Netflix/Spotify 等 54 套真实设计系统的配色/字体/组件作为**风格参照**（提取原则，不照抄） |
| ④ 曲谱界面初稿（特殊） | **OSMD / abcjs 真实渲染** | 建议初稿阶段直接用 OSMD 渲染一段 Lumière 旋律的真实谱例嵌入设计稿，验证"可读性 + 主题染色"，而不是画假谱 |
| ⑤ 并行探索（可选） | **`delegate_task` 子代理** | 派 2-3 个子代理各自出一个方向的演奏界面，互不干扰，最后合并对比 |
| ⑥ 开发阶段 | **Claude Code + superpowers-zh**（用户已有） | writing-plans → executing-plans → verification 流程落地开发 |

**推荐顺序**：sketch 出 3 个方向 → 选定 1 个 → claude-design 精修（含真实谱例）→ 用户确认 → Claude Code 开发。

**外部工具（可选，与本工作流集成度低）**：v0.dev / Lovable / Figma Make 可快速生成 UI 概念图，适合找灵感，但不产生可复用代码。

---

## 8. 下一步建议

1. 用户确认 §6 的 4 个决策点（尤其"进度引导模式 A/B"和"谱子格式"）。
2. 我按 `sketch` 流程出 3 个演奏界面初稿变体（含 OSMD 真实谱例），对比定方向。
3. 方向确认后 `claude-design` 精修 + 用 `popular-web-designs` 补视觉词汇。
4. 全部确认后进入开发（Claude Code + superpowers）。

---

## 附录：调研数据来源

- OSMD 官方站点/Wiki（cursor、noteheadColor、多光标 follow）— opensheetmusicdisplay.org
- abcjs 官网 + Obsidian abcjs 插件文档（内置播放 + 音符高亮）— abcjs.net
- musicxml-player GitHub（timemap 设计）
- Tonara 官网/媒体报道（The Strad、Sonicbids）— tonara.com
- Sky: Children of the Light 乐谱系统（Fandom Wiki）
- CREPE / microdsp / PitchPlease（浏览器音高检测）
- web.dev（音频输出延迟与音画同步）
- Clair Obscur: Expedition 33 OST（Lorien Testard）— Bandcamp/Fandom
- tonestro 长笛版、Yousician（App Store/Google Play 页面）

*注：部分搜索接口偶发限流（节奏游戏框架、Netflix 模式两个查询），相关结论由已有材料（Sky/Lost in Harmony）与通用设计模式补充，不影响核心结论。*

# Syrinx 设计 Token（style-tokens）

> 定稿方案 A「夜航晨光」的全局 token 规范。实现源：`app/src/index.css`（单一事实来源）。
> 版本：v1（2026-08-30，任务 t_8421be1d）

## 设计语言

- **极简单色、细线、大留白、低饱和** —— 对齐 Syrinx logo（`resources/Syrinx_logo_dark.jpg`）的视觉语言
- **灰阶基色 + 单点缀色**：全 UI 只有一个强调色（晨光青），曲目层通过 `--song-accent` 每曲覆盖
- **暖金克制使用**：`--brand-gold` 仅出现在品牌位（字标分隔点、关于页），不做功能性强调
- **去装饰化**：细线边框（1px hairline）、大留白、弱阴影仅两档、无常驻投影/重渐变
- **衬线标题 + 无衬线 UI**：曲名/品牌字用 `--serif`，界面文本用 `--sans`

## Token 一览

### 灰阶基色（层级面）

| Token | 暗色（默认） | 浅色 (`data-theme='light'`) | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#0e0f0f` | `#f7f6f2` | 页面底色 |
| `--surface` | `#161818` | `#ffffff` | 卡片/浮层面 |
| `--surface-2` | `#1e2020` | `#edeae3` | 次级面（导航/回退按钮） |
| `--ink` | `#f5f4f0` | `#191b1a` | 主文字 |
| `--ink-dim` | `#a9aba8` | `#585c59` | 次级文字 |
| `--ink-faint` | `#70736f` | `#8c908c` | 弱文字（角注/页脚） |

### 细线（唯一描边语言）

| Token | 暗色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--line` | `rgba(255,255,255,.09)` | `rgba(22,24,23,.10)` | 常规 hairline 边框/分隔线 |
| `--line-strong` | `rgba(255,255,255,.20)` | `rgba(22,24,23,.22)` | hover 提亮边框 |

> 兼容别名：`--border` 已收敛为 `--line-strong` 语义；旧三档阴影收敛为两档，`--shadow-lg` 别名指向 `--shadow-md`。

### 点缀色

| Token | 值 | 用途 |
| --- | --- | --- |
| `--accent` | `#5fb8a8`（暗）/ `#3d8d7e`（浅） | 全局唯一强调色（晨光青） |
| `--accent-ink` | `#06130d`（暗）/ `#ffffff`（浅） | 点缀色之上的文字/图形 |
| `--song-accent` | 每曲 `manifest.accent` | 曲目层覆盖：背景/光标/迷你播放/开始按钮 |
| `--brand-gold` | `#d9a441` | 暖金，仅品牌位（字标分隔点/关于页） |
| `--rec` | `#f3727f` | 录音状态 |

### 纱罩与媒体层

| Token | 暗色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--scrim-top` / `--scrim-mid` | `rgba(11,12,12,.94/.40)` | `rgba(247,246,242,.94/.40)` | 顶栏渐变纱 |
| `--page-scrim` | `#090c0b` | `#f1f0ea` | 全屏媒体背景整页纱罩基色（配合 `color-mix` 控制透明度） |
| `--on-media` / `--on-media-dim` | 白色系（不随主题翻转） | 同左 | 封面/视频之上的文字 |
| `--media-shade` | `rgba(8,9,9,.82)` | 同左 | 媒体暗角 |

### 字体 / 几何 / 阴影

| Token | 值 |
| --- | --- |
| `--serif` | `Georgia, 'Songti SC', 'Noto Serif SC', serif` |
| `--sans` | `'DM Sans', system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif` |
| `--pill` / `--circ` | `9999px`（`--circ` 为兼容别名） |
| `--radius` | `10px` |
| `--shadow-sm` | `rgba(0,0,0,.2) 0 4px 12px`（浅色对应换算） |
| `--shadow-md` | `rgba(0,0,0,.32) 0 10px 28px` |

## 主题机制

- 暗色为 `:root` 默认；浅色通过 `html[data-theme='light']` 声明启用
- 切换：`app/src/theme.ts`（`getTheme/setTheme/initTheme`），localStorage 键 `syrinx_theme`；`main.tsx` 渲染前 `initTheme()` 防闪跳
- 入口：曲库页头「☀/☾」按钮

### 沉浸页锁定暗色

演奏（`.perform`）、入场（`.intro`）、回放（`.result`）三页的根选择器内**本地固定暗色 token**——它们的背景是视频/canvas 媒体层，浅色文字纱罩体系不适用。浅色主题目前完整覆盖曲库与预览两页。

## 品牌位

| 位置 | 实现 |
| --- | --- |
| 启动画面 | `app/index.html` 内联 `.boot`（JS 就绪前显示 logo 女神吹笛图形 + 字标，React 挂载后替换） |
| favicon | `app/public/favicon.svg` —— 细线长笛键位图形（晨光青，替换模板残留） |
| 页头 | 曲库页头圆形 logo 小标（`--line` 细线描边）；字标分隔点用暖金 |
| 关于页 | `app/src/components/About.tsx` —— 细线卡片 + 大留白 + 版本号，从页头/页脚「关于」进入 |
| 品牌素材 | `app/public/brand/`（`syrinx-logo-dark.jpg` 入场/关于/启动；`flute.jpg` 预览页乐器位） |

## 使用守则

1. 新样式**禁止**硬编码灰阶/文字色，一律用 token；媒体层之上的白色文字用 `--on-media` 系
2. 边框只用 `--line` / `--line-strong`；阴影只允许 `--shadow-sm` / `--shadow-md`（hover 抬升场景）
3. 功能性强调只用 `--accent`（或 `--song-accent`）；`--brand-gold` 仅限品牌位
4. 每曲主题色通过根节点 `--song-accent` 内联注入（参照 `PreviewPage/PerformPage`），不要新开色彩通道

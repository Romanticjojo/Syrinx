<div align="center">

<img src="docs/img/logo.jpg" alt="Syrinx Logo" width="200"/>

# 🎶 Syrinx · 长笛流光

**吹响真实长笛，让曲谱跟随你流动。**

[English](#english) · [快速开始](#-快速开始) · [功能](#-功能总览) · [路线图](#-路线图) · [FAQ](#-faq--已知问题)

![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D20.19-339933?style=flat-square&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-lightgrey?style=flat-square)

*介于「智能乐谱播放器」与「音乐节奏游戏」之间的长笛演奏辅助应用。*
*Syrinx（赛琳克斯）——希腊神话中化为排笛的仙女，也是德彪西的同名长笛独奏曲。*

</div>

<a id="english"></a>

> **English** | Syrinx is a flute performance companion app: it renders sheet music, follows your playing with a moving cursor and auto page-turn, plays reactive backgrounds, records your take and scores your pitch. This README is mainly in Chinese — see Chinese for details.

---

## 📖 目录

- [截图](#-截图)
- [功能总览](#-功能总览)
- [亮点](#-亮点)
- [技术栈](#-技术栈)
- [快速开始](#-快速开始)
- [项目结构](#-项目结构)
- [曲目接入（Song Pack）](#-曲目接入song-pack)
- [路线图](#-路线图)
- [FAQ / 已知问题](#-faq--已知问题)
- [License](#-license)

## 📸 截图

> 🖼 以下截图取自真实运行界面；结果页 / 回放页截图**占位——后期补**。

| 曲库 · Netflix 式卡片流 | 曲目详情 · 预览 |
|---|---|
| ![曲库](docs/img/screenshot-1-library.png) | ![预览](docs/img/screenshot-2-preview.png) |

| 演奏 · 就绪倒数 | 演奏中 · 光标走谱 + 动态背景 |
|---|---|
| ![演奏就绪](docs/img/screenshot-3-perform.png) | ![演奏中](docs/img/screenshot-4-perform-live.png) |

## ✅ 功能总览

| 状态 | 功能 |
|:---:|---|
| ✅ | MusicXML 曲谱渲染（OpenSheetMusicDisplay），光标逐音符跟随伴奏时间轴，自动滚动翻页 |
| ✅ | Web Audio 唯一主时钟：谱 / 音 / 背景三方同步，误差听感 <50ms |
| ✅ | 程序化伴奏合成：无伴奏音频时用 OfflineAudioContext 合成夜曲风格伴奏 |
| ✅ | 自研纯 TS **YIN 音高检测**（TDD），演奏结束生成音高对比曲线与音准统计（±50 音分） |
| ✅ | 演奏录音与回放，回放时可同时播放伴奏对照 |
| ✅ | three.js 动态沉浸背景，低频能量驱动光晕与粒子呼吸（audio-reactive） |
| ✅ | 3D 长笛模型入场动画 + 预览页展示，可跳过 |
| ✅ | Electron 桌面壳（Windows 安装包 / 便携版打包） |
| ✅ | 深浅双主题 + 每曲独立强调色（Song Pack 定义） |
| ✅ | Vitest 单元测试覆盖曲谱时间轴 / YIN / 音高统计 |
| ❌ | 移动端 / PWA（规划中） |
| ❌ | CREPE 深度学习音高检测增强（规划中） |
| ❌ | 循环小节练习、速度调节（规划中） |

## ✨ 亮点

> 🎼 **时间即谱面**
> `AudioContext.currentTime` 是唯一时间源 → rAF 每帧换算 → 直写 DOM 驱动光标，不进响应式 store，避免重渲染抖动。

> 🎹 **零素材也能伴奏**
> 没有 mp3 也能跑：按 MusicXML 音符事件程序化合成「旋律 + 低音 pad + 气声 + 混响」的夜曲风格伴奏。

> 🎤 **听得见你的音准**
> 自研 YIN 算法（差分函数 + 累积均值归一化 + 抛物线插值），纯 TypeScript 实现、TDD 全绿，接口化设计可替换为 CREPE。

> 🌌 **演奏也要有氛围**
> three.js 晨光主题场景随音乐呼吸，谱面区域受保护；3.2 秒无操作控件自动隐入，沉浸演奏。

## 🛠 技术栈

| 组件 | 选型 | 理由 |
|---|---|---|
| 工程 | Vite 8 + TypeScript 6 + React 19 | 秒级 HMR；类型安全贯穿曲谱解析与音频管线 |
| 桌面 | Electron 44 + electron-builder | 麦克风低延迟访问 + Windows 安装包 / 便携版一条命令产出 |
| 状态 | zustand 5 | 四视图状态机（`home / preview / perform / result`），轻量无样板 |
| 曲谱 | OpenSheetMusicDisplay 2.1 | 浏览器端最成熟的 MusicXML → SVG 渲染引擎 |
| 音频 | Web Audio API | `AudioContext.currentTime` 唯一主时钟；AnalyserNode 实时分析 |
| 音高检测 | 自研 YIN（纯 TS） | 无依赖、可测试、可替换（接口化封装） |
| 背景 | three.js 0.185 | audio-reactive 粒子场景 + GLTF 长笛模型 |
| 测试 | Vitest 4 + happy-dom | 曲谱时间轴 / YIN / 音高对比统计单测，TDD 工作流 |

## 🚀 快速开始

**环境要求**：Node.js **≥ 20.19**（或 ≥ 22.12，Vite 8 要求）；npm ≥ 10；Windows 下桌面打包需 Visual Studio Build Tools（electron-builder）。

```bash
git clone https://github.com/Romanticjojo/Syrinx.git
cd Syrinx/app
npm install

npm start          # 启动 Electron 桌面应用（开发模式，Vite + Electron 并起）
npm run dev        # 仅浏览器模式 → http://localhost:5173
npm test           # Vitest 单元测试
npm run build      # 生产构建
npm run dist       # Windows 安装包（NSIS）
npm run dist:portable  # Windows 便携版 exe
```

打开后：入场动画（可跳过）→ 曲库选曲 → 详情预览 → **开始演奏**：
4 拍倒数起奏 · 空格 暂停/继续 · ⏺ 录音开关 · 缩放 +/- · Esc 退出。

> ⚠️ **曲目素材不随仓库分发**：`app/public/songs/` 下的谱面 / 伴奏 / 封面（版权媒体）不包含在仓库中，克隆后曲库为空。请按下方 [Song Pack](#-曲目接入song-pack) 规格自行放入曲目，或放入一份任意 MusicXML 快速体验。

> 🎧 建议佩戴耳机演奏：伴奏外放会被麦克风录进演奏录音。

## 📁 项目结构

```
Syrinx/
├── app/                        # 前端工程（Vite + React + TS）
│   ├── electron/               # Electron 主进程与打包资源
│   ├── electron-builder.yml    # Windows 打包配置（NSIS / portable）
│   ├── public/
│   │   └── songs/              # 曲目素材（Song Pack，不入库）
│   ├── src/
│   │   ├── views/              # 四视图：Home / Preview / Perform / Result / SyncTune
│   │   ├── score/              # MusicXML → 时间轴解析（TDD）、OSMD 封装
│   │   ├── audio/              # 主时钟引擎、伴奏合成、录音、PCM/WAV
│   │   ├── pitch/              # YIN 音高检测、对比统计（TDD）
│   │   ├── synctune/           # 对 tune 模式逻辑与状态（TDD）
│   │   ├── background/         # three.js 主题场景、3D 长笛
│   │   ├── components/         # 谱面容器、控制条、音高图表、入场动画
│   │   └── store.ts            # zustand 全局状态
│   └── scripts/                # 渲染 / 截图 / 校验辅助脚本
├── docs/                       # 设计定稿、技术选型、截图
├── plans/                      # 实施计划
└── resources/                  # 素材源（本地私有，不入库）
```

## 🎵 曲目接入（Song Pack）

每首曲子一个素材包，放入 `app/public/songs/<song-id>/`：

```
app/public/songs/<song-id>/
├── manifest.json       # 元数据（见下）
├── score.musicxml      # 曲谱（MusicXML）
├── accompaniment.mp3   # 伴奏音频（可选，缺失则程序化合成）
├── background.mp4      # 动态背景视频（可选，缺失则 three.js 主题场景）
└── cover.jpg           # 封面（可选）
```

```jsonc
{
  "id": "my-song",
  "title": "My Song",
  "composer": "…",
  "difficulty": 2,                  // 1-3
  "durationLabel": "3:45",
  "keyLabel": "C 大调",
  "scoreUrl": "/songs/my-song/score.musicxml",
  "accompanimentUrl": "/songs/my-song/accompaniment.mp3",
  "accent": "#5fb8a8",              // 曲目主题色
  "backgroundTheme": "lumiere",
  "bpm": 90
}
```

图片谱可通过 OMR 管线转成 MusicXML 后按上述规格接入。

## 🗺 路线图

| 阶段 | 内容 | 状态 |
|:---:|---|:---:|
| M1 | 预览 + 渲染：曲库 → 预览 → OSMD 谱面渲染 | ✅ |
| M2 | 同步演奏：时间轴 TDD、谱/音/光标同步、动态背景、沉浸控件 | ✅ |
| M3 | 录音 + 反馈：录音回放、YIN 音准检测、对比图表、3D 入场 | ✅ |
| M4 | Electron 桌面化：主进程、Windows 打包、录音链路修复 | ✅ |
| P1 | 更多曲目 Song Pack、速度调节、循环小节 | 🚧 |
| P2 | CREPE 音高检测增强、混音回放 | 📅 |
| P3 | 多端（PWA / 移动端）、macOS / Linux 打包 | 📅 |

## ❓ FAQ / 已知问题

**Q：克隆后曲库是空的？**
A：正常——谱面 / 伴奏 / 封面属于版权媒体，不随仓库分发。按 [Song Pack](#-曲目接入song-pack) 规格放入 `app/public/songs/` 即可。

**Q：为什么用 Electron 而不是纯网页？**
A：麦克风低延迟采集与本地文件访问在浏览器里受限；桌面壳同时保住了 Web Audio 的低延迟与 AudioWorklet 直采。

**Q：录音导出的 WAV 是静音？**
A：旧版本存在分析支路与录音支路不同源的问题，已改为 AudioWorklet 直采（与分析支路同源）。若仍遇静音，请检查系统麦克风权限与输入设备选择。

**Q：伴奏和光标对不齐？**
A：同步以 `AudioContext.currentTime` 为唯一时钟；若使用外部伴奏音频，请确保 manifest 中的节拍锚点（beats）与该音频对齐。

**Q：不支持 macOS / Linux？**
A：打包脚本目前仅配置 Windows（NSIS / portable）；应用本体是标准 Web 技术栈，跨平台打包在路线图 P3。

**已知问题**：① 入场 3D 动画在部分集显设备帧率偏低（可跳过）；② 曲库为空时首屏视觉较单薄（放一首歌即恢复）。

## 🤝 致谢

- [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) — 浏览器 MusicXML 曲谱引擎
- [three.js](https://threejs.org/) — 3D 背景与长笛模型
- [Electron](https://www.electronjs.org/) / [Vite](https://vitejs.dev/) / [React](https://react.dev/) — 工程基座
- Lorien Testard & Alice Duport-Percier — 《Clair Obscur: Expedition 33》OST（内测曲目素材）

---

## 📄 License

本项目暂未选择开源许可证：**All Rights Reserved** © 2026 Syrinx contributors。
在许可证确定之前，禁止未经作者授权复制、分发或商业使用。后续如以 MIT / Apache-2.0 开源，将在此处与仓库根目录同步 `LICENSE` 文件。

<div align="center">
<sub>吹奏愉快 🎶 — S Y R I N X · 长笛流光</sub>
</div>

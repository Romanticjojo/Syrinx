# Syrinx 🎶

> **Syrinx**（赛琳克斯）— 希腊神话中化为排笛的仙女，德彪西同名长笛独奏曲。
> 长笛演奏辅助应用 / 游戏：曲谱跟随演奏、伴奏同步、自动翻页、动态背景、录音回放、音高检测反馈。

**版本**：0.1.0（MVP 开发中）

## 项目简介

一款**长笛演奏辅助应用（兼具游戏沉浸感）**，定位介于"智能乐谱播放器"与"音乐节奏游戏"之间：

- 用户吹奏真实长笛，应用负责：按伴奏时间轴引导演奏进度（光标跟随谱子）、自动翻页、播放伴奏、录制演奏并回放
- Netflix 式入场预览 → 华丽动态背景（每首歌专属主题视觉）→ 曲谱跟随演奏
- **内容由用户自行准备**（曲谱、伴奏、封面、动态背景素材），应用负责"播放编排 + 交互引导"

**示例曲**：Clair Obscur: Expedition 33 — Nocturne pour Lumière（占位）；首发正式曲目：Luv Letter（DJ OKAWARI）

## 技术栈

| 层 | 方案 |
|---|---|
| 工程 | Vite + TypeScript + React + zustand（四视图 SPA：曲库/预览/演奏/回放） |
| 曲谱渲染 | OpenSheetMusicDisplay（MusicXML，光标跟随 + 主题染色） |
| 音频 | Web Audio API 唯一主时钟（伴奏合成/播放、MediaRecorder 录音） |
| 音高检测 | 自研 YIN 算法（TDD，纯 TS） |
| 背景 | three.js 主题场景（外部素材可替换） |
| 测试 | Vitest + happy-dom（TDD 全绿） |

## 目录结构

```
D:\Syrinx\
├── app\              前端工程（npm run dev 启动）
├── docs\
│   ├── 需求与调研\    需求文档、可复用项目调研
│   ├── 技术选型\      技术栈选型与对比
│   ├── 设计\          设计定稿（A 夜航晨光 ★）、三方向方案对比
│   └── 交接说明.md    任务移交要点
├── plans\            实施计划（superpowers 工作流）
├── resources\        素材（图片/模型/曲目素材投放区）
└── README.md
```

## 快速开始

```bash
cd app
npm install
npm run dev        # 开发服务器
npx vitest run     # 跑测试
npm run build      # 构建
```

## 设计定稿

方向 **A「夜航晨光」**（用户 2026-08-30 决策）：Netflix 编辑感 hero、暖金 `#d9a441` + 晨光青 `#5fb8a8` 双色、衬线大标题、玻璃谱面板。
三方向对比与取舍详见 `docs/设计/设计对比与定稿.md`，同屏预览 `docs/设计/对比总览.html`。

## 曲目素材（Song Pack）

每首曲子一个素材包，放入 `resources/<song-id>/`：
`score/`（曲谱，MusicXML 优先）、`accompaniment/`（伴奏）、`cover/`（封面）、`background/`（动态背景）。
接入后按 `app/public/songs/<song-id>/manifest.json` 格式归档（参考 lumiere 示例）。

## 开发约定

- 编码/设计由 Claude Code + superpowers-zh 全流程管控（writing-plans → executing-plans → verification-before-completion）
- 中文提交信息；每个里程碑独立 commit

# 任务：同步调试界面（独立页面）——手动微调光标节奏

> Skill 参考：`syrinx-score-sync-tuning`（Hermes skills 库 devops/）——含完整界面布局、交互约定、技术要点与 AI 产线背景。
> 产出物：beats.json v6 已上线（601 控制点，onset 命中率 0.772），剩余 ~23% 无清晰起音峰的音符需人工耳朵微调。
> 本任务只做**独立调试页面**，不改动演奏页（PerformPage）。

## 目标

新增路由 `/sync-tune/luv-letter` 的独立调试页（Vite + React + TS），用于微调 `beats.json` 的 `beatAnchors` 控制点（谱面四分音符位 q ↔ 伴奏秒 t），使光标节奏与伴奏逐音对齐。

## 界面与交互（按 skill 第二节执行，要点复述）

1. 三栏布局：左=音符列表（当前小节±2，可按「已调/未调」过滤）；中=OSMD 谱面（97 小节展开线性谱，控制点标记层+光标，语义同演奏页）；右=选中音属性面板（q/当前t/修正t/偏差，±10/50/100/200ms 按钮，重置/试听 A/B）。
2. 底部：伴奏波形总览（Web Audio decodeAudioData + canvas 峰值包络）+ 控制点刻度 + 视口拖拽缩放；波形上叠画「谱面 onset 期望位置」细线。
3. 三向选中同步：谱面点音符 / 列表点行 / 波形点刻度。
4. 快捷键：`[`/`]`=±50ms、`{`/`}`=±200ms、空格=播放/暂停、Enter=试听 A/B（修正前/后各播 -1s→+2s 窗口）、Ctrl+Z=撤销。
5. 保存：内存 diff，保存时对无控制点的 q 插入新 `{q,t}`、有则改；写回 `beats.json`（version+1，note 追加人工记录）；MVP 允许「导出 JSON → 用户覆盖 beats.json」两步走，免后端。
6. 人工修正日志：`manual_offsets.json`（`{q, deltaMs, ts, note}` 追加），供离线产线重跑后重放。

## 技术约束

- 谱面渲染复用 `OSMDScore`（load(expandedXml, timeline)）；选中音↔q 换算复用局部段速率逻辑（参考 `anchors.test.ts` 的 `noteQOf`/`localRateOf`——**禁止全局 secPerQuarter 直算**，谱有 76→86→76 变速）。
- 音频与播放走现有 `AudioEngine`（唯一时钟源），不新起时钟。
- 路由不进曲库导航；`import.meta.env.DEV` 或 `?debug=1` 才可见入口。
- 状态管理：微调 diff 用本地 store（zustand），不进全局演奏态。
- 不动 `musicxml.ts` / `anchors.ts` / `OSMDScore.ts` 的现有行为；如需扩展 `OSMDScore`（控制点标记层），以新增可选方法实现，缺省行为不变。

## 验收

- [ ] vitest 全绿（新增组件/逻辑测试：选中同步、±ms 微调、插入新控制点、撤销栈、试听 seek 计算）+ `tsc --noEmit` 通过
- [ ] 手动走查：选中→微调 50ms→波形期望线实时移动→保存导出→覆盖 beats.json→演奏页光标随新锚点移动
- [ ] 撤销栈正确回滚内存 diff
- [ ] 提交 `feat: 同步调试界面（/sync-tune）——手动微调 beatAnchors 控制点`

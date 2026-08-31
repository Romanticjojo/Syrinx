# 任务：applyBeats 支持拍级锚点（beats v4），细节节奏微调落地

> 背景：用户反馈「整体节奏对了、细节仍不对」。Hermes 离线分析证实：v3 只有 97 个小节锚点，
> 小节内部线性插值——谱面音符 onset 对伴奏 onset-flux 的命中率仅 0.334（随机基线 0.324），
> 几乎等于随机。Hermes 已完成拍级精调（产物 beats_v4.json，命中率 0.564，提升 1.69x）。
> 本任务只改应用端消费逻辑，**不重新分析音频**。

## 数据（已就绪，勿重算）

`resources/luv-letter/score/omr-work/beat_refine/beats_v4.json`（由 `beat_refine/refine_beats.py` 生成）：
- 保留 v3 全部字段（songId/version=4/bpm/anchors(97 小节)/end）
- 新增 **`beatAnchors: [{q, t}]`**：388 个拍级控制点，`q` = 播放序四分音符位置（0,1,2,…,387），`t` = 伴奏秒。每播放小节 4 个点：beat0=小节锚点（DTW 实测），beat1-3 = onset-flux 局部吸附（±0.30 拍距窗口）。
- 生成脚本与校验记录同目录（onset 命中率 0.564 vs 小节级 0.334，脚本里有随机基线对照）。
- 需要 v4 上线：把 beats_v4.json 内容替换 `app/public/songs/luv-letter/beats.json`（旧版先 git 有底）。

## 应用端改动（src/score/anchors.ts）

`applyBeats(timeline, beats)`：当 `beats.beatAnchors` 存在且长度 ≥ 2 时，用拍级网格替代小节级插值：

1. **q→t 映射**：beatAnchors 按 q 升序；对任意四分音符位置 q，找相邻两控制点线性插值（q 落在首点之前用首段斜率外推，落在末点之后用末段斜率外推）。
2. **measureTimes**：每项 time = q2t(其 quarters)。
3. **notes**：time = q2t(音符的播放序四分音符位置)。注意：现在 notes 的重映射经 `fakeRate(k)` 中转（假 tempo 系换算），拍级路径下应直接用**谱面四分音符位置**：`noteQ = measureTimes[k].quarters + (n.time - mt[k].time) / oldSecPerQuarter`——实现时以「把恒速系的音符位置换算成播放序 q，再过拍级网格」为准，别再用 fakeRate 链路；duration = (q1-q0 段内斜率) × durQuarters。
4. **回退**：无 beatAnchors 或结构不合法 → 现有小节级逻辑原样保留（Nocturne/晨间练习两曲无 beatAnchors，必须不受影响）。
5. **durationSec / tempo / applyAnchorOffset** 语义不变。

## 测试（vitest）

1. `anchors.test.ts` 加用例：带 beatAnchors 的 beats 应用后，音符时刻落在拍级网格上（例：q=5.5 → 用 beat4(q=4,t) 与 beat6(q=6,t) 插值，不是小节级等分）。
2. 无 beatAnchors 的 beats 走旧路径（现有用例全绿即可，别改它们的期望值）。
3. 回归钉子：加载 luv-letter 真谱 + beats_v4，断言 `notes[].time` 与离线产物对照——抽样 10 个音（含 m1 首音、m70 全音符、m97 终音），拍级网格下误差 < 0.05s。
4. 全量 `npx vitest run` + `npx tsc -p tsconfig.json --noEmit` 通过。

## 边界与约束

- 不动 musicxml.ts / expandRepeats / OSMDScore（音值感知推进已上线）。
- beatAnchors.q 是整数（388 个），但插值函数按任意 q 写，别写成整数专用。
- 若 beats.json v4 的 anchors 与 v3 有任何不一致（应无），以 v4 为准并报告。
- 提交：`fix: applyBeats 支持拍级锚点，luv-letter 细节节奏对齐伴奏（onset 命中率 0.33→0.56）`，附测试输出。

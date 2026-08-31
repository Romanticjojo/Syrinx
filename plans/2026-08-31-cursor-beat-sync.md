# 任务：光标与伴奏拍子同步修复（音符时值感知推进）+ 时间轴交叉校验

> 来源：用户实测反馈「光标跟伴奏完全对不上、拍子是乱的——第 8 小节明明是很长的音，光标很快掠过」。
> 诊断与方案：Hermes 已完成全链路代码审查（2026-08-31），病根与修法如下，按此实施。
> 交叉校验基准：`docs/需求与调研/曲谱解析/luv_letter_timeline.json`（独立展开的 97 小节 / 998 事件时间轴）。

## 一、病根（已定位，勿重新排查从零开始）

`src/score/OSMDScore.ts` 的 `syncToTime()`（约 122-131 行）：

```ts
while (!it.EndReached && this.timeAtQuarters(it.currentTimeStamp.RealValue) <= t && guard < 2048) {
  cursor.next()
```

条件是「**当前**光标下音符的开始时间 <= t」→ 音符一响光标就 next() 走人，**高亮永远趴在下一个还没响的音上**。长音（二分/全音符）被瞬间掠过，后面短音反而长时间高亮——用户看到的「拍子乱」。

**数据层没有问题，不要动**：
- `musicxml.ts` 已正确解析 `duration/divisions`（=几分音符时长，用户设想的「音符 tag」已存在）；
- `anchors.ts` 的 `applyBeats` 已把 notes/measureTimes 重映射到伴奏锚点系。

## 二、任务 A：光标改为「音值感知」推进（核心）

改 `OSMDScore.ts`，不动 `musicxml.ts` / `anchors.ts` / `PerformPage.tsx`：

1. `load()` 完成后，用 `osmd.cursor` iterator **预扫一遍**（记录后 reset），缓存每个光标停靠点的四分音符位置 `stopQuarters[]`（`it.currentTimeStamp.RealValue * 4`）。OSMD cursor 在音符级停靠（voiceEntry 级），预扫即可拿到全部停靠点，无需改 OSMD 源码。
2. `syncToTime(t)` 改为：`while (timeAtQuarters(stopQuarters[nextIdx]) <= t) next()`——即「**下一个**停靠点的开始时刻已到才前进」。效果：光标/高亮停在**正在响的音**上，直到该音实际时值结束。
3. 语义保持：
   - 只前进不后退（seek 用 `resetCursor()` + 快进，现有机制不变）；
   - `guard` 上限保留（预扫后可直接按 `nextIdx` 走，`nextIdx` 随 reset 归 0）；
   - `timeAtQuarters` 分段插值逻辑复用（锚点系换算不变）；
   - 小节回调 `onMeasureChange` 行为不变。
4. 边界：曲末（`EndReached`）不再推进；预扫结果为空时回退现行为（防御）。

## 三、任务 B：时间轴交叉校验（加固 + 回归测试）

1. 新增单元测试（放 `src/score/`，vitest）：
   - **长音停留测试**：构造含 `全音符+四分音符` 的迷你谱（或直接用 luv-letter 谱的 m8/m70），断言：`t` 在全音符开始后、结束前的时刻，光标仍停在全音符上（`GNotesUnderCursor` 命中该音 / `nextIdx` 未越过）；只有 `t >= 全音符结束时刻` 才推进到下一音。
   - **锚点系一致性**：`applyBeats` 重映射后的 `notes[].time` 与 `luv_letter_timeline.json` 的 `t0_sec` 逐小节比对，误差 > 0.35s 的小节列出来（beats.json 备注自述残差 ±2.6s，先出报告不改数据；若整体系统性偏移，报告即可，钳位/修锚点是后续任务）。
   - timeline JSON 放 `src/score/__fixtures__/luv_letter_timeline.json`（从 docs 目录拷贝，测试可 import json）。
2. 全量 `npx vitest run` + `npx tsc -p tsconfig.json --noEmit` 必须通过。

## 四、验证清单（完成的定义）

- [ ] vitest 全绿（含新增长音停留测试与锚点一致性测试）
- [ ] tsc 无错
- [ ] CDP/浏览器实测演奏页：m8 长音（或 m70 全音符 Bb5）高亮停留时长 ≈ 音符时值（4/4 全音符 ≈ 2.67s @90bpm），不再是瞬间掠过
- [ ] seek/跳转/回开头后光标行为正常（只前进语义未破坏）
- [ ] 实时音准对比（`noteAt`）不受影响：它消费的是 timeline.notes，本次不改其语义

## 五、约束

- 不改 `musicxml.ts`、`anchors.ts` 的对外行为；不动 `beats.json`；不动谱面 XML。
- 提交信息格式沿用仓库惯例（`fix: ...`），附验证证据（测试输出 + 截图）。
- 若实施中发现本文件与代码现状冲突（行号漂移等），以「任务 A 语义描述」为准，语义不得偏离。

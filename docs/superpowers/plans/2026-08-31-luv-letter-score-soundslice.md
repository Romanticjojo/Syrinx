# Luv Letter 谱面替换（Soundslice 精校版）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 luv-letter 谱面替换为 Soundslice 精校版（72 小节 + m45 修复 + 3 处 vibrato wavy-line），重标定 beats.json 锚点（v3），测试全绿，单 commit 交付。

**Architecture:** 决策书 t_76c0cbff。唯一事实源 `D:\LLM_work\soundslice-omr\luv-letter-final.musicxml`。应用侧 `loadSong` 会无条件执行 `expandRepeats` 物化反复段，故锚点必须按**展开后播放序**标定；展开语义以 chroma-DTW 对伴奏的局部代价实证择优（复用 9295b7e 的 t_d02450b9 管线方法论：ffmpeg 取音 → 谐波合成 → chroma → DTW）。

**Tech Stack:** MusicXML、Node（happy-dom + 应用自身 expandRepeats）、Python 3.11 + numpy + ffmpeg（离线 DTW）、vitest、tsc、vite。

**Spec:** 决策书（会话内嵌）+ 本计划的「实证决策记录」。计划与决策书冲突处按决策书兜底条款「严格以最终版 XML 为准」执行，commit body 注明。

## 实证决策记录（偏离决策书的部分，均因最终版 XML 实际内容与决策书「关键事实」不符）

1. **divisions=16 而非 4** → 每小节 tick 总和 = 64（4×divisions），测试按 `4*divisions` 断言。
2. **含 7 对 `<repeat>` + volta（`<ending>`）**，非「无 repeat」→ `loadSong` 的 `expandRepeats` 会物化展开；锚点按展开后小节序标定。现实现不支持 volta（二遍会重放一房子），需先修复（TDD）。
3. **无 `<voice>` 标签**（Soundslice 导出省略）→ 旧测试「仅 voice 1」断言改为「无 backup/chord 残留 + 解析出的主声部音符数正确」。
4. **真实 tempo 标记 76/86/76**，非恒速 90 → DTW 合成按谱面 tempo 图（76/86）累计；beats.bpm 字段语义为锚点间插值兜底速率，随 DTW 实测另定（倾向 76）。
5. **重复段是否真被伴奏演奏、一房子跨度语义** → 不手推，跑 4 个展开候选取 DTW 代价最低者。
6. **「wavy-line 出现 3 次」**：文件实况 = 行 9853 两个 `<wavy-line type="start"/>`（同一行）+ 行 10040 一个，合计 3 个元素，断言按元素计数 3 成立。
7. **终点**：决策书「≈269s」与旧锚点/时长推算（末小节 ≈256s 起 + 尾音）存在张力 → 以 DTW 实测为准，`end` 字段保持伴奏全长 270.39，commit 注明。

## 全局约束

- 唯一事实源 XML 原样拷贝，不改内容、不重排版。
- 锚点单调递增、无负值、m1≈0.2s。
- beats.json `version` → 3，note 更新为新谱来源。
- 单 commit：`feat: Luv Letter 谱面替换为 Soundslice 精校版（72 小节 + m45 修复 + vibrato）`。
- 并发工作区：`anchors.ts`/`anchors.test.ts`/`manifest.json` 内有他人任务 t_b3080db9（applyAnchorOffset）未提交改动——提交时按 hunk 拆分，只暂存本任务改动，不整体 add 共享文件。

---

### Task 1: expandRepeats 支持 volta（一房/二房）——TDD

**Files:**
- Test: `app/src/score/musicxml.test.ts`（追加 volta 用例）
- Modify: `app/src/score/musicxml.ts`（expandRepeats）

**Interfaces:**
- Produces: `expandRepeats(xml: string): string`——签名不变；语义升级：遇到 `<ending>` volta 结构时，反复第二遍跳过一房子小节（含与 backward repeat 之间无标记小节的两种语义，按 Task 3 实证结果定，默认标准语义：一房子延伸到 backward repeat 所在小节）。

- [ ] **Step 1: 写失败测试**——构造含 `|: A |1 B :|2 C` 的最小 XML（forward 在 A 左 barline、B 右 barline ending1 stop+backward、C 左 barline ending2 start），断言展开结果 = `A B A C`（标准语义）。
- [ ] **Step 2:** `npx vitest run src/score/musicxml.test.ts` → 期望 FAIL（现实现产出 `A B A B C`）。
- [ ] **Step 3: 实现**——expandRepeats 模拟演奏序时维护「当前反复段的遍数」：小节左 barline 带 `ending number` 且遍数不在其 number 列表 → 跳过该 ending 块（到对应 stop 为止）；backward repeat 触发回跳时遍数 +1。无 `<ending>` 的朴素反复行为保持不变（现有测试守护）。
- [ ] **Step 4:** `npx vitest run src/score/musicxml.test.ts` → PASS。
- [ ] **Step 5:** 暂不 commit（与 Task 4/5 合并单 commit）。

### Task 2: omr-check.test.ts 重写（RED）+ 替换谱面（GREEN）

**Files:**
- Modify: `app/src/score/omr-check.test.ts`
- Replace: `app/public/songs/luv-letter/score.musicxml` ← `D:\LLM_work\soundslice-omr\luv-letter-final.musicxml`

- [ ] **Step 1: 重写断言（先 RED）**：小节数 72（印谱）；每小节 duration 和 = 4×divisions（divisions=16 → 64）；`wavy-line` 元素计数 = 3；m45 duration 和 = 64；无 `<backup`/`<chord`；新增：expandRepeats 展开后小节数与 Task 3 实证播放序一致（数量断言，防止展开回归）。保留 OSMD e2e 注释。
- [ ] **Step 2:** `npx vitest run src/score/omr-check.test.ts` → 期望 FAIL（旧 73 小节谱）。
- [ ] **Step 3:** `Copy-Item D:\LLM_work\soundslice-omr\luv-letter-final.musicxml app\public\songs\luv-letter\score.musicxml`（原样，不改内容）。
- [ ] **Step 4:** 同命令 → PASS（anchors 真实数据测试除外，beats v3 未落地前保持 RED）。

### Task 3: DTW 实证展开语义 + 重标定 beats.json v3

**Files:**
- Create: `resources/luv-letter/score/omr-work/t_76c0cbff/align72.py`（自包含：解析印谱 → 4 候选展开 → 谐波合成（76/86 tempo 图）→ chroma → DTW → 候选对比 + anchors JSON）
- Create: `resources/luv-letter/score/omr-work/t_76c0cbff/finalize_beats.py`（锚点清理 + onset flux 校验 → beats v3 候选）
- Modify: `app/public/songs/luv-letter/beats.json`

候选：C0 印谱线性 72（忽略反复）；C1 标准 volta 展开（一房子延伸到 backward 小节，第二遍跳过）；C2 朴素 volta（仅跳一房子括号内小节，无标记的 backward 小节每遍都奏）；C3 volta 段直通（一房+二房连奏不反复）+ 无 volta 反复段物化。

- [ ] **Step 1:** 写 `align72.py` 并运行（hop=0.1s），对比各候选总代价/分段代价/锚点平滑度，记录赢家。
- [ ] **Step 2:** 赢家若非 C1 标准语义 → 回改 Task 1 的 expandRepeats 语义与测试期望，保持一致。
- [ ] **Step 3:** 写 `finalize_beats.py`：MIN_GAP 清理、onset flux hit-rate 校验（>基线+3σ PASS）、m1 钳 0.2s、单调校验；产出 beats v3（songId/bpm/note 更新/anchors/end=270.39），先写 `beats72.json` 候选。
- [ ] **Step 4:** 校验通过后覆盖 `app/public/songs/luv-letter/beats.json`（version 3）。
- [ ] **Step 5:** 更新 `anchors.test.ts` 真实数据测试：锚点数 = 展开后小节数、m1≈0.2s、末锚点 + 终点外推 = durationSec、抽查音符不早于小节锚点（避免整体 add，提交时按 hunk 处理）。

### Task 4: 全量验证

- [ ] `npx vitest run` 全绿
- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run build` 成功

### Task 5: 验收（浏览器实测）

- [ ] `npm run dev` 起服务，控制台无错误（复用 scripts/ 下现有 playwright 截图脚本模式）
- [ ] OSMD 渲染正常：反复记号/volta 可见，vibrato 波浪线在印谱 m70/m72 对应位置可见
- [ ] 光标对齐：印谱 m1、m36、m70 对应的展开小节锚点与伴奏 ±0.5s（用 beats.json + 展开映射脚本核对，配合演奏页截图）

### Task 6: 交付

- [ ] 单 commit（按 hunk 暂存共享文件）：`feat: Luv Letter 谱面替换为 Soundslice 精校版（72 小节 + m45 修复 + vibrato）`，body 列：谱面来源、beats v3、expandRepeats volta 修复、测试改动、实证决策记录、验收结果。
- [ ] commit hash + 验收结论写回看板 t_76c0cbff。

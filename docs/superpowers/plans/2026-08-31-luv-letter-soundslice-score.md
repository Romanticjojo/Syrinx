# Luv Letter 谱面替换 Soundslice 精校版（t_76c0cbff）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 luv-letter 谱面整体替换为 Soundslice 精校版（72 小节印谱 + 7 对反复 + volta + 3 处 vibrato），重标定 beats.json v3 锚点，测试全绿，单 commit 交付。

**架构：** 应用管线是 `expandRepeats(raw) → parseMusicXml → applyBeats`。新谱带反复记号，展开后小节号被重编为播放序 1..97（`musicxml.ts:103` `setAttribute('number', String(seq+1))`），因此 **beats v3 锚点按展开后播放序 1..97 标定**（chroma-DTW 对伴奏全曲对齐，前人管线 `resources/luv-letter/score/omr-work/t_76c0cbff/`），锚点天然单调唯一，反复段无时间戳回跳问题。

**技术栈：** TypeScript + vitest + OSMD（应用侧）；Python numpy + ffmpeg（离线 DTW/finalize 管线，已就绪）。

---

## 已核实事实（不再重查）

- `app/public/songs/luv-letter/score.musicxml` **已替换完成**：与 `D:\LLM_work\soundslice-omr\luv-letter-final.musicxml` 逐字节一致；72 小节、divisions=16（每小节 64 tick，决策书中"divisions=4"为笔误，以实际文件为准）、wavy-line×3、software=Soundslice。
- `app/src/score/omr-check.test.ts` **已重写完成**（新谱断言全绿）。
- `app/src/score/musicxml.ts` + `musicxml.test.ts` 的未提交改动全部属于本任务（expandRepeats volta 支持 + 新测试）；其中 1 个 RED：展开后残留 `<ending>`（`musicxml.test.ts:162`）。
- `anchors.test.ts` 未提交改动 = 其他任务 t_b3080db9 的 applyAnchorOffset 测试块（勿提交）；`anchors.ts` 的 applyAnchorOffset、`manifest.json` 的 anchorOffsetMs、`types.ts`、`songs/index.ts`、`views/*` 同属 t_b3080db9（勿动勿提交）。
- 旧谱（HEAD）73 小节、0 反复记号；新旧小节映射：m1–45 恒等、旧 m46 幻影、旧 m47–54→新 m46–53、m54–61 区旧谱 OMR 重建段编号不可靠、旧 m72 幻影、旧 m73→新 m72。**不再走"旧锚点平移"路线**，采用 C1 DTW 候选。
- `align72_results.json` 四候选中 **C1-app-SemA 的 order 与应用 expandRepeats 实际展开序逐项相等**（已验证 True），97 小节，首锚 0.0s、末锚 257.1s。
- 伴奏 `accompaniment.mp3` 270.47s，`beats.end` 字段 applyBeats 不消费（仅记录），保持 270.39。
- C1 抽查：seq46（印谱 m36）t=122.9（旧 v2 121.75，差 1.15s，属 DTW 正常残差）；验收以新锚点自身与伴奏的对齐为准。

---

### 任务 1：修 expandRepeats 展开后 `<ending>` 残留（RED 已存在）

**文件：** 修改 `app/src/score/musicxml.ts`（expandRepeats 内，约 :104 附近 clone 清洗处及最终序列化前）

- [ ] 步骤 1：运行 `npx vitest run src/score/musicxml.test.ts`，确认 `luv-letter 精校谱展开后无 repeat/ending 残留` FAIL（`<ending` 残留）
- [ ] 步骤 2：在 expandRepeats 物化输出处剥离 `<ending>` 元素（与 `<repeat>` 同样处理：`querySelectorAll('ending').forEach(r => r.remove())`，覆盖原始块与克隆块两条路径——按实际代码结构放置，保证输出 XML 不含 `<ending`）
- [ ] 步骤 3：`npx vitest run src/score/musicxml.test.ts` 全绿（含 volta 跳段、D.C. no-op 等既有用例）
- [ ] 步骤 4：不单独 commit（与本任务其余文件同一 commit）

### 任务 2：跑 finalize 管线产出 beats v3 候选并落地

**文件：** 创建 `app/public/songs/luv-letter/beats.json`（覆盖，version 2→3）

- [ ] 步骤 1：`python resources/luv-letter/score/omr-work/t_76c0cbff/finalize_beats.py C1-app-SemA`（cwd=app，脚本内路径均为绝对路径）。要求 onset flux hit-rate 校验 **PASS**（r_real > base+3σ）；产出 `t_76c0cbff/beats72.json`
- [ ] 步骤 2：审查 beats72.json：97 锚点、严格递增、无负值、首锚 ≈0–0.2s、末锚 ≈257s、version=3、bpm=90、note 说明新谱来源。若 PASS 失败或锚点异常（间隔 <1.5s 被强推、越界），回 align72 换 C2 候选重跑并在 commit 注明
- [ ] 步骤 3：拷贝 beats72.json → `app/public/songs/luv-letter/beats.json`（内容原样，不改格式）

### 任务 3：重写 anchors.test.ts 真数据测试（TDD）

**文件：** 修改 `app/src/score/anchors.test.ts:107-130`（仅 luv-letter 真数据用例；**applyAnchorOffset 测试块属 t_b3080db9，保留在工作区、不纳入本任务 commit**）

- [ ] 步骤 1：改写用例为 v3 语义（先于任务 2 步骤 3 落地时为 RED）：`expandRepeats(xml)` → `parseMusicXml` → `applyBeats(beats)`；断言：beats.anchors 长度 97 且 t 严格递增且 ≥0；version=3；out.tempo=90；measureTimes[0].time≈anchors[0].t；measureTimes[96].time≈anchors[96].t；终点标记 measureTimes[97]≈末锚+4×(60/90)；durationSec≥末锚；抽查印谱 m36（播放序 seq46）与 m70 首遍（播放序 seq92）时刻与 beats72 值一致（±0.01）；notes 重映射后不早于所属小节锚点（抽查 seq46/seq92/seq97）
- [ ] 步骤 2：任务 2 步骤 3 落地后 `npx vitest run src/score/anchors.test.ts` 全绿

### 任务 4：全量验证

- [ ] 步骤 1：`npx vitest run` 6 文件 46+ 用例全绿
- [ ] 步骤 2：`npx tsc --noEmit` 无错误
- [ ] 步骤 3：`npm run build` 成功

### 任务 5：浏览器验收（决策书任务 4）

**文件：** 复用/调整 `app/scripts/e2e-perform-play.mjs` 或 `verify-t_d02450b9.mjs` 的模式

- [ ] 步骤 1：起 `npm run dev`，脚本进入 luv-letter 演奏页：收集 console error（要求 0）
- [ ] 步骤 2：截图确认 OSMD 渲染正常、m70/m72 上方波浪线可见（OSMD 对 wavy-line 的支持以实际渲染为准，如实报告）
- [ ] 步骤 3：游标对齐核验：headless 计算 `applyBeats(parseMusicXml(expandRepeats(xml)), beats)`，检查 seq1（m1）、seq46（m36）、seq92（m70 首遍）锚点处谱面小节号与伴奏时刻一致（±0.5s 窗口内小节号正确）；浏览器侧用 seek 到这三个时刻截图核对光标小节
- [ ] 步骤 4：验收产物截图存 `docs/screenshots/`（可选）

### 任务 6：单 commit 交付（逐文件 add，防混入 t_b3080db9）

- [ ] 步骤 1：提交清单（仅本任务）：
  - `app/public/songs/luv-letter/score.musicxml`（已改）
  - `app/public/songs/luv-letter/beats.json`（v3）
  - `app/src/score/omr-check.test.ts`（已改）
  - `app/src/score/musicxml.ts`（ending 剥离 + volta）
  - `app/src/score/musicxml.test.ts`（新谱用例）
  - `app/src/score/anchors.test.ts`（**仅真数据用例 hunk**：先构造 HEAD+本任务改动 的中间内容 `git add`，再恢复含 t_b3080db9 块的工作区版本）
  - `resources/luv-letter/score/omr-work/t_76c0cbff/`（管线脚本 + 产物，beats.json note 引用了它）
  - **排除**：manifest.json、anchors.ts、types.ts、songs/index.ts、views/*、resources 其他改动、临时对比脚本（compare-scores/align-measures/dump-region）
- [ ] 步骤 2：commit message：`feat: Luv Letter 谱面替换为 Soundslice 精校版（72 小节 + m45 修复 + vibrato）`，body 列谱面来源、beats v3（97 播放序锚点 + DTW/onset 校验）、测试改动、验收结果、决策偏差注记（divisions 实为 16；m1 锚点 DTW 实测 0.0s；repeat 段锚点按展开播放序标定）
- [ ] 步骤 3：commit 前核对 `git log` 与 `git status`，确认 staged 清单与上方一致

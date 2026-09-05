# 曲谱产线二期交付报告（t_0ad1f095）

日期：2026-09-04 · 分支：dev · 提交：`6f87325`（留在 dev）

## 验收清单

- [x] 4 个 `app/public/songs/<id>/` 目录齐全（manifest / score.musicxml / beats.json / accompaniment.mp3；flower 与 expedition 另有 cover.jpg，river 与 birds 无可用封面、coverUrl 留空）
- [x] 每首小节校验通过（清洗修法见各曲一节；校验与 diff 脚本留档 `D:/Syrinx/resources/song-pipeline2/`）
- [x] 每首 beats.json 结构硬断言通过（q/t 严格单调、≥2 项、anchors 覆盖全部小节、首点 ≤ lead+2s）+ 质量报告（残差中位/P95、恒速偏差只做软报告）
- [x] SONGS 数组登记 ×4，dev server 冒烟通过（5 个曲谱 URL + manifest/beats/mp3/cover 端点全部 HTTP 200）
- [x] npm test 全绿：**22 文件 / 219 用例全部通过**（基线 203 + 新增 16）；npm run build 全绿（tsc + vite，仅既有 chunk>500kB 警告）
- [x] git 提交干净：仅 2 个自己文件（见改动点清单）；`public/songs/` 整体被 .gitignore 忽略（luv-letter 同策略，媒体/谱面/manifest 均不入库）
- [x] 本报告落位

## 产线与方法（共享目录）

产线脚本与中间产物在 `D:/Syrinx/resources/song-pipeline2/`（`clean_score.py` 清洗、`diff_score.py` 逐小节语义 diff、`make_beats.py` beats 生成、`inspect_score.py` 等诊断）。beats 生成放弃 luv-letter 的 DTW 路线（纯旋律 chroma 模板在丰满伴奏里匹配面平坦），改为 **onset-梳状对齐**：音频段间隙切分 → 段级 DP 块划分（块 = 音符区间，网格搜索速率×相位，音高门控质量分）→ 段内 24 音块链吸收 rubato（相位弱二次回拉防密织体随机游走）→ 有界抛光吸强 onset。纯 numpy + ffmpeg，无 librosa 依赖。

## 各曲交付

### 1. flower-dance（Flower Dance / DJ OKAWARI / 难度 3 / 4:21）

- 谱面：106 小节 / 1216 音 / 424q，div=48，tempo m1=77 → m9(q32)=100，无反复。清洗：m38 删 backup/forward 元素与伪声部音符 G#5、m71 删 backup 并修首音时值（八分误读改十六分）；逐小节 diff 仅登记修复点有差异。
- beats：控制点 877/1216 音符，beatAnchors 938（877 证据 + 61 名义拍填充），anchors 106 全覆盖。残差（对分段直线参考）中位 **+0.10s** / P95 +1.11s / 范围 [−1.07, +2.97]；结构跳变仅 2 处（m8/m9 tempo 换速过渡 ±1.5s 内）。onset 命中 **0.786**（随机基线 0.372，**2.11×**——本曲伴奏 onset 极密、基线天然高）。分段拟合 82/100 bpm，与谱面标注一致。
- **质量分级：良**。双 tempo 段均锁定，中后段 100bpm 区间逐小节 2.4s 稳定推进；仅换速边界一小节有 ~1.5s 过渡误差。
- manifest：accent `#e0a878` 琥珀、主题 aurora、bpm 99、有封面。

### 2. river-flows-in-you（River Flows in You / Yiruma / 难度 2 / 3:06）

- 谱面：OMR 原谱 50 小节含 **7 个幻影小节**（m30/31 为 m26/27 的高八度重复读页，m41–44/49 为重复段误读；经伴奏 onset 网格 + chroma 指纹逐段证实音频未演奏），删除后 **43 小节 / 386 音 / 172q**，div=32，tempo 66，无反复。备份 `resources/river_flows_in_you/score/omr-work/score_before_phantom_fix.musicxml`。
- beats：控制点 141/386，beatAnchors 219，anchors 43 全覆盖；硬断言全过。伴奏实际为三段速率：前奏 ~0.87s/q（≈69bpm）、B 段 m22–29 演绎为 **1.83× 半速（1.665s/q）**、尾声 1.26×（1.145s/q）——三段速率与段落归属全部锁定正确。onset 命中 0.769（基线 0.184，**4.18×**）。
- **质量分级：可用**。已知问题：B 段相位统一 +3.4~3.8s 滞后（重复旋律细胞织体里 onset 梳在「错整拍」上质量近乎同高，raw/立方两代打分均无法进一步分辨；速率正确故为均匀平移而非漂移）。演奏中 B 段光标恒滞后约 3.5s，段边界后自行恢复；对「看谱跟练」场景可用，精确逐音对照该段需自行心里平移。
- manifest：accent `#89a9d8` 静水蓝、主题 lumiere、bpm 62（控制点速率中位）、无封面（mp3 无内嵌封面流，coverUrl 留空）。

### 3. expedition-33（Expedition 33 / Lorien Testard / 难度 2 / 3:34）

- 谱面：66 小节 / 301 音 / 264q，div=16，tempo 83，无反复。清洗：m48 half rest→whole rest（2 拍误读补足 4 拍）。
- beats：控制点 202/301，beatAnchors 311，anchors 66 全覆盖。**演奏实际均速 ≈74bpm，比谱面标注 83 慢 12%**（渐慢型演绎，264q 铺满 214s），链式速率自适应全程吸收、无压挤。残差（对恒速直线）中位 +4.63s / P95 +5.35s——rubato 曲目对恒速参考的天然发散（软报告项，非缺陷）；结构跳变 4 处（±1.2~2.2s，段落过渡）。onset 命中 0.799（基线 0.411，**1.95×**，同为高基线密织体）。
- **质量分级：良**。小节锚点与乐句推进连贯，变速被如实跟随；末段 4 小节有 ~2s 均匀提前量。
- manifest：accent `#b9a0d8` 紫灰、主题 ember、bpm 83（谱面标注诚实保留）、有封面。

### 4. birds-poem（鸟之诗 / Key Sounds Label 折戸伸治 / 难度 2 / 3:57）

- 谱面：93 小节 / 438 音 / 372q，div=16，tempo 96，无反复；逐小节校验直接通过，无修复。
- beats：控制点 238/438，beatAnchors 418（238 证据 + 180 名义填充），anchors 93 全覆盖。onset 命中 **1.002**（基线 0.191，**5.26×**）——绝对命中率 1.00 高于本产线 v4 基线的 0.976，为四首最佳。残差中位 +1.59s；结构跳变 8 处（±1.2~2.7s，均为乐句呼吸/过渡型）。
- **质量分级：优**。逐乐句对齐质量高，适合精跟练习。
- manifest：accent `#d8a2b8` 晨粉、主题 lumiere、bpm 96、无封面（mp3 无内嵌封面流，coverUrl 留空）。

## 横向对比（含 luv-letter 基线）

| 曲目 | 小节/音符 | beatAnchors | 控制点覆盖率 | onset 命中(绝对) | 随机基线 | 倍率 | 残差中位 | 分级 |
|---|---|---|---|---|---|---|---|---|
| luv-letter（基线） | 72 | 601 | — | 0.564 | — | — | — | 基线 |
| birds-poem | 93/438 | 418 | 54% | **1.002** | 0.191 | **5.26×** | +1.6s | 优 |
| river-flows-in-you | 43/386 | 219 | 37% | 0.769 | 0.184 | 4.18× | —（三段速率） | 可用 |
| flower-dance | 106/1216 | 938 | 72% | 0.786 | 0.372 | 2.11× | **+0.10s** | 良 |
| expedition-33 | 66/301 | 311 | 67% | 0.799 | 0.411 | 1.95× | +4.6s(rubato) | 良 |

- 四首**绝对 onset 命中 0.77–1.00 均显著高于 luv-letter 基线 0.564**；倍率受各曲伴奏 onset 密度影响（密织体随机基线 0.37–0.41，稀疏叙事曲 0.18–0.19），跨曲只比绝对值。
- 光标跟随结论：birds-poem 逐音精跟无碍；flower-dance 全曲稳定、换速处一小节过渡；expedition-33 渐慢被如实跟随、适合乐句级视奏；river-flows-in-you 日常跟练可用，B 段（约 77–130s）有恒定 ~3.5s 滞后，介意者可待后续人工校准 anchorOffset 或相位精修。

## 事故与恢复记录（透明呈报）

验证阶段一条「剥 DOCTYPE」的一行式 python 因惰性求值顺序（先以 'w' 截断、再惰性读同一文件）清空了 flower/expedition/birds 三个谱面副本；river 未受影响。恢复：重跑确定性清洗脚本 `clean_score.py`（修复清单逐一复现：flower m38/m71、expedition m48、birds 无修复）+ `make_beats.py` 复跑三首，**beats_final.json 与事故前 app 内 beats.json 逐字节一致**，A 段小节/音符/拍数完全复原——恢复完整性有逐字节证据。river 的幻影修复谱另有独立备份。教训已固化：同文件读改必须先整体读入再写。

【执行报告】4 首新曲（flower-dance / river-flows-in-you / expedition-33 / birds-poem）完成谱面清洗校验、beats.json 生成（硬断言全过、onset 命中 0.77–1.00 均超 luv-letter 基线 0.564）、manifest 与 SONGS 登记、结构测试 16 例；中途三谱被脚本事故清空，经确定性重放逐字节验证恢复。已知遗留：river B 段恒定 ~3.5s 相位滞后（重复织体整拍梳不可分辨，速率正确）；river/birds 无封面。看板卡请 Hermes 验收后流转。

【改动点清单】git 提交 `6f87325`（dev）：`app/src/songs/index.ts`（SONGS 登记 ×4 + manifest import）、`app/src/songs/new-songs.test.ts`（新增 16 例结构测试）。工作区外交付：`app/public/songs/<4 曲>/`（manifest/score/beats/mp3/cover，gitignore 不入库）；产线脚本与留档 `D:/Syrinx/resources/song-pipeline2/` 及各曲 `score/omr-work/`；报告本文件。

【验证结果】npm test：22 文件 / **219 用例全部通过**（基线 203 + 新增 16）；npm run build：tsc + vite 全绿；dev server 冒烟：5 曲 score.musicxml 与 manifest/beats/mp3/cover 端点全部 HTTP 200；make_beats G 段硬断言四首全过（单调性/小节覆盖/首末点）；分支确认留在 dev。

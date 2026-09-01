# sync-tune R2 · T6b 能量块进度条 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 sync-tune 页的连续波形包络与滚轮缩放，替代为「能量块进度条」（视口 ~200 块、每块桶 RMS 均值、底部锚定圆角竖条）＋ 图例行「＋/－/⤢复位」三按钮缩放。

**架构：** waveform.ts 保留 RMS 桶引擎（computeRmsEnvelope），删除仅服务连续包络的 smoothEnvelope/normalizeGain/sampleEnvelopeView，新增均值聚合 sampleBlockMeans；SyncTunePage 预计算缓存改 ~0.5s 块宽桶 RMS（不再平滑/归一），drawWave 画底部锚定圆角竖条（0..38px、rgba(61,90,99,0.55)），期望线/刻度/播放头/选中线原样保留；onWaveWheel 整体移除，图例行加三按钮（×1.5/÷1.5 以视口中心、复位全曲），拖拽平移/点刻度选中/点空白 seek 不动。

**技术栈：** React 19 + TypeScript 6 + Canvas 2D（roundRect 带降级）+ vitest 4。

**红线：** 演奏页/OSMDScore 零改动；只改 `SyncTunePage.tsx` / `SyncTunePage.css` / `src/synctune/waveform.ts`(+test)；vitest 全绿不回归；并发 worker WIP 不碰不提交（提交前核对 git log、逐文件 add）。

**已知偏离（看板 API 不可达）：** 任务书要求先读看板任务 t_b86911c4，但 `GET /api/plugins/kanban/tasks/t_b86911c4` 在 3000 及全部本机监听端口均无服务、磁盘无缓存正文——以任务书内嵌定稿决策（~200 块 / 0.5s 块宽 / 0..38px / rgba(61,90,99,0.55) / ×1.5/÷1.5 视口中心 / 复位全曲）为准。

**已知后果（不在本任务修复范围）：** T6 已提交的 `app/scripts/wave-t6-check.mjs`（CDP 验收脚本，含滚轮缩放断言与包络像素指标）与未提交 WIP `_t6_wave/wave-t6-rounds.mjs`（动态 import 被删函数）在本任务后会失配——两者均不进 vitest/build，红线限定不动它们。

---

## 文件结构

- 修改：`app/src/synctune/waveform.ts` — 删 3 个仅服务连续包络的纯函数，新增 sampleBlockMeans；computeRmsEnvelope 原样保留（新预计算 ~0.5s 块宽复用它）
- 修改：`app/src/synctune/waveform.test.ts` — 同步删 smoothEnvelope/normalizeGain/sampleEnvelopeView 三个 describe（8 用例），新增 sampleBlockMeans describe（4 用例）
- 修改：`app/src/views/SyncTunePage.tsx` — import/常量/refs/预计算链/drawWave/缩放交互/图例按钮/帮助文案/头注释
- 修改：`app/src/views/SyncTunePage.css` — 新增 .st-zoom/.st-zbtn（图例行内缩放小按钮）

---

### 任务 1：waveform.ts 纯函数重构（删 3 增 1，TDD）

**文件：**
- 修改：`app/src/synctune/waveform.ts`
- 测试：`app/src/synctune/waveform.test.ts`

- [ ] **步骤 1：改写单测（先红）**

`waveform.test.ts` 全量替换为（保留 computeRmsEnvelope 4 用例原样，删 8 用例，增 sampleBlockMeans 4 用例）：

```ts
import { describe, expect, it } from 'vitest'
import { computeRmsEnvelope, sampleBlockMeans } from './waveform'

/** [T6b] 能量块进度条纯函数单测：RMS 桶引擎保留（块宽改 ~0.5s 由调用方传入），
 *  新增视口均分块取桶 RMS 均值聚合；仅服务连续包络的平滑/归一/最大值采样
 *  （smoothEnvelope/normalizeGain/sampleEnvelopeView）随包络退役同步删除 */

describe('computeRmsEnvelope 桶能量（RMS）', () => {
  it('恒定电平信号：每桶 RMS = 电平值；总桶数 = ceil(len/step)', () => {
    const s = new Float32Array(1024).fill(0.5)
    const env = computeRmsEnvelope(s, 512)
    expect(env.length).toBe(2)
    expect(env[0]).toBeCloseTo(0.5, 6)
    expect(env[1]).toBeCloseTo(0.5, 6)
  })

  it('正弦波 RMS ≈ 幅度/√2（能量口径而非峰值口径；非整周期桶有纹波）', () => {
    const s = new Float32Array(512 * 40)
    for (let i = 0; i < s.length; i++) s[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 44100)
    for (const v of computeRmsEnvelope(s, 512)) expect(v).toBeCloseTo(0.8 / Math.SQRT2, 1)
  })

  it('单采样尖峰被能量平均压掉：512 桶内一个 1.0 → 1/√512（min/max 口径会是 1.0）', () => {
    const s = new Float32Array(512)
    s[100] = 1
    expect(computeRmsEnvelope(s, 512)[0]).toBeCloseTo(1 / Math.sqrt(512), 6)
  })

  it('尾部不足一桶按实际样本数；零信号桶为 0；非法步长返回空包络', () => {
    const env = computeRmsEnvelope(new Float32Array(600).fill(0.3), 512)
    expect(env.length).toBe(2)
    expect(env[1]).toBeCloseTo(0.3, 6)
    expect(computeRmsEnvelope(new Float32Array(1024), 512)[0]).toBe(0)
    expect(computeRmsEnvelope(new Float32Array(8), 0).length).toBe(0)
  })
})

describe('sampleBlockMeans 视口均分块聚合（桶 RMS 均值）', () => {
  const env = new Float32Array([0.1, 0.4, 0.2, 0.9, 0.3])

  it('每块恰一桶：块值 = 桶 RMS；半开区间不渗邻桶（块尾 1.0 不含桶 1）', () => {
    expect([...sampleBlockMeans(env, 1, 0, 5, 5)]).toEqual([...env])
    // 10 块 × 0.5s：第 0/1 块 [0,0.5)/[0.5,1.0) 都只覆盖桶 0；第 2 块 [1.0,1.5) 起才是桶 1
    const v = sampleBlockMeans(env, 1, 0, 5, 10)
    expect(v[0]).toBeCloseTo(0.1, 6)
    expect(v[1]).toBeCloseTo(0.1, 6)
    expect(v[2]).toBeCloseTo(0.4, 6)
  })

  it('宽视图多桶聚合取均值（能量块进度条口径，而非旧包络的最大值）', () => {
    expect(sampleBlockMeans(env, 1, 0, 5, 1)[0]).toBeCloseTo(1.9 / 5, 6)
    expect(sampleBlockMeans(env, 1, 0, 4, 2)[1]).toBeCloseTo(0.55, 6) // [2,4) 覆盖桶 2、3
  })

  it('深缩放（视口窄于单桶）收敛到覆盖桶，不丢能量', () => {
    expect(sampleBlockMeans(env, 1, 0.55, 0.6, 1)[0]).toBeCloseTo(0.1, 6)
    expect(sampleBlockMeans(env, 1, 3.7, 3.9, 1)[0]).toBeCloseTo(0.9, 6)
  })

  it('空包络/非法参数返回全零块', () => {
    expect([...sampleBlockMeans(new Float32Array(0), 1, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleBlockMeans(env, 0, 0, 5, 3)]).toEqual([0, 0, 0])
    expect([...sampleBlockMeans(env, 1, 5, 5, 3)]).toEqual([0, 0, 0])
    expect(sampleBlockMeans(env, 1, 0, 5, 0).length).toBe(0)
  })
})
```

- [ ] **步骤 2：运行验证失败**

运行（app 目录）：`npx vitest run src/synctune/waveform.test.ts`
预期：FAIL —— `sampleBlockMeans` 未导出（import 解析失败 / is not a function）

- [ ] **步骤 3：实现 waveform.ts**

全量替换为（computeRmsEnvelope 函数体一字不动，仅文件头注释与新函数）：

```ts
/**
 * [T6b] 能量块进度条纯函数：T6 连续包络链（平滑/归一/最大值采样）随包络退役，
 * 只保留 RMS 桶引擎（预计算块宽改 ~0.5s，由调用方按采样率换算传入）并新增
 * 视口均分块均值聚合（进度条口径：能量轮廓而非逐像素包络）：
 *  1) computeRmsEnvelope：单声道样本 → 每桶 RMS 能量（能量口径天然抑毛刺）
 *  2) sampleBlockMeans：[t0,t1] 均分 blocks 块，每块取覆盖桶 RMS 的均值
 */

/** 单声道样本 → 每桶 RMS 能量包络：bucket i 覆盖 [i·step, (i+1)·step) 样本，
 *  尾部不满桶按实际样本数归一；空输入/非法步长返回空包络 */
export function computeRmsEnvelope(samples: Float32Array, step: number): Float32Array {
  if (step <= 0) return new Float32Array(0)
  const n = Math.ceil(samples.length / step)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const end = Math.min(samples.length, (i + 1) * step)
    let sum = 0
    for (let j = i * step; j < end; j++) sum += samples[j] * samples[j]
    env[i] = Math.sqrt(sum / (end - i * step))
  }
  return env
}

/** 能量块聚合：[t0,t1] 均分 blocks 块，每块取覆盖桶 RMS 的均值（进度条口径
 *  ——能量轮廓，区别于 T6 包络的列内最大值）；块为半开区间 [ta,tb)——桶范围
 *  floor(ta/step)..ceil(tb/step)-1，相邻块不互相渗桶，均值只计 [0,n) 内有效
 *  桶；视口窄于单桶时收敛到最近桶（深缩放不丢能量）；空包络/非法参数返回
 *  全零块 */
export function sampleBlockMeans(
  env: Float32Array,
  stepSec: number,
  t0: number,
  t1: number,
  blocks: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(blocks)))
  const n = env.length
  if (n === 0 || stepSec <= 0 || t1 <= t0) return out
  const span = t1 - t0
  for (let x = 0; x < out.length; x++) {
    const ta = t0 + (x / out.length) * span
    const tb = ta + span / out.length
    let b0 = Math.floor(ta / stepSec)
    const b1 = Math.min(Math.ceil(tb / stepSec) - 1, n - 1)
    if (b1 < b0) b0 = Math.max(0, b1)
    let sum = 0
    let cnt = 0
    for (let b = b0; b <= b1; b++) {
      if (b < 0 || b >= n) continue
      sum += env[b]
      cnt++
    }
    out[x] = cnt > 0 ? sum / cnt : 0
  }
  return out
}
```

- [ ] **步骤 4：运行验证通过**

运行：`npx vitest run src/synctune/waveform.test.ts`
预期：PASS，8 用例全绿（computeRmsEnvelope 4 + sampleBlockMeans 4）

- [ ] **步骤 5：不单独 commit（与任务 2/3 同一笔 T6b 提交，避免中间态页面还在引用已删函数导致 tsc 红）**

---

### 任务 2：SyncTunePage 能量块进度条 + 删滚轮缩放 + 三按钮

**文件：**
- 修改：`app/src/views/SyncTunePage.tsx`
- 修改：`app/src/views/SyncTunePage.css`

- [ ] **步骤 1：import 与常量**

删除 L20-24 的 `computeRmsEnvelope/normalizeGain/sampleEnvelopeView/smoothEnvelope` import 块，改为：

```ts
import { computeRmsEnvelope, sampleBlockMeans } from '../synctune/waveform'
```

删除 L59-64 三个常量（PEAK_STEP/RMS_SMOOTH_WIN/WAVE_PEAK_TARGET），替换为：

```ts
/** [T6b] 能量块进度条：预计算块宽 ~0.5s（桶 RMS）+ 视口均分块数 */
const ENERGY_BLOCK_SEC = 0.5
const ENERGY_VIEW_BLOCKS = 200
```

- [ ] **步骤 2：refs 与预计算链**

L129-132 `envRef/envGainRef/stepSecRef` 三个 ref 替换为：

```ts
/** [T6b] 能量块缓存：~0.5s 块宽桶 RMS（粗粒度进度条，不再平滑/归一） */
const blockRmsRef = useRef<Float32Array | null>(null)
const blockSecRef = useRef(0)
```

L226-234 装配段（decode 后）替换为：

```ts
const ch = buf.getChannelData(0)
// [T6b] 能量块缓存：~0.5s 块宽桶 RMS（连续包络与平滑/归一链退役）
const blockSamples = Math.max(1, Math.round(buf.sampleRate * ENERGY_BLOCK_SEC))
blockRmsRef.current = computeRmsEnvelope(ch, blockSamples)
blockSecRef.current = blockSamples / buf.sampleRate
durationRef.current = buf.duration
viewRef.current = { t0: 0, t1: buf.duration }
```

- [ ] **步骤 3：drawWave 包络带 → 能量块竖条**

drawWave 内：`const env = envRef.current` 改 `const env = blockRmsRef.current`；删除 `const mid = h * 0.42` / `const amp = h * 0.36` / stepSec / col / gain 与对称包络 stroke 块（L526-542），替换为：

```ts
// 能量块进度条（T6b）：视口均分 ENERGY_VIEW_BLOCKS 块、每块桶 RMS 均值，
// 底部锚定圆角竖条 0..38px 单色（静音块 ≤0.5px 跳过；roundRect 无实现时降级
// 直角矩形）；期望线/刻度/播放头在其上层照旧
const bars = sampleBlockMeans(
  env,
  blockSecRef.current || ENERGY_BLOCK_SEC,
  t0,
  t0 + span,
  ENERGY_VIEW_BLOCKS,
)
const bw = w / bars.length
ctx.fillStyle = 'rgba(61,90,99,0.55)'
ctx.beginPath()
for (let i = 0; i < bars.length; i++) {
  const bh = Math.min(bars[i], 1) * 38
  if (bh <= 0.5) continue
  const x = i * bw
  const bwid = Math.max(1, bw - 1) // 块间 1px 间隙（窄视口退化到 1px）
  const r = Math.min(2, bwid / 2, bh / 2)
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, h - bh, bwid, bh, r)
  else ctx.rect(x, h - bh, bwid, bh)
}
ctx.fill()
```

drawWave 顶部 doc 注释同步改写（[T6] RMS 包络×增益 → [T6b] 能量块进度条）；组件头注释追加 T6b 段落：

```ts
 * R2（T6b）：波形降级为能量块进度条——连续包络（RMS/平滑/归一/最大值采样）
 * 退役，预计算改 ~0.5s 块宽桶 RMS，drawWave 画底部锚定圆角竖条（0..38px 单
 * 色）；滚轮缩放整体移除（卡顿源），图例行加「＋/－/⤢复位」三按钮（×1.5/
 * ÷1.5 以视口中心、复位全曲）；拖拽平移/点刻度选中/点空白 seek 保留。
```

- [ ] **步骤 4：删 onWaveWheel、加三按钮缩放**

整体删除 `onWaveWheel`（L658-675）及 canvas 上的 `onWheel={onWaveWheel}`；在同区域新增：

```ts
// —— 缩放（T6b）：滚轮缩放移除（卡顿源），图例「＋/－/⤢」按钮承接 ——
const zoomWave = (k: number) => {
  const dur = durationRef.current
  const { t0, t1 } = viewRef.current
  const span = t1 - t0
  const tc = (t0 + t1) / 2 // 以视口中心
  let ns = Math.max(0.5, span * k)
  if (dur > 0) ns = Math.min(ns, dur)
  let nt0 = tc - (tc - t0) * (ns / span)
  nt0 = dur > 0 ? Math.max(0, Math.min(nt0, dur - ns)) : Math.max(0, nt0)
  viewRef.current = { t0: nt0, t1: nt0 + ns }
  waveDirtyRef.current = true // 同拖拽：按需重绘
  waveKickRef.current()
}
const resetWaveView = () => {
  const dur = durationRef.current
  if (dur <= 0) return
  viewRef.current = { t0: 0, t1: dur }
  waveDirtyRef.current = true
  waveKickRef.current()
}
```

图例行 `.st-legend` 末尾追加（按钮必须 `stopPropagation`——头行点击是折叠开关）：

```tsx
<span className="st-zoom">
  <button
    className="st-zbtn"
    onClick={(e) => {
      e.stopPropagation()
      zoomWave(1 / 1.5)
    }}
    title="放大 ×1.5（以视口中心）"
  >
    ＋
  </button>
  <button
    className="st-zbtn"
    onClick={(e) => {
      e.stopPropagation()
      zoomWave(1.5)
    }}
    title="缩小 ÷1.5（以视口中心）"
  >
    －
  </button>
  <button
    className="st-zbtn"
    onClick={(e) => {
      e.stopPropagation()
      resetWaveView()
    }}
    title="复位（显示全曲）"
  >
    ⤢
  </button>
</span>
```

帮助面板鼠标操作行同步改文案：

```tsx
<li>波形拖拽：平移；＋/－/⤢ 按钮：缩放 / 复位全曲</li>
```

- [ ] **步骤 5：CSS 缩放按钮样式**

`SyncTunePage.css` 图例段（`.st-legend .sw.v` 后）追加：

```css
/* 缩放按钮组（T6b）：滚轮缩放移除后由图例行三按钮承接（＋/－/⤢复位） */
.st-zoom {
  display: inline-flex;
  gap: 4px;
}
.st-zbtn {
  background: #18222a;
  color: #cfd8d4;
  border: 1px solid #2a3942;
  border-radius: 5px;
  width: 22px;
  height: 20px;
  padding: 0;
  line-height: 1;
  cursor: pointer;
  font: 12px/1 'Segoe UI', sans-serif;
}
.st-zbtn:hover {
  border-color: var(--song-accent, #5fb8a8);
}
```

- [ ] **步骤 6：红线自查（读改后文件确认）**

- `onWaveWheel` / `sampleEnvelopeView` / `smoothEnvelope` / `normalizeGain` / `envRef` / `envGainRef` / `stepSecRef` / `PEAK_STEP` / `RMS_SMOOTH_WIN` / `WAVE_PEAK_TARGET` 在 app/src 内零残留（仅 `_t6_wave` WIP 与 wave-t6-check.mjs 历史脚本例外，均不动）
- onWavePointerDown/Move/Up（拖拽平移 + 点刻度选中 + 点空白 seek）逐行未动
- 期望线（基线白/工作青/选中 accent）、控制点刻度、播放头、页脚时间范围直写全部保留
- 谱面/列表/右栏/导出链路零触碰

---

### 任务 3：全量验证 + 提交

- [ ] **步骤 1：tsc**（app 目录）`npx tsc -b` —— 预期零错误
- [ ] **步骤 2：vitest 全量** `npx vitest run` —— 预期全绿（基线 200 中 waveform 相关 12 用例变为 8，其余不动；若有其他任务红项按记忆用 `--exclude` 圈定本任务范围复核）
- [ ] **步骤 3：build** `npm run build` —— 预期成功
- [ ] **步骤 4：commit（不 push）**

提交前核对：`git log --oneline -3`（并发 worker）、`git status`（只 add 本任务 4 文件 + 本计划文档，逐文件 add）：

```bash
git add app/src/synctune/waveform.ts app/src/synctune/waveform.test.ts app/src/views/SyncTunePage.tsx app/src/views/SyncTunePage.css docs/superpowers/plans/2026-09-02-sync-tune-r2-t6b-energy-block-progress-bar.md
git commit -m "T6b feat(synctune): 波形降级能量块进度条——删连续包络链(RMS/平滑/归一/最大值采样及其 8 单测)，预计算改 ~0.5s 块宽桶 RMS，drawWave 画底部锚定圆角竖条(0..38px 单色)；滚轮缩放整体移除(卡顿源)，图例行加＋/－/⤢复位三按钮(×1.5/÷1.5 以视口中心、复位全曲)，新增 sampleBlockMeans 均值聚合 4 单测；拖拽/点刻度/点空白 seek 保留"
```

- [ ] **步骤 5：verification-before-completion 技能走查后写报告**（实现摘要 + 验证证据 + 看板不可达偏离 + wave-t6-check.mjs 失配说明）

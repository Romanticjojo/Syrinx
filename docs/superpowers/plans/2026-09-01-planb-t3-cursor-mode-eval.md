# PlanB · T3 双方案对比评估 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 客观量化 anchors（beats.json v6 锚点）与 score（确定性谱面推算）两种光标数据源对伴奏音频的对齐质量，产出评估脚本 + 原始输出 + 对比报告。

**架构：** 新增独立评估脚本 `app/scripts/cursor-mode-eval.mjs`（复用 T2 冒烟的双模式装载逻辑构建两条 Timeline → 断言 981 音符逐项对齐 → 推导每音符播放序 q → 由 beatAnchors 斜率划分 rubato/稳定段 → 内嵌 Python 子进程计算伴奏 onset-flux → Node 侧统计命中率/随机基线/最优平移/Δtime 分布/前 30 对照表）。不修改任何应用代码与测试。

**技术栈：** Node ≥22（原生 TS 类型剥离 + happy-dom）+ Python 3.11（numpy + ffmpeg 命令行解码）。

**关键约束（任务书红线）：**
- 不 push；不改应用源码与现有测试；不打包 Electron；不动 `app/public/songs/` 素材
- flux 参数与产线一致：SR 22050 / hop 512 / FFT 2048 / 半波整流谱差和 / 95 分位归一（参考 `D:/LLM_work/audio-cursor-sync/scripts/note_align_v6.py`，但只用原始 flux，无 HPSS/音高门控）
- 断言 981 对 981 逐项 midi/measure 一致，不一致立即 throw 而非静默跳过
- 随机基线：±0.8s 均匀随机偏移 × 20 次，报均值±标准差（固定种子保证可复现）
- 最优平移：±1.0s 逐 0.01s 扫描，每模式全局最优平移值 + 校正后命中率
- rubato 分段：beatAnchors 局部斜率偏离全局速率 >25% 的 q 区间
- 评估产物：`D:/LLM_work/cursor-planb/eval-output.txt`（脚本 `--out` 直写 UTF-8，避开 PowerShell 管道编码）、`D:/LLM_work/cursor-planb/comparison-report.md`（不进 git）
- git 只提交 `app/scripts/cursor-mode-eval.mjs`（逐文件 add，勿带上未跟踪的 `shot-entry.mjs`）

---

### 任务 1：编写评估脚本 `app/scripts/cursor-mode-eval.mjs`

**文件：**
- 创建：`app/scripts/cursor-mode-eval.mjs`

本任务是数据分析脚本，无独立单测——脚本的正确性由内置断言门（981 逐项对齐、dt startQ 交叉校验）与任务 2 的可重复运行验证承载。

- [ ] **步骤 1：写入脚本全文（下方代码逐字落盘）**

```js
/**
 * PlanB · T3 评估：anchors（beats.json v6 锚点）vs score（确定性谱面推算）
 * 两种 Timeline 数据源的光标-伴奏对齐质量客观对比（任务书 D:/LLM_work/cursor-planb/T3-brief.md）。
 * 用法：node scripts/cursor-mode-eval.mjs [--out <path>]（Node ≥22.6 原生 TS 类型剥离）
 *
 * 方法（任务书定死）：
 * - 双模式装载复刻 loadSong / T2 冒烟链路：同一份展开谱分别走
 *   anchors（parseMusicXml → applyBeats → applyAnchorOffset）与
 *   score（parseDeterministicTimeline → deterministicToTimeline）
 * - 断言 981 对 981 逐项 midi/measure 一致，否则立即报错（红线）
 * - 指标 = 各音符 time 处伴奏 onset-flux 均值（SR 22050 / hop 512 / FFT 2048 /
 *   半波整流谱差和 / 95 分位归一，与产线 note_align_v6 同参；无 HPSS/音高门控）
 * - 随机基线：每音符 ±0.8s 均匀随机偏移 × 20 次（固定种子），报均值±标准差
 * - 校正列：±1.0s 逐 0.01s 扫描每模式最优常数平移（对齐原点差异不算质量差距）
 * - 分段：beatAnchors 局部斜率偏离全局速率 >25% 的 q 区间为 rubato 段
 * - flux 计算在 Python 子进程（numpy + ffmpeg 解码），统计在 Node 侧
 */
import { Window } from 'happy-dom'

const win = new Window()
globalThis.window = win
globalThis.DOMParser = win.DOMParser
globalThis.XMLSerializer = win.XMLSerializer

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../src/score/musicxml.ts'
import { parseDeterministicTimeline } from '../src/score/deterministic-timeline.ts'
import { deterministicToTimeline } from '../src/score/deterministic-adapter.ts'
import { applyAnchorOffset, applyBeats } from '../src/score/anchors.ts'

// ---- 评估参数（任务书定死）----
const EXPECTED_NOTES = 981
const SR = 22050
const HOP = 512
const NFFT = 2048
const RAND_WIN = 0.8
const RAND_N = 20
const RAND_SEED = 7
const SHIFT_MIN = -1.0
const SHIFT_MAX = 1.0
const SHIFT_STEP = 0.01
const RUBATO_DEV = 0.25
const TABLE_N = 30

const outIdx = process.argv.indexOf('--out')
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null
const lines = []
const say = (s = '') => {
  lines.push(s)
  console.log(s)
}

const read = (p) => readFileSync(new URL(`../public/songs/luv-letter/${p}`, import.meta.url), 'utf8')
// happy-dom 不支持单引号属性（浏览器/Electron 原生 DOMParser 无此问题），读取时归一化
const raw = read('score.musicxml').replace(/^<\?xml[^>]*\?>/, (m) => m.replace(/'/g, '"'))
const manifest = JSON.parse(read('manifest.json'))
const beats = JSON.parse(read('beats.json'))
const mp3Path = fileURLToPath(new URL('../public/songs/luv-letter/accompaniment.mp3', import.meta.url))

// ---- 双模式装载（与 T2 冒烟同源：同一份展开谱） ----
const xml = expandRepeats(stripForcedBreaks(raw))
const rawTl = parseMusicXml(xml) // 恒速谱面 timeline（applyBeats 前态，noteQ 推导用）
let anchorsTl = rawTl
anchorsTl = applyBeats(anchorsTl, beats)
if (manifest.anchorOffsetMs) anchorsTl = applyAnchorOffset(anchorsTl, manifest.anchorOffsetMs / 1000)
const dt = parseDeterministicTimeline(xml)
const scoreTl = deterministicToTimeline(dt)

// ---- 红线断言：981 对 981 逐项 midi/measure 一致 ----
const A = anchorsTl.notes
const S = scoreTl.notes
if (A.length !== EXPECTED_NOTES || S.length !== EXPECTED_NOTES) {
  throw new Error(`音符数不符预期：anchors=${A.length} score=${S.length}（预期 ${EXPECTED_NOTES}）`)
}
const mism = []
for (let i = 0; i < A.length; i++) {
  if (A[i].midi !== S[i].midi || A[i].measure !== S[i].measure) mism.push(i)
}
if (mism.length) {
  const head = mism
    .slice(0, 5)
    .map((i) => `  #${i}: anchors(midi=${A[i].midi},m${A[i].measure}) vs score(midi=${S[i].midi},m${S[i].measure})`)
  throw new Error(`音符未逐项对齐（${mism.length} 处）：\n${head.join('\n')}`)
}

// ---- 播放序四分音符位置 q：复刻 applyBeats 的 noteQ 映射（恒速 timeline 基准），
// 与 dt.notes 过滤后的 startQ 交叉校验（两路独立推导，偏差大说明口径有错） ----
const mt0 = rawTl.measureTimes
const localRate = (i) => (mt0[i + 1].quarters - mt0[i].quarters) / Math.max(mt0[i + 1].time - mt0[i].time, 1e-9)
const idxByM = new Map()
mt0.forEach((e, i) => {
  if (!e.end && !idxByM.has(e.measure)) idxByM.set(e.measure, i)
})
const qs = rawTl.notes.map((n) => {
  const k = idxByM.get(n.measure)
  if (k === undefined || k + 1 >= mt0.length) return NaN
  return mt0[k].quarters + (n.time - mt0[k].time) * localRate(k)
})
const dtNotes = dt.notes.filter((n) => !n.isGrace && n.pitch !== null)
if (dtNotes.length !== EXPECTED_NOTES) {
  throw new Error(`dt 过滤后音符数 ${dtNotes.length} ≠ ${EXPECTED_NOTES}`)
}
let maxDq = 0
for (let i = 0; i < qs.length; i++) maxDq = Math.max(maxDq, Math.abs(dtNotes[i].startQ - qs[i]))

// ---- rubato 分段：beatAnchors 局部斜率偏离全局速率 >25% 的 q 区间 ----
const ba = beats.beatAnchors
const gRate = (ba[ba.length - 1].t - ba[0].t) / (ba[ba.length - 1].q - ba[0].q)
const flagged = []
for (let i = 0; i + 1 < ba.length; i++) {
  const slope = (ba[i + 1].t - ba[i].t) / Math.max(ba[i + 1].q - ba[i].q, 1e-9)
  if (Math.abs(slope - gRate) / gRate > RUBATO_DEV) flagged.push([ba[i].q, ba[i + 1].q])
}
const rubIvs = []
for (const [a, b] of flagged) {
  const last = rubIvs[rubIvs.length - 1]
  if (last && Math.abs(a - last[1]) < 1e-9) last[1] = b
  else rubIvs.push([a, b])
}
const isRubato = (q) => rubIvs.some(([a, b]) => q >= a - 1e-9 && q <= b + 1e-9)
const seg = qs.map((q) => (isRubato(q) ? 'rubato' : 'stable'))
const rubIdx = seg.map((s, i) => (s === 'rubato' ? i : -1)).filter((i) => i >= 0)
const stbIdx = seg.map((s, i) => (s === 'stable' ? i : -1)).filter((i) => i >= 0)
if (rubIdx.some((i) => !Number.isFinite(qs[i]))) {
  throw new Error(`存在无法定位 q 的音符（measure 无 measureTimes 条目），rubato 分段不可靠`)
}

// ---- flux：Python 子进程（ffmpeg 解码 mp3 → STFT 通量） ----
const PY_SRC = `\
import sys, json, subprocess
import numpy as np
p = json.load(open(sys.argv[1]))
raw = subprocess.run(['ffmpeg','-v','error','-i',p['mp3'],'-ac','1','-ar',str(p['sr']),'-f','f32le','-'], capture_output=True).stdout
audio = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
hop, nfft = p['hop'], p['nfft']
win = np.hanning(nfft)
nfr = (len(audio) - nfft) // hop
mag = np.empty((nfr, nfft // 2 + 1))
for i in range(nfr):
    mag[i] = np.abs(np.fft.rfft(audio[i*hop:i*hop+nfft] * win))
flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
flux = np.concatenate(([0.0], flux))
flux = flux / max(float(np.percentile(flux, 95)), 1e-9)
json.dump(flux, open(sys.argv[2], 'w'))
print('flux frames:', len(flux))
`
const tmp = mkdtempSync(join(tmpdir(), 'cursor-mode-eval-'))
const payloadPath = join(tmp, 'payload.json')
const pyPath = join(tmp, 'flux.py')
const fluxPath = join(tmp, 'flux.json')
writeFileSync(payloadPath, JSON.stringify({ mp3: mp3Path, sr: SR, hop: HOP, nfft: NFFT }))
writeFileSync(pyPath, PY_SRC)
const py = spawnSync('python', [pyPath, payloadPath, fluxPath], { encoding: 'utf8' })
if (py.status !== 0) {
  throw new Error(`flux 计算失败（python exit ${py.status}）：\n${py.stderr}`)
}
say(`[flux] ${py.stdout.trim().replace(/\s+/g, ' ')}`)
const flux = JSON.parse(readFileSync(fluxPath, 'utf8'))
rmSync(tmp, { recursive: true, force: true })

// ---- 统计（Node 侧，与产线 at() 同口径的线性插值采样） ----
const HT = HOP / SR
const at = (arr, t) => {
  const f = t / HT
  const i0 = Math.floor(f)
  if (i0 < 0 || i0 + 1 >= arr.length) return 0.0
  return arr[i0] * (1 - (f - i0)) + arr[i0 + 1] * (f - i0)
}
const meanHit = (times, shift = 0) => times.reduce((s, t) => s + at(flux, t + shift), 0) / times.length

// ±1.0s 逐 0.01s 扫最优常数平移
const bestShift = (times) => {
  let bs = 0
  let bv = -Infinity
  for (let k = 0; k <= Math.round((SHIFT_MAX - SHIFT_MIN) / SHIFT_STEP); k++) {
    const s = SHIFT_MIN + k * SHIFT_STEP
    const v = meanHit(times, s)
    if (v > bv) {
      bv = v
      bs = s
    }
  }
  return { shift: Math.round(bs * 100) / 100, rate: bv }
}

// mulberry32 固定种子（可复现）；ddof=0 标准差与 np.std 同口径
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const baseline = (times) => {
  const rng = mulberry32(RAND_SEED)
  const samples = []
  for (let k = 0; k < RAND_N; k++) {
    const offs = times.map(() => (rng() * 2 - 1) * RAND_WIN)
    samples.push(times.reduce((s, t, i) => s + at(flux, t + offs[i]), 0) / times.length)
  }
  const m = samples.reduce((a, b) => a + b, 0) / samples.length
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - m) ** 2, 0) / samples.length)
  return { mean: m, sd }
}

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  const pos = ((s.length - 1) * p) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// ---- 输出 ----
say('=== PlanB T3：cursor 对齐质量评估（Luv Letter）===')
say(`模式音符数：anchors=${A.length} score=${S.length}（逐项 midi/measure 断言通过）`)
say(`q 双路推导交叉校验：rawTl 映射 vs dt.startQ 最大偏差 = ${maxDq.toFixed(4)} q`)
say(`rubato 分段（斜率偏离全局速率 ${(gRate.toFixed(4))} s/q >${RUBATO_DEV * 100}%）：区间 ${rubIvs.length} 个，rubato 音符 ${rubIdx.length} / 稳定段 ${stbIdx.length}`)
say(`rubato q 区间：${rubIvs.map(([a, b]) => `[${a},${b}]`).join(' ')}`)

const dts = S.map((n, i) => n.time - A[i].time)
const adts = dts.map(Math.abs)
say('')
say('=== Δtime 分布（score.time − anchors.time，秒）===')
say(`中位(带号) = ${percentile(dts, 50).toFixed(3)} | 均值 = ${(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(3)}`)
say(`|Δ| P90 = ${percentile(adts, 90).toFixed(3)} | |Δ| 最大 = ${Math.max(...adts).toFixed(3)}`)

const cols = [
  ['全曲', A.map((_, i) => i)],
  ['稳定段', stbIdx],
  ['rubato段', rubIdx],
]
const pick = (times, idx) => idx.map((i) => times[i])
const row = {}
for (const [name, mode] of [['anchors', A.map((n) => n.time)], ['score', S.map((n) => n.time)]]) {
  const g = bestShift(mode)
  row[name] = { g, cols: {} }
  for (const [cname, idx] of cols) {
    const sub = pick(mode, idx)
    row[name].cols[cname] = {
      raw: meanHit(sub),
      shifted: meanHit(sub, g.shift),
      local: bestShift(sub),
      base: baseline(sub),
    }
  }
  row[name].globalShift = g.shift
}

const f4 = (v) => v.toFixed(4)
say('')
say('=== 命中率总表（onset-flux 均值，95 分位归一）===')
say(`随机基线（每音符 ±${RAND_WIN}s 均匀偏移 × ${RAND_N} 次，固定种子 ${RAND_SEED}）：见各列 base`)
for (const name of ['anchors', 'score']) {
  const r = row[name]
  say(`--- ${name}（最优全局平移 ${r.globalShift >= 0 ? '+' : ''}${r.globalShift.toFixed(2)}s）---`)
  say('  列      |   原始   | 最优平移后 | 段内独立最优平移 |    随机基线(mean±sd)   | 提升(平移后/基线)')
  for (const [cname] of cols) {
    const c = r.cols[cname]
    say(
      `  ${cname.padEnd(6)} | ${f4(c.raw)} |   ${f4(c.shifted)}   |  ${f4(c.local.rate)} @${c.local.shift >= 0 ? '+' : ''}${c.local.shift.toFixed(2)}s | ${f4(c.base.mean)}±${f4(c.base.sd)} |   ${(c.shifted / c.base.mean).toFixed(2)}x`,
    )
  }
}

say('')
say('=== 前 30 音符两模式 time 对照 ===')
say('  #  | midi | measure |     q |  段     | anchors.time |  score.time |   Δtime')
for (let i = 0; i < Math.min(TABLE_N, A.length); i++) {
  const num = (v) => v.toFixed(3).padStart(8)
  say(
    `  ${String(i).padStart(2)} | ${String(A[i].midi).padStart(4)} | ${String(A[i].measure).padStart(7)} | ${qs[i].toFixed(2).padStart(5)} | ${seg[i].padEnd(6)} | ${num(A[i].time)} | ${num(S[i].time)} | ${num(dts[i])}`,
  )
}

say('')
say(`[meta] anchors[0].t=${beats.anchors[0].t}（音频起始偏移）；score 模式 q=0 → t=0，系统性常数差属对齐原点差异，以「最优平移后」列为准`)

if (outPath) {
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
  console.log(`[已写] ${outPath}`)
}
```

- [ ] **步骤 2：语法自检**

运行：`node --check app/scripts/cursor-mode-eval.mjs`（ESM 下 `--check` 可用性视 node 版本，若不可用改跑 `node app/scripts/cursor-mode-eval.mjs --out NUL` 的干跑由任务 2 承担）
预期：无语法错误。

### 任务 2：运行评估并落盘 `eval-output.txt`

**文件：**
- 创建：`D:/LLM_work/cursor-planb/eval-output.txt`（评估原始输出，不进 git）

- [ ] **步骤 1：运行评估脚本**

运行：`node app/scripts/cursor-mode-eval.mjs --out D:/LLM_work/cursor-planb/eval-output.txt`
预期：断言门全过（981/981、q 交叉校验偏差 <0.02、rubato 分段非空），打印命中率先总表与前 30 对照表。若断言失败，按报错逐项排查（可能点：measure 编号口径、dt 过滤谓词、beatAnchors 数据漂移），修脚本后重跑。

- [ ] **步骤 2：可重复性验证**

再跑一次到临时文件，与 `eval-output.txt` 逐字节比对（`fc.exe` / hash）。
预期：完全一致（固定种子 + 确定性 flux 管线）。

### 任务 3：撰写对比报告 `D:/LLM_work/cursor-planb/comparison-report.md`

**文件：**
- 创建：`D:/LLM_work/cursor-planb/comparison-report.md`（不进 git）

- [ ] **步骤 1：以 eval-output.txt 实测数字填报告**

必含章节（数据驱动，不许预设立场）：
1. 总命中率表：两模式 × {原始, 最优平移后} × {全曲, 稳定段, rubato 段} + 随机基线（mean±sd）+ 提升比
2. Δtime 分布（中位数/P90/最大），并解释系统性常数偏移（anchors[0].t=0.2 对齐原点差异）
3. 分场景结论：稳定段谁赢、rubato 段谁赢、差距多大（相对随机基线的倍数与绝对差）；双模式是否值得保留；若数据支撑「稳定段用 score、rubato 段用 anchors」类混合策略则给建议，否则明说不支撑
4. 附前 30 音符对照表（从 eval-output.txt 抄录）

- [ ] **步骤 2：自洽抽查**

对报告里每个数字回对 eval-output.txt；抽查 2-3 个分段数字手算复核（如稳定段原始命中率 = 稳定段音符 flux 采样均值）。

### 任务 4：提交与回归验证

**文件：**
- git 新增：`app/scripts/cursor-mode-eval.mjs`

- [ ] **步骤 1：跑应用测试确认未破坏**

运行：`npx vitest run`（工作目录 `app/`）
预期：152 全绿（应用代码未动过；若环境拒绝执行则交由 Hermes 验收时跑，报告中如实注明）。

- [ ] **步骤 2：逐文件 add 并 commit（勿带上未跟踪的 `shot-entry.mjs`）**

```bash
git add app/scripts/cursor-mode-eval.mjs
git commit -m "chore(eval): PlanB T3 光标双模式对齐质量评估脚本"
```

- [ ] **步骤 3：commit 后核对**

运行：`git log --oneline -1` 与 `git status --short`
预期：新 commit 只含 `app/scripts/cursor-mode-eval.mjs`；`shot-entry.mjs` 仍为未跟踪。

---

## 自检记录

- 规格覆盖度：评估脚本（任务1）、eval-output.txt（任务2）、报告四要素（任务3）、git commit + vitest 152（任务4）、红线（不push/不改源码/不打包/不动素材——全计划无此类操作）、评分口径断言（任务1红线段）、0.2s 对齐原点处理（最优平移列 + meta 行）——均有对应任务。
- 占位符扫描：无 TODO/待定；脚本全文逐字给出。
- 类型一致性：`applyBeats(rawTl, beats)` / `dtNotes[i].startQ` / `n.measure` / `n.midi` 均与 `anchors.ts`、`deterministic-adapter.ts` 现有签名一致（已实读核对）。

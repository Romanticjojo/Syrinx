# Syrinx（FluteFlow）演奏辅助应用 MVP 实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:executing-plans 在当前会话逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。每个里程碑完成后用 superpowers:verification-before-completion 验证后才宣告完成。

**目标：** 完成 Netflix 式长笛演奏辅助 Web 应用 MVP：曲库预览 → OSMD 曲谱跟随演奏（Web Audio 主时钟同步）→ three.js 主题动态背景 → 录音回放 + 音高检测反馈。

**架构：** Vite + TS + React + zustand 四视图 SPA（曲库/预览/演奏/回放）。Song Pack（manifest + MusicXML）驱动；无外部伴奏音频时由曲谱音符事件程序化合成（OfflineAudioContext），谱/音同源天然对齐。AudioContext.currentTime 为唯一主时钟，时间轴换算为纯函数（vitest 单测）；每帧 rAF 只写 DOM/SVG，不进响应式 store。

**技术栈：** Vite 8 + TypeScript 6 + React 19 + zustand 5 + OSMD 2.1 + three 0.185 + Vitest 4（均已安装，**不新增运行时依赖**；仅新增 devDependency happy-dom 供单测 DOMParser）。

---

## 已定决策（执行时不再讨论）

1. **不新增运行时 npm 依赖**：曲谱 OSMD、背景 three、状态 zustand、音频/录音/音高检测全部用浏览器原生 API + 自研纯 TS。
2. **伴奏**：`public/songs/*/accompaniment.*` 不存在时，运行时用 OfflineAudioContext 从音符事件合成夜曲风格伴奏（主旋律柔音 + 低音 pad + 简单和声）。若 manifest 提供音频 URL 则 fetch 解码优先。
3. **音高检测**：自研纯 TS YIN（长笛单音乐器足够，离线可跑）；检测器封装为接口，CREPE/tfjs 留作后续替换位（用户点名 CREPE，按选型文档 MPM/YIN 先行原则落地，最终汇报说明取舍）。
4. **路由**：zustand 视图状态机（`home | preview | perform | result`），4 页面不值得引入 react-router。
5. **时间轴不进 store**：演奏中每帧数据（当前时间/小节/进度）由 rAF 回调直接操作 DOM；store 只放低频状态（视图、曲目、演奏会话结果）。
6. **OSMD 光标**：每帧 `while (!iterator.EndReached && iterator.currentTimeStamp.RealValue * secPerQuarter <= t) cursor.next()`；`osmd.FollowCursor = true` 自动滚动。
7. **素材**：`resources/flute.glb`（3.3MB）用于 3D 长笛入场动画与预览页；外部精美素材（视频背景/拼装动画）通过 manifest 字段预留，缺失时用 three.js 占位场景。
8. **git**：D:\flute_app 执行 `git init`，中文 commit，按任务频繁提交。

## 文件结构（app/src/）

```
src/
├── main.tsx                  # 入口（挂载 React）
├── App.tsx                   # 视图路由（读 store.view 渲染四个视图）
├── index.css                 # 设计 token（CSS 变量暗色主题）+ 全局基础样式
├── store.ts                  # zustand：view / currentSongId / 会话结果 / 收藏
├── types.ts                  # SongManifest / NoteEvent / Timeline / Take（录音）
├── songs/index.ts            # 内置曲库元数据（lumiere + 2 首占位）+ manifest 加载
├── score/musicxml.ts         # MusicXML → Timeline 纯函数（DOMParser）
├── score/musicxml.test.ts    # 时间轴单测
├── score/OSMDScore.ts        # OSMD 封装：load/render/光标时间驱动/缩放
├── audio/synth.ts            # 伴奏程序化合成（OfflineAudioContext）
├── audio/AudioEngine.ts      # 主时钟：play/pause/seek/rate/analyser/结束回调
├── audio/recorder.ts         # getUserMedia + MediaRecorder 封装
├── pitch/yin.ts              # YIN 算法（纯函数）
├── pitch/yin.test.ts         # 合成正弦波 → 频率检测单测
├── pitch/compare.ts          # 实测轨迹提取 + 目标对比 + 音准统计
├── pitch/compare.test.ts     # 对比统计单测
├── background/LumiereScene.ts# three.js 晨光主题 audio-reactive 背景
├── background/FluteModel.ts  # glb 长笛加载 + 缓慢旋转展示（预览/入场用）
├── views/HomePage.tsx        # Netflix 式曲库卡片墙
├── views/PreviewPage.tsx     # hero 预览 + 3D 长笛 + 开始演奏
├── views/PerformPage.tsx     # 演奏界面（谱面+控制条+倒数+沉浸）
├── views/ResultPage.tsx      # 回放 + 音高对比图 + 统计
├── components/ScoreSheet.tsx # 谱面容器组件（挂 OSMDScore 实例）
├── components/ControlBar.tsx # 底部播放控制条
├── components/PitchChart.tsx # 音高对比曲线（canvas）
└── components/Intro.tsx      # 入场动画覆盖层（3D 长笛 + 跳过）
```

---

## 任务 0：设计方向对比与定稿（设计阶段）

**文件：**
- 创建：`D:\LLM_work\flute_app\03-设计稿\direction-a~c\`（每方向 preview.html + perform.html）
- 创建：`D:\LLM_work\flute_app\03-设计稿\设计对比与定稿.md`

- [ ] 步骤 1：依次加载 claude-design、popular-web-designs、sketch 技能吸收方法论
- [ ] 步骤 2：产出方向 A「夜航晨光」（现有 v1/v2 精修：暖金 #d9a441 + 晨光青 #5fb8a8、衬线大标题、Netflix hero）
- [ ] 步骤 3：产出方向 B「Spotify 声波沉浸」（封面主导、大胆排版、青绿强调、圆角卡片）
- [ ] 步骤 4：产出方向 C「光影剧场」（电影化：上下遮幅、光束、玻璃拟态谱面）
- [ ] 步骤 5：写对比定稿文档（布局/配色/动效/沉浸感逐维对比 + 取舍理由 + 定稿方向的设计 token 表）
- [ ] 步骤 6：定稿方向作为 M1 实现依据（React 化时提取 token）

## 任务 1：工程清理 + git + 视图路由骨架

**文件：**
- 修改：`app/src/main.tsx`、`app/src/App.tsx`、`app/src/index.css`（全重写）
- 删除：`app/src/App.css`、`app/src/assets/`（默认模板残留）
- 创建：`app/src/store.ts`、`app/src/types.ts`、`app/vitest.config.ts`（如需）

- [ ] 步骤 1：`git init` + 首次提交现有骨架
- [ ] 步骤 2：写 store.ts（视图状态机）与 types.ts（核心类型）

```ts
// store.ts 关键内容
export type View = 'home' | 'preview' | 'perform' | 'result'
interface AppState {
  view: View
  currentSongId: string | null
  favorites: string[]
  lastTake: Take | null        // 演奏会话结果（录音 blob + 音高轨迹）
  go(view: View, songId?: string): void
  toggleFavorite(id: string): void
}
```

```ts
// types.ts 核心类型
export interface NoteEvent { time: number; duration: number; midi: number; measure: number } // 秒
export interface Timeline {
  durationSec: number; secPerQuarter: number; tempo: number
  notes: NoteEvent[]; measureTimes: { measure: number; time: number }[]
}
export interface Take {
  songId: string; startedAt: number; durationSec: number
  audioUrl: string; mimeType: string          // 录音回放
  pitchTrack: { time: number; hz: number; cents: number }[] | null  // 实测音高
  stats: { inTuneRatio: number; avgCents: number; noteCount: number } | null
}
export interface SongManifest {
  id: string; title: string; composer: string; difficulty: 1|2|3
  durationLabel: string; keyLabel: string; description: string; tags: string[]
  scoreUrl: string; accompanimentUrl?: string; cover?: string
  backgroundTheme: 'lumiere' | 'aurora' | 'ember'; bpm: number
}
```

- [ ] 步骤 3：App.tsx 按 store.view 切换四个占位视图；index.css 写入定稿设计 token（CSS 变量）
- [ ] 步骤 4：`npm run dev` 验证四视图可切换、无报错；`npm run build` 通过
- [ ] 步骤 5：Commit「feat: 工程骨架与视图路由」

## 任务 2：Song Pack 数据与曲库

**文件：**
- 创建：`app/src/songs/index.ts`、`app/public/songs/lumiere/manifest.json`
- 修改：`app/src/views/HomePage.tsx`（实现卡片墙）

- [ ] 步骤 1：写 lumiere manifest.json（按 types.ts SongManifest；scoreUrl: '/songs/lumiere/score.musicxml'）+ 2 首占位曲目（score 复用 lumiere 曲谱或后续生成）
- [ ] 步骤 2：songs/index.ts 内置曲库数组 + `loadSong(manifest)`（fetch score → text）
- [ ] 步骤 3：HomePage 实现横向卡片墙（hover 放大、难度/时长角标、点击进入 preview）；顶栏与 hero 区按定稿设计
- [ ] 步骤 4：`npm run dev` 手动验证：卡片渲染、点击跳转 preview、返回
- [ ] 步骤 5：Commit「feat: 曲库首页与 Song Pack 数据」

## 任务 3：MusicXML → 时间轴（TDD）

**文件：**
- 创建：`app/src/score/musicxml.ts`、`app/src/score/musicxml.test.ts`
- 修改：`app/package.json`（test script）、`app/vitest.config.ts`

- [ ] 步骤 1：`npm i -D happy-dom`（vitest 单测需要 DOMParser；失败则降级自写微型 XML 解析器并记录于计划）
- [ ] 步骤 2：写失败测试

```ts
// musicxml.test.ts 要点
const XML = `<?xml version="1.0"?><score-partwise version="3.1"><part-list>...</part-list>
<part id="P1"><measure number="1">
<attributes><divisions>2</divisions><time><beats>3</beats></time></attributes>
<direction><sound tempo="60"/></direction>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
</measure><measure number="2">...</measure></part></score-partwise>`
// 断言：notes[0].time===0、duration===1s（divisions=2, tempo=60 → quarter=1s）
// 断言：notes[1].time===1、duration===2；measureTimes[1].time===3；midi C4=60
// 断言：休止符不进 notes 但占时值；多 measure 累积正确；timeline.durationSec = 末音结束
```

- [ ] 步骤 3：`npx vitest run` 确认 FAIL（函数未定义）
- [ ] 步骤 4：实现 `parseMusicXml(xml: string): Timeline`：DOMParser → 遍历 part/measure → divisions/tempo（含中途 direction 变速支持）→ duration/divisions 四分音符数 → 秒；pitch step/alter/octave → midi；measure 起始时间表；末尾补 durationSec
- [ ] 步骤 5：`npx vitest run` PASS；用真实 `public/songs/lumiere/score.musicxml`（3/4、84bpm、16 小节）加一条快照断言（durationSec ≈ 16×3×60/84 ≈ 34.29s）
- [ ] 步骤 6：package.json 加 `"test": "vitest run"`；Commit「feat: MusicXML 时间轴解析（TDD）」

## 任务 4：伴奏程序化合成

**文件：**
- 创建：`app/src/audio/synth.ts`

- [ ] 步骤 1：实现 `synthAccompaniment(timeline: Timeline, sampleRate = 44100): Promise<AudioBuffer>`

```ts
// 合成配方（夜曲风格，纯 Web Audio 节点图，OfflineAudioContext 渲染）：
// 主旋律：每 NoteEvent 一个振荡器（triangle）+ ADSR（attack .04s, release .3s）
//          + 轻微 detune 合唱感（两个 osc 相差 4 cents）
// 低音 pad：每小节根音（该小节首个音符 midi -12/-24）sine + lowpass 400Hz，全小节长
// 氛围：整曲持续的白噪声（buffer 填充）经 bandpass 800Hz、gain 0.015，营造气声
// 混响感：对旋律总线加 feedback delay（.28s, feedback .25, wet .18）
// 输出 master gain 0.8，总长 durationSec + 1.5s 尾音
```

- [ ] 步骤 2：临时在 PreviewPage 调用并 `console.log(buffer.duration)` + 浏览器手动试听（开发验证代码可临时注入后移除）
- [ ] 步骤 3：Commit「feat: 程序化伴奏合成」

## 任务 5：AudioEngine 主时钟

**文件：**
- 创建：`app/src/audio/AudioEngine.ts`

- [ ] 步骤 1：实现单例类

```ts
class AudioEngine {
  private ctx: AudioContext; private src: AudioBufferSourceNode | null = null
  private gain: GainNode; analyser: AnalyserNode   // 背景 audio-reactive 用
  private buffer: AudioBuffer | null = null
  private startCtxTime = 0; private startOffset = 0
  rate = 1; playing = false
  onEnd?: () => void
  async load(buffer: AudioBuffer): void
  play(offsetSec?: number): void   // 记录 startCtxTime = ctx.currentTime，src.playbackRate = rate
  pause(): void                    // startOffset += (ctx.currentTime - startCtxTime) * rate
  seek(t: number): void
  setRate(r: number): void         // 重启 src 保住当前位置
  get time(): number               // playing ? startOffset + (ctx.currentTime - startCtxTime) * rate : startOffset
  getVolume()/setVolume(v)         // gain.gain.value
  private scheduleEnd(): void      // src.onended 或 rAF 检查 time>=duration → onEnd（用 rAF 更稳）
}
export const audioEngine = new AudioEngine()
```

- [ ] 步骤 2：手动验证：load 合成伴奏 → play/pause/seek/rate 正确、time 单调推进、变速后 time 换算正确（在演奏页做完后一并验证）
- [ ] 步骤 3：Commit「feat: Web Audio 主时钟引擎」

## 任务 6：OSMD 曲谱渲染 + 时间驱动光标

**文件：**
- 创建：`app/src/score/OSMDScore.ts`、`app/src/components/ScoreSheet.tsx`

- [ ] 步骤 1：OSMDScore 封装

```ts
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
export class OSMDScore {
  private osmd: OpenSheetMusicDisplay
  constructor(container: HTMLElement) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true, backend: 'svg', followCursor: true,
      drawTitle: false, drawSubtitle: false, drawComposer: false,
      disableCursor: false,
    })
  }
  async load(xml: string) { await this.osmd.load(xml); this.osmd.render() }
  showCursorAtStart() { this.osmd.cursor.reset(); this.osmd.cursor.show() }
  /** 每帧调用：t 为曲目时间轴秒 */
  syncToTime(t: number, secPerQuarter: number) {
    const it = this.osmd.cursor.iterator
    while (!it.EndReached && it.currentTimeStamp.RealValue * secPerQuarter <= t)
      this.osmd.cursor.next()
  }
  get currentMeasure(): number  // iterator.currentMeasure.index + 1
  get totalMeasures(): number   // osmd.Sheet.LastMeasureIndex + 1
  setZoom(scale: number)        // osmd.Zoom（重渲染）
  resizeToParent()              // osmd.render() 容器宽变化时
}
```

- [ ] 步骤 2：ScoreSheet 组件：div 容器 + useEffect 创建/销毁 OSMDScore；暴露 ref 给 PerformPage
- [ ] 步骤 3：手动验证：lumiere 曲谱渲染成功、无控制台报错（此任务先静态渲染，光标在下任务随演奏页联调）
- [ ] 步骤 4：Commit「feat: OSMD 曲谱渲染封装」

## 任务 7：演奏页（同步核心联调 + 沉浸控件）

**文件：**
- 创建：`app/src/views/PerformPage.tsx`、`app/src/components/ControlBar.tsx`
- 修改：`app/src/views/PreviewPage.tsx`（开始演奏 → go('perform')）

- [ ] 步骤 1：PerformPage 组装：进入即 `parseMusicXml` → `synthAccompaniment` → `audioEngine.load` → OSMD load；「就绪」浮层 + 4 拍倒数（每拍 60/bpm 秒，节拍音由 audioEngine ctx 调度短促 sine tick）→ play
- [ ] 步骤 2：rAF 主循环（不进 store）：`const t = audioEngine.time` → `score.syncToTime(t)` → 直接写 DOM：当前小节 `mEl.textContent`、进度条 `playedEl.style.width`、时间 `tEl.textContent`；t ≥ duration → 结束 → go('result')
- [ ] 步骤 3：ControlBar：播放/暂停、回开头（seek 0 + 光标 reset——seek 任意点时重建 cursor：reset 后快进 syncToTime）、缩放 +/-、伴奏音量、退出
- [ ] 步骤 4：沉浸控件：mousemove/keydown 唤醒，3.2s 无操作且播放中 → body.idle（控件 opacity 0）；`prefers-reduced-motion` 尊重
- [ ] 步骤 5：手动验证清单：① 谱音同步（光标与伴奏误差听感 <50ms）② 自动滚动跟随光标 ③ 暂停/继续/回开头正常 ④ 缩放生效 ⑤ 控件自动隐藏
- [ ] 步骤 6：Commit「feat: 演奏页同步核心闭环」

## 任务 8：three.js Lumière 主题背景

**文件：**
- 创建：`app/src/background/LumiereScene.ts`
- 修改：`app/src/views/PerformPage.tsx`（挂背景 canvas）

- [ ] 步骤 1：实现 LumiereScene：全屏 WebGLRenderer + 场景组——
  - 深蓝夜空渐变背景（大球体内表面 shader 或 fog + 渐变平面）
  - 金色光尘粒子（BufferGeometry Points ~1500，缓慢上升 + sin 漂移，附加 alpha 呼吸）
  - 地平线光晕（PlaneGeometry + 径向渐变 CanvasTexture，additive blending）
  - audio-reactive：`analyser.getByteFrequencyData` → 低频能量驱动光晕强度与粒子亮度（不改变位置，保谱面区域稳定可读）
  - 谱面区域保护：场景整体置于谱面层之下 + CSS 暗化遮罩（谱面容器 backdrop 面板已有近黑背景，双保险）
  - `prefers-reduced-motion`：粒子静止、仅静态渐变
  - dispose()：geometry/material/renderer 全释放
- [ ] 步骤 2：手动验证：背景渲染、随伴奏音量呼吸、谱面可读性不受影响、无内存泄漏（多次进出演奏页 renderer 数量不增长——`performance` 面板或 `renderer.info`）
- [ ] 步骤 3：Commit「feat: three.js 晨光主题动态背景」

## 任务 9：MediaRecorder 录音

**文件：**
- 创建：`app/src/audio/recorder.ts`
- 修改：`app/src/views/PerformPage.tsx`（演奏开始即录音，结束生成 Take）

- [ ] 步骤 1：实现 recorder

```ts
export async function startRecording(ctx: AudioContext): Promise<{stop: () => Promise<{blob: Blob, url: string, mime: string}>}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks: Blob[] = []
  rec.ondataavailable = e => e.data.size && chunks.push(e.data)
  rec.start(250)
  return { stop: () => new Promise(res => {
    rec.onstop = () => { stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks, { type: mime })
      res({ blob, url: URL.createObjectURL(blob), mime }) }
    rec.stop() }) }
}
```

- [ ] 步骤 2：PerformPage 接入：倒数结束 → startRecording（失败则 toast 提示继续演奏不录音）；结束 → stop → 存 Take（store.lastTake）
- [ ] 步骤 3：手动验证：麦克风权限申请、演奏结束 result 页拿到录音 URL、可播放
- [ ] 步骤 4：Commit「feat: 演奏录音」

## 任务 10：YIN 音高检测（TDD）

**文件：**
- 创建：`app/src/pitch/yin.ts`、`app/src/pitch/yin.test.ts`

- [ ] 步骤 1：写失败测试：441Hz/220Hz 正弦波 Float32Array（44100Hz, 2048 样本）→ `yinDetect(buf, 44100)` 返回 ±2Hz 内；白噪声 → null 或极低清晰度；静音 → null
- [ ] 步骤 2：`npx vitest run` FAIL
- [ ] 步骤 3：实现 YIN：差分函数 → 累积均值归一化 → 绝对阈值 0.12 找首个局部最小 → 抛物线插值精化 → `sampleRate/tau`；清晰度低于阈值返回 null
- [ ] 步骤 4：PASS；Commit「feat: YIN 音高检测（TDD）」

## 任务 11：音高轨迹对比与统计（TDD）

**文件：**
- 创建：`app/src/pitch/compare.ts`、`app/src/pitch/compare.test.ts`

- [ ] 步骤 1：写失败测试

```ts
// compare.test.ts 要点
// extractPitchTrack：输入 AudioBuffer 替身（手造 Float32Array 分段：0-1s 441Hz、1-2s 静音、2-3s 220Hz）
//   → 轨迹 [{time~0, hz~441},{time~2, hz~220}]，静音段无点
// scoreAgainst：目标 [{time:0,duration:1,midi:69}(=440Hz), {time:2,duration:1,midi:45}(=110Hz? 不,45≈110Hz)]
//   → 实测 220 vs 目标 110：差一个八度 → cents≈1200 → inTuneRatio 反映；±50 音分内算准
// scoreStats：返回 {inTuneRatio, avgAbsCents, noteCount}
```

- [ ] 步骤 2：FAIL → 步骤 3：实现 `extractPitchTrack(buffer, {frameSec: .0464, hopSec: .0232})`（帧 2048 样本）与 `scoreAgainst(track, timeline)`（每音符窗口取实测中位频率 → cents = 1200*log2(f/fTarget)，±50 内计准；无实测样本的音符记 miss）
- [ ] 步骤 4：PASS；Commit「feat: 音高对比与统计（TDD）」

## 任务 12：回放页 + 音高对比图 + 入场/预览 3D 长笛

**文件：**
- 创建：`app/src/views/ResultPage.tsx`、`app/src/components/PitchChart.tsx`、`app/src/components/Intro.tsx`、`app/src/background/FluteModel.ts`
- 修改：`app/src/views/PreviewPage.tsx`、`app/src/App.tsx`（挂 Intro）

- [ ] 步骤 1：ResultPage：录音 `<audio>` 回放（可同时播伴奏对照：audioEngine seek 到 0 同步播——共享时间轴）、重新演奏、返回曲库；PitchChart canvas：x=时间、y=音高（半音刻度），目标音符画半透明色块、实测轨迹画点线（超 ±50 音分偏红、内为青），双击下载 webm
- [ ] 步骤 2：FluteModel：GLTFLoader（three/examples/jsm）加载 `/resources/flute.glb`（public 下复制）→ 缓慢自转 + 微浮动 + 环境光/点光；加载失败 fallback CSS 长笛条
- [ ] 步骤 3：Intro 覆盖层：品牌字 + FluteModel 3D 长笛 + 「跳过」「下次不再播放」（localStorage `syrinx_skip_intro`）；PreviewPage hero 右侧嵌同一 3D 长笛
- [ ] 步骤 4：手动验证：录音回放、图表渲染与统计数字合理、3D 长笛显示、跳过记忆生效
- [ ] 步骤 5：Commit「feat: 回放页/音高图表/3D 长笛入场」

## 任务 13：全量验证与收尾（verification-before-completion）

- [ ] 步骤 1：`npm run build` 零错误；`npm run test` 全 PASS；`npm run dev` 启动走通全流程：入场动画 → 曲库 → 预览（伴奏自动响起 + 3D 长笛）→ 演奏（同步/滚动/背景/录音）→ 回放（图表/统计）
- [ ] 步骤 2：核对 P0 清单逐项打勾（P0-1~P0-10），P2 音高检测基础达成情况记录
- [ ] 步骤 3：oxlint 通过；清理死代码/临时验证代码
- [ ] 步骤 4：更新 `D:\LLM_work\flute_app\03-设计稿\设计对比与定稿.md` 状态为已实现
- [ ] 步骤 5：最终 Commit「chore: MVP 收尾验证」

---

## 里程碑验证标准

| 里程碑 | 包含任务 | 验证标准（全部满足才算完成） |
|---|---|---|
| M1 预览+渲染 | 0-2, 6(静态渲染) | dev 启动无报错；曲库→预览→谱面渲染可见可缩放 |
| M2 同步演奏 | 3-8 | 时间轴单测 PASS；谱/音/光标同步；自动滚动；背景渲染且谱面可读；暂停/seek/变速正常 |
| M3 录音+反馈 | 9-12 | 录音生成并可回放；YIN/对比单测 PASS；图表展示音准；入场动画可跳过 |
| 收尾 | 13 | build/test/dev 三绿；P0 清单逐项核对 |

## 风险与应对

| 风险 | 应对 |
|---|---|
| happy-dom 安装失败（网络） | 降级：musicxml.ts 内置微型 XML 解析（正则提取 measure/note），单测不变 |
| OSMD followCursor 滚动行为不稳 | 自行滚动：光标元素 getBoundingClientRect → scrollIntoView({behavior:'smooth', block:'center'})，节流至小节变化时 |
| glb 模型加载慢（3.3MB） | PreviewPage 懒加载 + CSS 占位；Intro 覆盖层 loading 进度 |
| decodeAudioData 对 webm 录音在部分浏览器失败 | 音高提取仅在支持时进行；不支持时 ResultPage 显示"该浏览器暂不支持音高分析"并保留回放 |
| 麦克风权限拒绝 | toast 提示、继续演奏，ResultPage 显示无录音态 |
| 程序化合成听感单调 | 参数集中在 synth.ts 顶部常量，便于后续调优；属预期占位（正式伴奏用户外部提供） |

## 执行方式

用户已指定直接执行：采用 superpowers:executing-plans 内联执行（当前会话），每里程碑结束跑 verification-before-completion。

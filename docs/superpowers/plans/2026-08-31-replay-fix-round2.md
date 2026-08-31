# 回放页二次修复（录音无声 / 导出体积 / 排版 / 下载按钮）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复录音无声（P0：放弃 MediaRecorder，AudioWorklet 直采 Float32 PCM）、WAV 导出降为 32kHz 单声道、回放卡垂直排版、下载按钮化。

**架构：** recorder.ts 写入支路改为「worklet/fallback 直采 → 分片收集 → stop() 时拼接 + RMS 诊断 + 线性插值重采样 32kHz → encodeWav 单声道」。纯函数抽到 `pcm.ts` 供单测。MicSession 契约不变（PerformPage 仅加一条静音 toast）。ResultPage 删双击下载、加按钮；playback-card 改 flex column 居中。

**技术栈：** Web Audio API（AudioWorklet + ScriptProcessorNode fallback）、wav.ts 现有编码器、vitest。

---

## 文件结构

- 创建：`app/src/audio/pcm.ts` — 纯函数：concatFloat32 / rmsOf / resampleLinear / buildRecordingWav（含 EXPORT_RATE=32000 与静音阈值）
- 创建：`app/src/audio/pcm.test.ts` — 上述纯函数单测（不依赖真实麦克风）
- 修改：`app/src/audio/recorder.ts` — 重写写入支路（整文件替换）；RecordingResult 增加 `silent` 标记
- 修改：`app/src/views/PerformPage.tsx` — stop() 后 r.silent 时 toast 提示（约 3 行）
- 修改：`app/src/views/ResultPage.tsx` — 删双击下载与 hint、加【下载录音】按钮（防重复点击）、wav 直通下载、PlaybackDeck 包 pdeck-area
- 修改：`app/src/views/ResultPage.css` — playback-card flex column、pdeck-area 垂直居中、删 hint 样式

现有关键事实（工程师须知）：
- `MicSession` 契约（`app/src/audio/recorder.ts:20-39`）：analyser / sampleRate / readFrame / restartCapture / pauseCapture / resumeCapture / discardCapture / stop / release，**签名一律不动**。
- `openMic(ctx)` 已是 async（`PerformPage.tsx:104` 存的是 Promise），可 `await addModule`。
- `encodeWav` 接受鸭子类型 `WavBuffer`（`wav.ts:7-12`），测试替身可直接传。
- `PerformPage` 的 finish() 里 `take.mimeType` 落 store；ResultPage downloadTake 现走「fetch→decode→encodeWav」全采样率重编码——WAV 直通分支必须加，否则 32kHz 导出白做。

---

### 任务 1：pcm.ts 纯函数（TDD）

**文件：**
- 创建：`app/src/audio/pcm.test.ts`
- 创建：`app/src/audio/pcm.ts`

- [ ] **步骤 1：编写失败的测试**

`app/src/audio/pcm.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildRecordingWav, concatFloat32, EXPORT_RATE, resampleLinear, rmsOf } from './pcm'

describe('concatFloat32', () => {
  it('按序拼接多段', () => {
    expect(Array.from(concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })
  it('空输入产出长度 0', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})

describe('rmsOf', () => {
  it('方均根：[0.5,-0.5,0.5,-0.5] -> 0.5', () => {
    expect(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
  })
  it('全零 -> 0', () => {
    expect(rmsOf(new Float32Array(8))).toBe(0)
  })
})

describe('resampleLinear', () => {
  it('同采样率原样返回', () => {
    const src = new Float32Array([1, 2, 3])
    expect(resampleLinear(src, 48000, 48000)).toBe(src)
  })
  it('降采样 8k->4k：[0,2,4,8] -> [0,4]', () => {
    const out = resampleLinear(new Float32Array([0, 2, 4, 8]), 8000, 4000)
    expect(Array.from(out)).toEqual([0, 4])
  })
  it('升采样 4k->8k：[0,2] -> [0,1,2,2]（末端夹取保持）', () => {
    const out = resampleLinear(new Float32Array([0, 2]), 4000, 8000)
    expect(Array.from(out)).toEqual([0, 1, 2, 2])
  })
  it('空输入 -> 空输出', () => {
    expect(resampleLinear(new Float32Array(0), 48000, EXPORT_RATE).length).toBe(0)
  })
})

describe('buildRecordingWav', () => {
  it('两段 8kHz 分片拼成 32kHz 单声道 WAV：头 44 + 128 数据字节', async () => {
    const chunks = [new Float32Array(8).fill(0.5), new Float32Array(8).fill(0.5)]
    const { blob, silent } = buildRecordingWav(chunks, 8000)
    expect(silent).toBe(false)
    expect(blob.type).toBe('audio/wav')
    const ab = await blob.arrayBuffer()
    expect(ab.byteLength).toBe(44 + 64 * 2)
    const v = new DataView(ab)
    expect(v.getUint16(22, true)).toBe(1) // 单声道
    expect(v.getUint32(24, true)).toBe(EXPORT_RATE)
  })
  it('全零分片 -> silent=true（RMS 诊断标记）', () => {
    const { silent } = buildRecordingWav([new Float32Array(16)], 48000)
    expect(silent).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd app; npx vitest run src/audio/pcm.test.ts`
预期：FAIL（模块 `./pcm` 不存在）

- [ ] **步骤 3：编写实现**

`app/src/audio/pcm.ts`：

```ts
/**
 * 录音 PCM 纯函数：分片拼接、RMS 诊断、线性插值重采样、导出 WAV 组装。
 * 从 recorder.ts 写入支路抽出，供单测（不依赖真实麦克风/AudioContext）。
 */
import { encodeWav } from './wav'

/** 导出目标采样率：32kHz 单声道 16-bit ≈ 64KB/s（一分钟约 4MB），
 *  对长笛音域（≤2.5kHz，远低于 16kHz 奈奎斯特）无信息损失 */
export const EXPORT_RATE = 32000
/** 整段 RMS 低于此值视为静音（诊断标记，不阻断产出） */
export const SILENT_RMS = 1e-4

/** 按序拼接多段 Float32；空输入返回长度 0 的新数组 */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Float32Array(n)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 方均根电平（0..1） */
export function rmsOf(buf: Float32Array): number {
  if (!buf.length) return 0
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
  return Math.sqrt(sum / buf.length)
}

/** 线性插值重采样：srcRate===dstRate 时原样返回（调用方传入的即拼接新数组，可安全共享）。
 *  输出长度 = ceil(src.length * dstRate / srcRate)；末端下标夹取（保持最后样本）。 */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src
  if (!src.length) return new Float32Array(0)
  const out = new Float32Array(Math.ceil((src.length * dstRate) / srcRate))
  const ratio = srcRate / dstRate
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.min(Math.floor(pos), src.length - 1)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0]! * (1 - frac) + src[i1]! * frac
  }
  return out
}

export interface RecordingWav {
  blob: Blob
  /** 整段 RMS < SILENT_RMS 时 true：疑似麦克风静音，供上层提示诊断 */
  silent: boolean
}

/** 采集分片 -> 拼接 -> RMS 诊断 -> 32kHz 单声道 WAV */
export function buildRecordingWav(chunks: readonly Float32Array[], srcRate: number): RecordingWav {
  const pcm = resampleLinear(concatFloat32(chunks), srcRate, EXPORT_RATE)
  const silent = rmsOf(pcm) < SILENT_RMS
  const blob = encodeWav({
    sampleRate: EXPORT_RATE,
    numberOfChannels: 1,
    length: pcm.length,
    getChannelData: () => pcm,
  })
  return { blob, silent }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd app; npx vitest run src/audio/pcm.test.ts`
预期：PASS（9 个用例全绿）

- [ ] **步骤 5：Commit**

```bash
git add app/src/audio/pcm.ts app/src/audio/pcm.test.ts
git commit -m "feat: 录音 PCM 纯函数（拼接/RMS/32kHz 线性重采样/单声道 WAV 组装）"
```

---

### 任务 2：重写 recorder.ts 写入支路（AudioWorklet 直采）

**文件：**
- 修改：`app/src/audio/recorder.ts`（整文件替换）

说明：本任务无可单测的浏览器依赖逻辑（addModule/MessagePort/ScriptProcessor），正确性由任务 1 纯函数 + 构建期类型检查 + 用户实测覆盖。关键设计：
- **同源保证**：写入支路挂在**同一个** MediaStreamAudioSourceNode 上（与分析支路 AnalyserNode 并联）——分析听得到就一定录得到，这是修 P0 的核心。
- **AudioWorklet 注册**：worklet 处理器源码以内联字符串 + Blob URL `addModule`；`WeakSet<AudioContext>` 防同上下文重复注册（重注册会抛 AlreadyProcessed）；注册失败（旧浏览器/受控环境）回退 `ScriptProcessorNode`（零增益接地驱动，不外放）。
- **门控与竞态**：主线程发 `{type:'gate', on, id}`；worklet 回传分片时带 `id`，主线程只收当前段的分片（丢弃旧段时在途分片作废）。
- **暂停语义**：gate off = 丢弃样本（等价 MediaRecorder pause：「写入关」时段不进文件）。

- [ ] **步骤 1：整文件替换 recorder.ts**

```ts
/**
 * 麦克风会话封装：getUserMedia（关闭回声消除/降噪/自动增益，保留原始
 * 音高信息供 YIN 分析）+ 两条支路，共享同一个 MediaStreamAudioSourceNode：
 * - 分析流：source -> AnalyserNode（挂主 AudioContext，与伴奏同一时钟域），
 *   getFloatTimeDomainData 逐帧喂 YIN。演奏全程保持开启，不受录音开关影响。
 * - 写入流（t_静音修复）：source -> 直采节点（AudioWorklet 优先，旧浏览器回退
 *   ScriptProcessorNode），PCM Float32 分片经 MessagePort 回主线程收集。
 *   与分析支路同源同节点——分析听得到就一定录得到；此前 MediaRecorder 写入
 *   支路在部分环境产出全静音 blob（音高图为空、下载无声），故弃用。
 *   stop() 时拼接分片、RMS 诊断（整段≈0 打 warn 并带 silent 标记）、
 *   重采样 32kHz 单声道后 encodeWav。
 *
 * 暂停/恢复/重开/丢弃语义与旧 MediaRecorder 版一致（MicSession 契约不变）。
 * stop() 定稿采集并释放音轨（共享上下文不关闭）；release() 用于中途退出，
 * 丢弃一切且不产出 blob。
 */
import { buildRecordingWav } from './pcm'

export interface RecordingResult {
  blob: Blob
  url: string
  mime: string
  /** 整段 RMS 接近 0（疑似麦克风静音）的诊断标记，上层可提示 */
  silent: boolean
}

export interface MicSession {
  /** 实时分析节点（fftSize=2048），演奏页 rAF 循环逐帧读取喂 YIN */
  analyser: AnalyserNode
  /** 采样率（YIN 需要，与主上下文一致） */
  sampleRate(): number
  /** 取当前分析帧（复用同一 Float32Array，调用方当帧用完即弃） */
  readFrame(): Float32Array
  /** 丢弃当前段并立即重开一段新采集 */
  restartCapture(): void
  /** 暂停写入（音轨与分析流保持开启），对齐伴奏暂停 */
  pauseCapture(): void
  /** 继续写入 */
  resumeCapture(): void
  /** 丢弃当前段，写入流关闭 */
  discardCapture(): void
  /** 定稿采集、释放音轨并返回整段 blob 与可回放 ObjectURL（调用方负责 revoke） */
  stop: () => Promise<RecordingResult>
  /** 中途退出：丢弃一切并释放音轨，不产出 blob */
  release(): void
}

/** AudioWorklet 处理器源码（内联字符串 + Blob URL 注册，避免打包器路径问题）。
 *  主线程 gate 消息控制写入开关；分片回传带段 id，旧段在途分片在主线程作废。 */
const WORKLET_SRC = `
class MicTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.gateOn = false
    this.id = -1
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'gate') {
        this.gateOn = e.data.on
        this.id = e.data.id
      }
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && this.gateOn) {
      const copy = new Float32Array(ch)
      this.port.postMessage({ id: this.id, pcm: copy }, [copy.buffer])
    }
    return true
  }
}
registerProcessor('mic-tap', MicTapProcessor)
`

/** 直采节点统一门控接口（worklet 与 fallback 同构） */
interface Tap {
  /** 开/关写入（on=false 时样本直接丢弃） */
  setGate(on: boolean, id: number): void
  /** 断开并释放（随 release/stop 调用） */
  dispose(): void
}

/** 已注册过 mic-tap 模块的上下文（同上下文重复 addModule 会抛异常） */
const workletReady = new WeakSet<AudioContext>()

/** AudioWorklet 直采节点；注册失败抛异常由调用方回退 */
async function createWorkletTap(ctx: AudioContext, onChunk: (id: number, pcm: Float32Array) => void): Promise<Tap> {
  if (!workletReady.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    workletReady.add(ctx)
  }
  const node = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 0 })
  node.port.onmessage = (e: MessageEvent<{ id: number; pcm: Float32Array }>) => onChunk(e.data.id, e.data.pcm)
  return {
    setGate: (on, id) => void node.port.postMessage({ type: 'gate', on, id }),
    dispose: () => {
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    },
  }
}

/** ScriptProcessorNode 回退：必须接 destination 才跑，经零增益接地（不外放） */
function createFallbackTap(
  ctx: AudioContext,
  onChunk: (id: number, pcm: Float32Array) => void,
): { tap: Tap; attach: (source: AudioNode) => void } {
  const sp = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  sp.connect(mute)
  mute.connect(ctx.destination)
  let gateOn = false
  let id = -1
  sp.onaudioprocess = (e) => {
    if (!gateOn) return
    onChunk(id, new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  return {
    tap: {
      setGate: (on, nextId) => {
        gateOn = on
        id = nextId
      },
      dispose: () => {
        sp.onaudioprocess = null
        sp.disconnect()
        mute.disconnect()
      },
    },
    attach: (source) => void source.connect(sp),
  }
}

export async function openMic(ctx: AudioContext): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('该环境不支持麦克风采集')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })

  // 分析支路：挂主上下文，不连 destination（不外放）
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const frameBuf = new Float32Array(analyser.fftSize)

  // 写入支路：收集当前段分片（id 作废旧段在途分片）；gate 由采集语义驱动
  let chunks: Float32Array[] = []
  let captureId = -1 // -1 = 无进行中的段
  const onChunk = (id: number, pcm: Float32Array) => {
    if (id === captureId && id >= 0) chunks.push(pcm)
  }

  let tap: Tap
  let fallbackAttach: ((s: AudioNode) => void) | null = null
  try {
    tap = await createWorkletTap(ctx, onChunk)
    source.connect(tapNode) // 占位，见下方注意
  } catch {
    const fb = createFallbackTap(ctx, onChunk)
    tap = fb.tap
    fallbackAttach = fb.attach
  }
  // worklet 节点也要接 source（上面占位行在最终代码里由下方统一连接替换）
  // ——见步骤 1 实际代码：worklet 分支直接 source.connect(node)，本注释块不存在。

  const attachSource = (node: AudioNode) => source.connect(node)

  const releaseTracks = () => stream.getTracks().forEach((t) => t.stop())

  return {
    analyser,
    sampleRate: () => ctx.sampleRate,
    readFrame: () => {
      analyser.getFloatTimeDomainData(frameBuf)
      return frameBuf
    },
    restartCapture() {
      chunks = []
      captureId += 1
      tap.setGate(true, captureId)
    },
    pauseCapture() {
      tap.setGate(false, captureId)
    },
    resumeCapture() {
      if (captureId >= 0) tap.setGate(true, captureId)
    },
    discardCapture() {
      chunks = []
      captureId = -1
      tap.setGate(false, -1)
    },
    stop: async () => {
      const collected = chunks
      chunks = []
      captureId = -1
      tap.setGate(false, -1)
      tap.dispose()
      if (fallbackAttach) fallbackAttach = null
      releaseTracks()
      if (!collected.length) {
        const blob = new Blob()
        return { blob, url: URL.createObjectURL(blob), mime: 'audio/wav', silent: false }
      }
      const { blob, silent } = buildRecordingWav(collected, ctx.sampleRate)
      if (silent) {
        // 诊断输出：写入支路本身有产出但电平≈0，说明输入源静音（静音表/系统输入）
        console.warn(`[recorder] 录音整段 RMS < 1e-4（疑似静音）：${collected.length} 分片，请检查麦克风输入`)
      }
      return { blob, url: URL.createObjectURL(blob), mime: 'audio/wav', silent }
    },
    release() {
      chunks = []
      captureId = -1
      tap.setGate(false, -1)
      tap.dispose()
      releaseTracks()
    },
  }
}
```

**注意（实际落地时修正上面示意中的两处占位）：**
1. `createWorkletTap` 返回 `Tap` 但连接 source 需要拿到 node —— 让 `createWorkletTap` 额外暴露节点：返回 `{ tap, node }`，worklet 分支 `source.connect(node)`；fallback 分支 `fb.attach(source)`。最终代码以此为准，不留注释占位。
2. source → worklet 的连接在 `tap.dispose()` 时由 `node.disconnect()` 断开是不够的（`node.disconnect` 只断 node 侧，source→node 由 source.disconnect(node) 断）——dispose 实现为：worklet 分支记录 node，`source.disconnect(node) + node.disconnect()`；fallback 分支 `source.disconnect(sp) + sp.disconnect() + mute.disconnect()`。为简化：Tap.dispose 闭包内直接引用 source 与目标节点，各分支自行断干净。

- [ ] **步骤 2：类型检查**

运行：`cd app; npx tsc -b`
预期：无错误（PerformPage 使用的 MicSession 成员全部未变；RecordingResult 新增 silent 不破坏旧用法）

- [ ] **步骤 3：跑既有测试防回归**

运行：`cd app; npx vitest run`
预期：全绿（wav/compare/pcm 等）

- [ ] **步骤 4：Commit**

```bash
git add app/src/audio/recorder.ts
git commit -m "fix: 录音写入支路改 AudioWorklet 直采（与分析支路同源），修复导出全静音"
```

---

### 任务 3：ResultPage 下载按钮 + WAV 直通 + 排版 JSX

**文件：**
- 修改：`app/src/views/ResultPage.tsx`

- [ ] **步骤 1：JSX 与逻辑修改**

1. 组件顶部加状态：`const [downloading, setDownloading] = useState(false)`
2. `downloadTake` 改造：入口防抖（`downloading` 时直接 return）、`try/finally` 复位；新增 WAV 直通分支（recorder 产出的已是 32kHz 单声道 WAV，解码重编码会放大体积且多余）；旧 webm/mp4 take 保留原解码路径：

```tsx
const downloadTake = async () => {
  if (!take || downloading) return
  setDownloading(true)
  const stamp = new Date(take.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')
  const saveAs = (href: string, ext: string) => {
    const a = document.createElement('a')
    a.href = href
    a.download = `syrinx-${song.id}-${stamp}.${ext}`
    a.click()
  }
  try {
    if (take.mimeType === 'audio/wav') {
      // 直采录音已是 32kHz 单声道 WAV：直接下载，解码重编码反而放大体积
      saveAs(take.audioUrl, 'wav')
      return
    }
    // 旧版 MediaRecorder webm/mp4 take：解码重编码 WAV（webm 缺 duration 元数据，
    // 直接下载在部分播放器无声）；解码失败回退原样下载
    try {
      const res = await fetch(take.audioUrl)
      const buffer = await audioEngine.decode(await res.arrayBuffer())
      const url = URL.createObjectURL(encodeWav(buffer))
      saveAs(url, 'wav')
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      const ext = take.mimeType.includes('mp4') ? 'mp4' : 'webm'
      saveAs(take.audioUrl, ext)
    }
  } finally {
    setDownloading(false)
  }
}
```

3. playback-card JSX：PlaybackDeck 包进 `pdeck-area`（垂直居中容器）；删除 hint span，换成下载按钮：

```tsx
<div className="playback-card">
  <h3>录音回放</h3>
  <div className="pdeck-area">
    <PlaybackDeck src={take.audioUrl} accent={song.accent} audioRef={audioRef} />
  </div>
  <div className="playback-actions">
    <button
      className="btn-pill sync"
      onClick={() => void toggleSyncPlay()}
      disabled={audioEngine.duration === 0}
      title="录音与伴奏从同一时刻起播，对照听辨"
    >
      {syncPlaying ? '❚❚ 停止对照' : '♫ 对照伴奏播放'}
    </button>
    <button
      className="btn-pill"
      onClick={() => void downloadTake()}
      disabled={downloading}
      title="下载本段录音（32kHz 单声道 WAV）"
    >
      {downloading ? '下载中…' : '⤓ 下载录音'}
    </button>
  </div>
</div>
```

4. chart-section 删除 `onDoubleClick={downloadTake}` 与 `title="双击下载录音"`。

- [ ] **步骤 2：类型检查**

运行：`cd app; npx tsc -b`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add app/src/views/ResultPage.tsx
git commit -m "feat: 下载录音改显式按钮（防重复）+ WAV 直通；删图表双击下载"
```

---

### 任务 4：回放卡排版 CSS

**文件：**
- 修改：`app/src/views/ResultPage.css`

- [ ] **步骤 1：样式修改**

在 `.playback-card h3` 共享规则之后追加（并删掉 `.playback-actions .hint` 规则——hint 元素已不存在）：

```css
/* 回放卡与统计卡等高：flex 列布局，回放控件在剩余空间垂直居中，
   操作按钮沉底，避免内容挤在上半、下半空心 */
.playback-card {
  display: flex;
  flex-direction: column;
}
.playback-card h3 {
  margin-bottom: 0;
}
.pdeck-area {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 14px 0;
}
```

注意：`.playback-card h3` 与 `.stats-card h3` 共用一条规则（`margin-bottom: 14px`），追加的覆盖规则写在共享规则之后即可只影响 playback-card。

- [ ] **步骤 2：dev server 热更目检**

dev server 正在跑。目检回放页：两卡等高时回放控件垂直居中、按钮沉底，与统计卡视觉平衡。

- [ ] **步骤 3：Commit**

```bash
git add app/src/views/ResultPage.css
git commit -m "style: 回放卡 flex 列布局，回放控件垂直居中与统计卡平衡"
```

---

### 任务 5：PerformPage 静音诊断提示

**文件：**
- 修改：`app/src/views/PerformPage.tsx`（finish() 内，约 `PerformPage.tsx:150-160`）

- [ ] **步骤 1：修改**

`mic.stop().then((r) => { ... })` 内、非 discard 分支加：

```tsx
if (r.silent) showToast('警告：录音电平接近 0，回放将无声；请检查麦克风/系统输入设备')
```

（console.warn 已在 recorder stop() 内打出，此处给用户可见信号。）

- [ ] **步骤 2：类型检查 + 全量测试**

运行：`cd app; npx tsc -b; npx vitest run`
预期：无类型错误、全绿

- [ ] **步骤 3：Commit**

```bash
git add app/src/views/PerformPage.tsx
git commit -m "feat: 录音疑似静音时演奏页 toast 提示（RMS 诊断用户可见化）"
```

---

## 自检

- **规格覆盖**：任务 1+2 覆盖 P0（AudioWorklet 同源直采 + RMS 诊断 + blob 标记）；任务 1（EXPORT_RATE=32000）+ 任务 3（WAV 直通不再全率重编码）覆盖导出体积；任务 4 覆盖排版；任务 3 覆盖下载按钮化（删双击/hint、防重复点击）；任务 5 补用户可见诊断。无遗漏。
- **占位符**：任务 2 示意代码含两处明确标注的「落地时修正」注意点（Tap 需暴露节点以断连 source）——执行时以注意点为准写最终代码，不留注释占位。
- **类型一致性**：`RecordingResult.silent` 在任务 2 定义、任务 5 消费；`buildRecordingWav(chunks, srcRate)` 在任务 1 定义、任务 2 消费；`EXPORT_RATE` 任务 1 定义、任务 1 测试引用。MicSession 全成员签名与现有 PerformPage 用法一致。

## 验收命令

- `cd app && npx vitest run`（全绿）
- `cd app && npm run build`（tsc -b + vite build 通过）
- git commit（不 push；逐文件 add，仓库内有大量他人未提交文件）

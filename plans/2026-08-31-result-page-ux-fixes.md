# 回放页体验修复（8 项）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Syrinx 回放页（ResultPage）8 项体验问题，重点是 P0「下载录音无声」。

**架构：** 前端 React 19 + TS + Vite（`app/`）。P0 根因为 MediaRecorder 产出的 webm 缺 duration 元数据导致部分播放器无声/0:00——修复方案是下载前用 AudioContext 解码后重编码为 WAV（浏览器全兼容、无新增依赖）。其余 7 项为 UI/文案/口径说明/逻辑核实，全部集中在 `app/src/views/ResultPage.tsx|.css`、`app/src/components/ControlBar.tsx|.css`、`app/src/pitch/compare.test.ts`、`app/vite.config.ts`。

**技术栈：** React 19、Vite 8、Vitest 4（happy-dom，include `src/**/*.test.ts`）、oxlint。

**执行注意（来自项目记忆）：**
- `npx/npm` 类命令可能被权限静默拒绝：实现照做，验证命令原样交给用户手跑，报告里注明。
- 工作区有大量他人未提交改动（git status 很脏）：commit 时逐文件 `git add`，绝不 `git add -A`；提交前核对 `git log` 与 `git status`。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `app/src/audio/wav.ts` | 创建 | 纯函数 `encodeWav`：解码后音频（鸭子类型 AudioBuffer）→ 16-bit PCM WAV Blob |
| `app/src/audio/wav.test.ts` | 创建 | WAV 头/数据布局单测 |
| `app/src/components/PlaybackDeck.tsx` | 创建 | 自绘回放卡：播放/暂停按钮 + 可点击进度条 + 时间显示（内嵌 `<audio>`，经 ref 暴露给 ResultPage 做对照播放） |
| `app/src/views/ResultPage.tsx` | 修改 | P0 下载重编码、删反馈区块、文案、口径小字、topbar logo/返回按钮、换用 PlaybackDeck |
| `app/src/views/ResultPage.css` | 修改 | 删 feedback 样式；新增 pdeck / stats-note / back-ghost / logo 样式 |
| `app/src/components/ControlBar.tsx` | 修改 | 录音按钮改麦克风 SVG + REC 录制态 |
| `app/src/components/ControlBar.css` | 修改 | 麦克风图标与红色呼吸录制态样式 |
| `app/src/lib/feedback.ts` | 删除 | 试奏反馈落盘客户端（grep 确认仅 ResultPage 引用） |
| `app/vite.config.ts` | 修改 | 删除 feedbackApi dev 中间件（仅被 feedback.ts 消费的死代码） |
| `app/src/pitch/compare.test.ts` | 修改 | 补 ONSET_SKIP/OFFSET_SKIP 窗口边界测试 |

不新增任何依赖。

---

### 任务 1：P0 下载录音无声——WAV 重编码修复

**根因假设（执行时先复现确认）：** MediaRecorder webm blob 的 EBML 头缺 Duration 元素（Chrome 已知问题），下载后的文件在 Windows Media Player 等播放器里显示 0:00 且无声。修复 = 下载前 `audioEngine.decode` 重解码 + `encodeWav` 重编码，产物为标准 WAV，任何播放器可播。解码失败时回退原样下载（保留现状兜底）。

**文件：**
- 创建：`app/src/audio/wav.ts`、`app/src/audio/wav.test.ts`
- 修改：`app/src/views/ResultPage.tsx:146-154`（downloadTake）

- [ ] **步骤 1：复现确认根因**

  手动路径（若命令被权限拒绝则交用户执行）：`cd app && npm run dev` → 浏览器开演奏页开录音演奏一段 → 回放页双击图表下载 → `ffprobe -hide_banner <下载的.webm>`，观察 `Duration: N/A`。确认后继续（不阻塞实现：修复方案对 mime 元数据问题与 blob 生命周期问题均有效）。

- [ ] **步骤 2：编写失败的测试**

  `app/src/audio/wav.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest'
  import { encodeWav } from './wav'

  const SR = 8000

  /** 双声道替身：ch0 全 0、ch1 前 3 样本 +1/-1/+0.5 其余 0 */
  function makeBuffer() {
    const ch0 = new Float32Array(4)
    const ch1 = new Float32Array([1, -1, 0.5, 0])
    return { sampleRate: SR, numberOfChannels: 2, length: 4, getChannelData: (c: number) => (c === 0 ? ch0 : ch1) }
  }

  describe('encodeWav', () => {
    it('44 字节头 + 4 样本 ×2 声道 ×2 字节 = 60 字节，RIFF/WAVE/fmt/data 魔数齐全', async () => {
      const blob = encodeWav(makeBuffer())
      expect(blob.type).toBe('audio/wav')
      const ab = await blob.arrayBuffer()
      expect(ab.byteLength).toBe(60)
      const v = new DataView(ab)
      const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(ab, o, n))
      expect(str(0, 4)).toBe('RIFF')
      expect(v.getUint32(4, true)).toBe(36 + 16) // PCM 数据 16 字节
      expect(str(8, 4)).toBe('WAVE')
      expect(str(12, 4)).toBe('fmt ')
      expect(v.getUint16(20, true)).toBe(1) // PCM
      expect(v.getUint16(22, true)).toBe(2) // 声道
      expect(v.getUint32(24, true)).toBe(SR)
      expect(v.getUint16(34, true)).toBe(16) // 位深
      expect(str(36, 4)).toBe('data')
      expect(v.getUint32(40, true)).toBe(16)
    })

    it('样本交织写入且削幅到 int16：0→0、+1→0x7fff、-1→-0x8000、+0.5→约 0x4000', async () => {
      const ab = await encodeWav(makeBuffer()).arrayBuffer()
      const v = new DataView(ab)
      // 交织序：ch0[0], ch1[0], ch0[1], ch1[1], ch0[2], ch1[2], ch0[3], ch1[3]
      expect(v.getInt16(44, true)).toBe(0)
      expect(v.getInt16(46, true)).toBe(0x7fff)
      expect(v.getInt16(48, true)).toBe(0)
      expect(v.getInt16(50, true)).toBe(-0x8000)
      expect(v.getInt16(52, true)).toBe(0)
      expect(Math.abs(v.getInt16(54, true) - 0x4000)).toBeLessThanOrEqual(1)
    })
  })
  ```

- [ ] **步骤 3：运行测试验证失败**

  运行：`cd app && npx vitest run src/audio/wav.test.ts`
  预期：FAIL（`./wav` 模块不存在）

- [ ] **步骤 4：实现 encodeWav**

  `app/src/audio/wav.ts`：

  ```ts
  /**
   * WAV（16-bit PCM）编码器：下载导出用。
   * MediaRecorder 的 webm blob 缺 Duration 元数据（Chrome 已知问题），
   * 下载后在部分播放器无声/0:00；解码后重编码为 WAV 可全兼容播放。
   * 输入为 AudioBuffer 鸭子类型，测试替身可直接传入。
   */
  export interface WavBuffer {
    sampleRate: number
    numberOfChannels: number
    length: number
    getChannelData(channel: number): Float32Array
  }

  export function encodeWav(buffer: WavBuffer): Blob {
    const { sampleRate: sr, numberOfChannels: ch, length } = buffer
    const dataBytes = length * ch * 2
    const ab = new ArrayBuffer(44 + dataBytes)
    const v = new DataView(ab)
    const str = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
    }
    str(0, 'RIFF')
    v.setUint32(4, 36 + dataBytes, true)
    str(8, 'WAVE')
    str(12, 'fmt ')
    v.setUint32(16, 16, true) // fmt 块长
    v.setUint16(20, 1, true) // PCM
    v.setUint16(22, ch, true)
    v.setUint32(24, sr, true)
    v.setUint32(28, sr * ch * 2, true) // byte rate
    v.setUint16(32, ch * 2, true) // block align
    v.setUint16(34, 16, true) // bits per sample
    str(36, 'data')
    v.setUint32(40, dataBytes, true)
    const chans: Float32Array[] = []
    for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c))
    let off = 44
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c]![i] ?? 0))
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        off += 2
      }
    }
    return new Blob([ab], { type: 'audio/wav' })
  }
  ```

- [ ] **步骤 5：运行测试验证通过**

  运行：`cd app && npx vitest run src/audio/wav.test.ts`
  预期：PASS

- [ ] **步骤 6：改造 downloadTake（重编码 + 解码失败回退）**

  ResultPage.tsx：顶部加 `import { encodeWav } from '../audio/wav'`；将 `downloadTake`（现 146-154 行）替换为：

  ```tsx
  /** 下载文件名时间戳：20260831T123456 形态 */
  const takeStamp = () => new Date(take!.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')

  /** 双击图表下载录音：解码重编码为 WAV（MediaRecorder webm 缺 duration 元数据，
   *  直接下载在部分播放器无声）；解码失败回退原样 webm/mp4 */
  const downloadTake = async () => {
    if (!take) return
    const fallback = () => {
      const ext = take.mimeType.includes('mp4') ? 'mp4' : 'webm'
      const a = document.createElement('a')
      a.href = take.audioUrl
      a.download = `syrinx-${song.id}-${takeStamp()}.${ext}`
      a.click()
    }
    try {
      const res = await fetch(take.audioUrl)
      const buffer = await audioEngine.decode(await res.arrayBuffer())
      const url = URL.createObjectURL(encodeWav(buffer))
      const a = document.createElement('a')
      a.href = url
      a.download = `syrinx-${song.id}-${takeStamp()}.wav`
      a.click()
      // 留出浏览器取走 blob 的时间再释放
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      fallback()
    }
  }
  ```

  调用处 `onDoubleClick={downloadTake}` 保持不变（async 函数可直接作 handler）。

- [ ] **步骤 7：验证 + Commit**

  运行：`cd app && npx vitest run src/audio/wav.test.ts src/pitch/compare.test.ts && npx tsc -b`
  预期：全绿、无类型错误。手动验证（dev 下载播放出声）放任务 7 统一做。

  ```bash
  git add app/src/audio/wav.ts app/src/audio/wav.test.ts app/src/views/ResultPage.tsx
  git commit -m "fix: 回放页下载录音无声--解码重编码 WAV 导出（webm 缺 duration 元数据）"
  ```

---

### 任务 2：删除「试奏反馈」区块

**文件：**
- 修改：`app/src/views/ResultPage.tsx`、`app/src/views/ResultPage.css`、`app/vite.config.ts`
- 删除：`app/src/lib/feedback.ts`

grep 已确认：`feedback` 在 `app/src` 内仅被 `ResultPage.tsx` 与 `lib/feedback.ts` 自身引用（`synth.ts` 的 feedback 是延迟反馈节点，无关）；dev 落盘端点在 `vite.config.ts` 的 `feedbackApi()`，删除客户端后成死代码，一并移除。

- [ ] **步骤 1：ResultPage.tsx 删除反馈相关代码**

  - 删 `import { loadFeedback, submitFeedback } from '../lib/feedback'`（第 4 行）
  - 删状态与逻辑（第 30-66 行）：`fbRating/fbComment/fbState/fbError/fbExisting` 全部 state、loadFeedback 的 useEffect、`submitFb` 回调；相应清理 `useCallback` import 若不再被其他代码使用（`toggleSyncPlay` 仍用 useCallback，保留）
  - 删 JSX `<section className="feedback-card">…</section>` 整块（第 297-335 行）

- [ ] **步骤 2：ResultPage.css 删除反馈样式**

  删第 202-279 行 `/* 试奏反馈（t_b3080db9）… */` 起至 `.feedback-err` 规则结束的整段（`.feedback-card/.feedback-stars/.star/.feedback-count/.feedback-text/.feedback-actions/.feedback-done/.feedback-err`）。

- [ ] **步骤 3：删除 lib/feedback.ts 与 vite 端点**

  - `git rm app/src/lib/feedback.ts`（或删文件后 git add 记录删除）
  - `app/vite.config.ts`：删 `feedbackApi` 函数（第 8-53 行）与 plugins 里的引用，改为 `plugins: [react()]`；清理仅其使用的 import（`node:fs` 的 `existsSync/mkdirSync/readFileSync/writeFileSync`、`node:path` 的 `join`）——删除前核对文件其余部分是否还在用。

- [ ] **步骤 4：验证 + Commit**

  运行：`cd app && npx vitest run && npx tsc -b`
  预期：全绿（无任何测试引用 feedback，无需改测试）

  ```bash
  git add app/src/views/ResultPage.tsx app/src/views/ResultPage.css app/src/lib/feedback.ts app/vite.config.ts
  git commit -m "refactor: 删除试奏反馈区块及其 dev 落盘端点（死代码清理）"
  ```

---

### 任务 3：演奏页录音按钮改麦克风图标 + REC 录制态

**文件：**
- 修改：`app/src/components/ControlBar.tsx:39-48`、`app/src/components/ControlBar.css:42-72`

- [ ] **步骤 1：ControlBar.tsx 替换录音按钮内容**

  ```tsx
  <button
    className={`ctl rec${recOn ? ' on' : ''}`}
    onClick={onRecToggle}
    disabled={ended}
    aria-label={recOn ? '关闭录音' : '开启录音'}
    aria-pressed={recOn}
    title={recOn ? '关闭录音（丢弃当前段，重新开启即重录）' : '开启录音（从头重录）'}
  >
    <svg className="rec-mic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20M9 20h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
    {recOn && <span className="rec-badge">REC</span>}
  </button>
  ```

- [ ] **步骤 2：ControlBar.css 替换 rec 样式**

  删 `.ctl.rec .rec-dot` / `.ctl.rec.on .rec-dot` / `@keyframes rec-pulse`（第 42-69 行），替换为：

  ```css
  /* 录音开关：麦克风图标，开着时红色呼吸 + REC 徽标 */
  .ctl.rec {
    width: auto;
    min-width: 40px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .ctl.rec .rec-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
  }
  .ctl.rec.on {
    color: var(--rec);
  }
  .ctl.rec.on svg {
    animation: rec-pulse 1.6s ease-in-out infinite;
  }
  @keyframes rec-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  ```

  保留既有 `.ctl.rec.on:hover`（红色底）不变。

- [ ] **步骤 3：验证 + Commit**

  运行：`cd app && npx tsc -b && npx oxlint`
  预期：无错误。目测验证（图标可辨识、录制态红色呼吸 + REC）放任务 7。

  ```bash
  git add app/src/components/ControlBar.tsx app/src/components/ControlBar.css
  git commit -m "feat: 演奏页录音按钮改麦克风 SVG 图标，录制态红色呼吸 + REC 徽标"
  ```

---

### 任务 4：录音回放卡自绘（播放按钮 + 可点进度条 + 时间）

**文件：**
- 创建：`app/src/components/PlaybackDeck.tsx`
- 修改：`app/src/views/ResultPage.tsx:206-220`、`app/src/views/ResultPage.css`

设计约束：ResultPage 的对照播放（`toggleSyncPlay`）需要拿到 `<audio>` 元素 ref 与 `ended` 事件，因此组件接受外部 ref；webm 在 `<audio>` 里 `duration` 常为 `Infinity`，用已知 hack（seek 到大时间再归零）逼出真实时长，seek 才有意义。

- [ ] **步骤 1：创建 PlaybackDeck 组件**

  `app/src/components/PlaybackDeck.tsx`：

  ```tsx
  import { useEffect, useRef, useState, type RefObject } from 'react'

  interface Props {
    src: string
    /** 强调色（进度条填充） */
    accent: string
    /** 录音 <audio> 元素由调用方持有（对照播放共用同一元素） */
    audioRef: RefObject<HTMLAudioElement | null>
    /** 纯录音时长未知时的兜底显示（秒） */
    fallbackDurationSec?: number
  }

  const fmt = (sec: number): string => {
    if (!Number.isFinite(sec)) return '0:00'
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
  }

  /** 自绘回放卡：播放/暂停 + 可点击进度条 + 时间显示。
   * MediaRecorder webm 在 <audio> 里 duration 常为 Infinity，
   * loadedmetadata 后用「先 seek 大时间再归零」逼出真实时长。 */
  export default function PlaybackDeck({ src, accent, audioRef, fallbackDurationSec = 0 }: Props) {
    const [playing, setPlaying] = useState(false)
    const [time, setTime] = useState(0)
    const [duration, setDuration] = useState(fallbackDurationSec)
    const trackRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const el = audioRef.current
      if (!el) return
      setTime(0)
      setPlaying(false)
      setDuration(fallbackDurationSec)
      const onMeta = () => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          setDuration(el.duration)
          return
        }
        // webm 无 duration 元数据：seek 到远端触发时长计算
        const onSeek = () => {
          el.removeEventListener('timeupdate', onSeek)
          setDuration(Number.isFinite(el.duration) ? el.duration : fallbackDurationSec)
          el.currentTime = 0
        }
        el.addEventListener('timeupdate', onSeek)
        el.currentTime = 1e6
      }
      const onTime = () => setTime(el.currentTime)
      const onPlay = () => setPlaying(true)
      const onPause = () => setPlaying(false)
      const onEnded = () => {
        setPlaying(false)
        setTime(0)
        el.currentTime = 0
      }
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('timeupdate', onTime)
      el.addEventListener('play', onPlay)
      el.addEventListener('pause', onPause)
      el.addEventListener('ended', onEnded)
      return () => {
        el.removeEventListener('loadedmetadata', onMeta)
        el.removeEventListener('timeupdate', onTime)
        el.removeEventListener('play', onPlay)
        el.removeEventListener('pause', onPause)
        el.removeEventListener('ended', onEnded)
      }
    }, [audioRef, src, fallbackDurationSec])

    const toggle = () => {
      const el = audioRef.current
      if (!el) return
      if (el.paused) void el.play()
      else el.pause()
    }

    const seek = (e: React.MouseEvent) => {
      const el = audioRef.current
      const track = trackRef.current
      if (!el || !track || duration <= 0) return
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      el.currentTime = ratio * duration
      setTime(el.currentTime)
    }

    const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0

    return (
      <div className="pdeck">
        <audio ref={audioRef} src={src} preload="metadata" />
        <div className="pdeck-row">
          <button
            className="pdeck-btn"
            style={playing ? { background: accent, color: '#06130d' } : undefined}
            onClick={toggle}
            aria-label={playing ? '暂停录音' : '播放录音'}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <div
            ref={trackRef}
            className="pdeck-track"
            role="slider"
            aria-label="录音进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            onClick={seek}
          >
            <div className="pdeck-fill" style={{ width: `${pct}%`, background: accent }} />
          </div>
          <span className="pdeck-time">
            {fmt(time)} / {fmt(duration)}
          </span>
        </div>
      </div>
    )
  }
  ```

  注：ResultPage 现有 `ended` 监听（对照播放停止伴奏）与这里的 `ended` 监听互不冲突，各自 addEventListener。

- [ ] **步骤 2：ResultPage.tsx 换用 PlaybackDeck**

  - 加 `import PlaybackDeck from '../components/PlaybackDeck'`
  - playback-card 内 `<audio ref={audioRef} src={take.audioUrl} controls preload="metadata" />` 替换为：
    ```tsx
    <PlaybackDeck src={take.audioUrl} accent={song.accent} audioRef={audioRef} />
    ```
  - 原 `toggleSyncPlay` 里 `el.currentTime = startSec` / `el.play()` / `el.pause()` 逻辑不变（仍是同一 `<audio>` 元素）。注意：对照播放期间组件的 `timeupdate` 监听会把进度条推进到 startSec 起的实际位置，属期望行为。

- [ ] **步骤 3：ResultPage.css 增加 pdeck 样式（与 stats-card 同 token）**

  ```css
  .pdeck-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .pdeck-btn {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.05);
    color: var(--ink);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .pdeck-btn:hover {
    border-color: var(--ink-dim);
  }
  .pdeck-track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
  .pdeck-track:hover {
    background: rgba(255, 255, 255, 0.14);
  }
  .pdeck-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 3px;
  }
  .pdeck-time {
    flex: none;
    font-size: 12px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    min-width: 84px;
    text-align: right;
  }
  ```

  同时删旧 `.playback-card audio` 规则（第 82-87 行）。

- [ ] **步骤 4：验证 + Commit**

  运行：`cd app && npx tsc -b && npx vitest run && npx oxlint`
  预期：全绿（组件无单测基建，目测放任务 7）。

  ```bash
  git add app/src/components/PlaybackDeck.tsx app/src/views/ResultPage.tsx app/src/views/ResultPage.css
  git commit -m "feat: 回放页录音卡自绘播放控件（播放按钮+可点进度条+时间），替换原生 audio controls"
  ```

---

### 任务 5：文案改 REPLAY + 音准统计口径小字（含 scoreAgainst 核实）

**核实结论（已人工审阅 `app/src/pitch/compare.ts:90-130`）：** ONSET_SKIP=0.15/OFFSET_SKIP=0.1 窗口内缩、窗口内取中位频率（抗离群帧）、`cents = 1200·log2(measured/target)`、±50 音分判准、`noteCount` 只计有实测样本的音符、`inTuneRatio` 分母为 measured（miss 不进分母，避免虚低）——逻辑无误。补充窗口边界单测固化该口径。

**文件：**
- 修改：`app/src/views/ResultPage.tsx`（kicker 第 198 行、stats-card 内）、`app/src/views/ResultPage.css`、`app/src/pitch/compare.test.ts`

- [ ] **步骤 1：编写失败的测试（窗口内缩）**

  在 `compare.test.ts` 的 `describe('scoreAgainst')` 内追加：

  ```ts
  it('评分窗口掐头 15% 去尾 10%：起音/收尾段帧不进中位数', () => {
    // 音符 0-1s：窗口应为 [0.15, 0.9)。给掐头区 0.05s、去尾区 0.95s 各一个 880Hz 干扰点，
    // 窗口中段 0.4s/0.6s 两个 440Hz 点 -> 中位数必须是 440
    const track = [
      { time: 0.05, hz: 880, cents: 0 },
      { time: 0.4, hz: 440, cents: 0 },
      { time: 0.6, hz: 440, cents: 0 },
      { time: 0.95, hz: 880, cents: 0 },
    ]
    const r = scoreAgainst(track, timeline)
    expect(r.notes[0].measuredHz).toBe(440)
    expect(r.notes[0].inTune).toBe(true)
  })

  it('全部帧落在跳过区 -> 该音符 miss，且不进统计分母', () => {
    const track = [
      { time: 1.05, hz: 440, cents: 0 }, // 音符2(1-2s) 的掐头区内（<1.15）
      { time: 2.85, hz: 440, cents: 0 }, // 音符3(2-3s) 的去尾区外（≥2.9）
    ]
    const r = scoreAgainst(track, timeline)
    expect(r.notes[1].measuredHz).toBeNull()
    expect(r.stats.noteCount).toBe(0)
    expect(r.stats.inTuneRatio).toBe(0)
  })
  ```

- [ ] **步骤 2：运行验证**

  运行：`cd app && npx vitest run src/pitch/compare.test.ts`
  预期：第一条若实现有误会失败；当前实现应直接 PASS（这是固化口径的回归测试）。

- [ ] **步骤 3：改文案与口径小字**

  - ResultPage.tsx 第 198 行：`<div className="kicker">演奏回放 · TAKE</div>` → `<div className="kicker">演奏回放 · REPLAY</div>`
  - stats-card 的 `stats-grid` 后（`analysis.status === 'done' && stats` 块内末尾）追加：
    ```tsx
    <p className="stats-note">
      口径：录音逐帧 YIN 测音 vs 谱面目标音，±50 音分内计准；每个音符掐头 15%、去尾 10% 后取中位频率；无实测帧的音符记漏、不计入分母。
    </p>
    ```

- [ ] **步骤 4：stats-note 样式**

  ResultPage.css（`.stat span` 规则后）：

  ```css
  .stats-note {
    margin-top: 12px;
    font-size: 11px;
    line-height: 1.6;
    color: var(--ink-faint);
  }
  ```

- [ ] **步骤 5：验证 + Commit**

  运行：`cd app && npx vitest run src/pitch/compare.test.ts && npx tsc -b`

  ```bash
  git add app/src/views/ResultPage.tsx app/src/views/ResultPage.css app/src/pitch/compare.test.ts
  git commit -m "feat: 回放文案 TAKE→REPLAY + 音准统计口径说明小字；补 scoreAgainst 窗口边界回归测试"
  ```

---

### 任务 6：topbar 统一（白 logo + Syrinx / back-ghost 返回按钮）

**文件：**
- 修改：`app/src/views/ResultPage.tsx:188-195`（topbar）、`app/src/views/ResultPage.css`

- [ ] **步骤 1：ResultPage.tsx 改 topbar**

  加 `import { assetUrl } from '../lib/assetUrl'`，header 改为：

  ```tsx
  <header className="result-topbar">
    <button className="back-ghost" onClick={() => go('home')} aria-label="返回曲库">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d="M10 3 5 8l5 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
    <div className="logo">
      <img src={assetUrl('/brand/syrinx-logo-white.jpg')} alt="" aria-hidden="true" />
      Syrinx
    </div>
  </header>
  ```

- [ ] **步骤 2：ResultPage.css 更新 topbar 样式**

  `.result-topbar .logo` 规则改为（对齐 PreviewPage.css:100-116）：

  ```css
  .result-topbar .logo {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-family: var(--serif);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--ink);
  }
  .result-topbar .logo img {
    width: 30px;
    height: 30px;
    border-radius: var(--circ);
    border: 1px solid var(--line-strong);
  }
  ```

  新增 back-ghost（`--pill/--line-strong` 全局 token 已存在于 index.css）：

  ```css
  .result-topbar .back-ghost {
    flex: none;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line-strong);
    border-radius: var(--pill);
    background: rgba(11, 12, 12, 0.32);
    color: var(--ink);
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .result-topbar .back-ghost:hover {
    border-color: var(--ink-dim);
    background: rgba(11, 12, 12, 0.5);
  }
  ```

  （旧 `back-pill` 类无任何 CSS 定义，TSX 里替换类名后即彻底消失，无需删样式。）

- [ ] **步骤 3：验证 + Commit**

  运行：`cd app && npx tsc -b && npx oxlint`

  ```bash
  git add app/src/views/ResultPage.tsx app/src/views/ResultPage.css
  git commit -m "feat: 回放页 topbar 统一为白 logo+Syrinx 与 back-ghost 返回按钮"
  ```

---

### 任务 7：全量验收

- [ ] **步骤 1：自动验证**

  ```bash
  cd app
  npx vitest run        # 预期：全绿（含新增 wav.test.ts 与 compare 新增用例）
  npx oxlint            # 预期：无新告警
  npm run build         # 预期：tsc -b + vite build 成功
  ```

  命令被权限拒绝时，原样列出交用户手跑，报告中注明。

- [ ] **步骤 2：手动过 8 项（npm run dev）**

  1. 录一段 → 回放页双击图表下载 → 本地播放器播放**有声音**（必要时 ffprobe 验证 wav 头）
  2. 回放页无「试奏反馈」区块
  3. 演奏页录音按钮为麦克风图标，开启后红色呼吸 + REC
  4. 回放卡为自绘控件：播放/暂停、点进度条 seek、时间显示正确；与右侧统计卡风格对称
  5. kicker 显示「演奏回放 · REPLAY」
  6. 统计卡下方有口径小字
  7. 左上角为白 logo 图 + Syrinx
  8. 返回按钮为 ghost 圆形 SVG 箭头，aria-label=返回曲库，点击回曲库

- [ ] **步骤 3：最终报告**

  逐项写修复方式 + 验证证据；commit 不 push。

---

## 自检

- **规格覆盖度：** 8 项问题 ↔ 任务 1（问题1）、任务 2（问题2）、任务 3（问题3）、任务 4（问题4）、任务 5（问题5+6 含核实与测试）、任务 6（问题7+8）、任务 7（验收）。无遗漏。
- **占位符扫描：** 无 TODO/待定；所有代码步骤均给出完整代码。
- **类型一致性：** `encodeWav(buffer: WavBuffer)` 与 ResultPage 传入的 `audioEngine.decode` 返回值（AudioBuffer 满足鸭子类型：sampleRate/numberOfChannels/length/getChannelData）兼容；`PlaybackDeck` 的 `audioRef: RefObject<HTMLAudioElement | null>` 与 ResultPage 现有 `useRef<HTMLAudioElement>(null)`（React 19 返回 RefObject<HTMLAudioElement | null>）一致；`fmt` 在 PlaybackDeck 内重复定义（ResultPage 也在用，两处小函数，不强求抽取）。

# 演奏页「倒计时中点击小节反复重启倒数」修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.（用户已钦定 inline 执行，不派 subagent。）

**Goal:** 倒计时中被谱面点击打断时，立即取消倒数、定位到点击小节并落入暂停态，绝不自动重启倒数；等用户按播放才重新倒数。

**Architecture:** 全部改动收敛在 `PerformPage.tsx` 的 `seekTo` 事务与 `toggle` 恢复分支：给 `seekTo` 增加 `interruptCountdown` 参数（仅 `onMeasureSelect` 谱面点击传 true），打断时 initial 倒数回 ready、续录倒数落 performing 暂停态并记 `pendingReplayCountInRef`；`toggle` 的 resume 分支消费该 ref 改走 `beginCountIn(target, false)`。BPM 变速 / 重启按钮 / 进度轨不传该参数，维持「自动按新速度重排倒数」现状。

**Tech Stack:** React 19 + Zustand、vitest 4（happy-dom + mock audioEngine）、Playwright（chromium-1228，python sync API）、Vite 8 / tsc 6。

**Spec:** `D:/LLM_work/countdown-reclick/task-brief.md`（复现铁证、根因链、钦定状态机、12 条单测 + 4 条活体验收）。

## Global Constraints

- dev-only：只在 `dev` 分支干活，严禁动 master/web-deploy；只 `git add` 自己改的文件（`../designs/` 不动）。
- **不要**改 `PerformPage.css` 的 `.perform-overlay.countdown { pointer-events: none }`；**不要**动 `src/score/measure-tap.ts` 的 `bindMeasureTap`。
- toast 文案复用现有口径，一字不改：`已定位，播放时从这里继续`。
- BPM 变速在倒数中的语义保持「自动按新速度重启倒数」（与谱面点击的「等播放」不同，测试注释写明）。
- 播放中点小节、ready 态点小节、暂停态点小节全部保持现状。
- 验证命令带 `NODE_OPTIONS=--max-old-space-size=8192`（防 vitest 堆爆）。dev server 5175 已在跑。
- 收尾三行报告（提交 hash + 测试构建状态 + verify 结果）；直接执行不反问。

---

### Task 0: 基线确认

**Files:** 无改动。

- [ ] **Step 0.1** `git branch --show-current` → 必须 `dev`（会话开头已确认，执行时再核一次）。
- [ ] **Step 0.2** `$env:NODE_OPTIONS='--max-old-space-size=8192'; npx vitest run src/views/PerformPage.test.ts` → 全绿基线。
- [ ] **Step 0.3** `npx tsc --noEmit -p tsconfig.app.json` → 零错（tsconfig.app.json 本身 noEmit:true，tsc -b 由 build 覆盖）。

### Task 1: 新行为单测（先红）

**Files:**
- Modify: `src/views/PerformPage.test.ts`（describe `演奏录音会话` 内）

**Interfaces:**
- Consumes: 现有 mock（`mocked.engine`、`makeMic`、`beginPerformance`、`flushRaf`、`mountPerformPage`）、mock ScoreSheet 的 `[aria-label="选择第N小节"]` 按钮。
- Produces: 两条用例名（后续 Task 4 全量跑时必须绿）：
  - `initial 倒数中点小节：立即取消倒数、定位并回到就绪浮层，绝不自动重启`
  - `续录倒数中点小节：打断落暂停态，按播放先倒数再从定位点续录（不再自动重启）`

- [ ] **Step 1.1** 把现有用例 `倒数期间再次点选会取消旧跳转，只有最后目标恢复播放`（L876-892）**整段替换**为下面两条（注意：旧用例断言 `play(0.1)` 自动恢复，正是要废除的行为；相邻的 `第一次封段仍在等待时重复点选…`（L894）**保持原样不动**——它锁定的是 performing 过渡中的点选，不属本 bug 范围）：

```ts
  it('initial 倒数中点小节：立即取消倒数、定位并回到就绪浮层，绝不自动重启', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()
    mocked.engine.seek.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())

    expect(container.querySelector('.perform-overlay.countdown')).toBeNull()
    expect(container.querySelector('.ov-start')).not.toBeNull()
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已定位，播放时从这里继续')

    // 旧倒数线程已死：时间推进也不会突然起奏
    mocked.engine.ctxTime = 10
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(container.querySelector('.ov-start')).not.toBeNull()
  })

  it('续录倒数中点小节：打断落暂停态，按播放先倒数再从定位点续录（不再自动重启）', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    mocked.engine.play.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()
    mocked.engine.seek.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第1小节"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="播放"]')).not.toBeNull()
    expect(mocked.engine.seek).toHaveBeenCalledWith(0.1)
    expect(mocked.engine.playing).toBe(false)
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已定位，播放时从这里继续')

    // 打断后不自动起奏
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).not.toHaveBeenCalled()

    // 用户按播放：beginCountIn(定位点,false)——4 拍倒数、target=定位点，而非直接 play
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    expect(mocked.engine.scheduleTick).toHaveBeenCalledTimes(4)
    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / (120 * 1))
    expect(mocked.engine.play).not.toHaveBeenCalled()

    // 倒数归零后从定位点续录并开新段
    mocked.engine.ctxTime = 30
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.1)
    expect(mocked.engine.playing).toBe(true)
    expect(mic.restartCapture).toHaveBeenCalledTimes(2)
  })
```

- [ ] **Step 1.2** 跑 `$env:NODE_OPTIONS='--max-old-space-size=8192'; npx vitest run src/views/PerformPage.test.ts` → 期望这两条 **FAIL**（当前行为是自动重启倒数），其余全绿。这是 TDD 红灯证据。

### Task 2: PerformPage.tsx 状态机实现（转绿）

**Files:**
- Modify: `src/views/PerformPage.tsx`（5 处，如下）

**Interfaces:**
- Produces: `seekTo(t: number, measure?: number, nextRate?: number, interruptCountdown?: boolean): void`（第 4 参默认 false）；`pendingReplayCountInRef: React.RefObject<number | null>`（模块内私有）。

- [ ] **Step 2.1** L108 `transitionShouldResumeRef` 声明后新增 ref：

```ts
  const transitionShouldResumeRef = useRef(false)
  /** 续录倒数被谱面点击打断后的「等播放重倒数」目标（秒）；null = 无待续 */
  const pendingReplayCountInRef = useRef<number | null>(null)
```

- [ ] **Step 2.2** `toggle`（L734 `} else if (!resumePendingRef.current) {` 分支开头）插入 pendingReplay 消费逻辑：

```ts
    } else if (!resumePendingRef.current) {
      const pendingReplay = pendingReplayCountInRef.current
      if (pendingReplay !== null) {
        // 续录倒数被谱面点击打断（用户钦定）：按播放 = 先倒数再续录，不直接续播
        pendingReplayCountInRef.current = null
        beginCountIn(pendingReplay, false)
        wake()
        return
      }
      resumePendingRef.current = true
```

并把 `toggle` 的依赖数组 `[claimPlayOperation, pauseOwnedPlay, playOperationIsCurrent, resumeCapture, showToast, start, startCapture, wake]` 补上 `beginCountIn`（按字母序插到最前）。

- [ ] **Step 2.3** `finish()`（L360 `transitionShouldResumeRef.current = false` 之后）加一行 `pendingReplayCountInRef.current = null`；卸载清理 effect（L452-453 `startPendingRef.current = false` 一带）同样加 `pendingReplayCountInRef.current = null`。

- [ ] **Step 2.4** 改 `seekTo`。签名、注释与头部计算（替换 L831-852）：

```ts
  /** 单次跳转事务：播放中先封段，再定位、倒数并续录；暂停/就绪只定位。
   *  interruptCountdown：倒数的「谱面点击」打断——立即停倒数并落暂停态（initial
   *  回 ready、续录记 pendingReplay 等播放重倒数），绝不自动重启；BPM 变速/重启
   *  按钮不传此参，保持按新速度自动重排倒数。 */
  const seekTo = useCallback((t: number, measure?: number, nextRate?: number, interruptCountdown = false) => {
      const currentPhase = phaseRef.current
      if (!['ready', 'performing', 'countdown'].includes(currentPhase)) return
      const tl = timelineRef.current
      if (!tl) return
      if (nextRate !== undefined) requestedRateRef.current = nextRate
      const prepareRate = nextRate !== undefined || tempoPendingRef.current
      const desiredRate = requestedRateRef.current
      const clamped = Math.max(0, Math.min(t, tl.durationSec))
      if (currentPhase === 'ready' && !prepareRate) {
        positionTransport(clamped, measure)
        playingRef.current = false
        setPlaying(false)
        wake()
        return
      }
      const interruptedCountdown = currentPhase === 'countdown' && interruptCountdown
      const countdownWasInitial = countdownRef.current.initial
      const resumeAfter = interruptedCountdown
        ? false
        : audioEngine.playing
          || (currentPhase === 'countdown' && !countdownWasInitial)
          || transitionShouldResumeRef.current
      const initialCountdown = currentPhase === 'countdown' && countdownWasInitial && !interruptCountdown
      transitionShouldResumeRef.current = resumeAfter
```

（其后 `captureGenerationRef.current += 1` 到 `setTempoPending(true)` 一段原样保留。）

异步尾部分派（替换 L895-906 的 `positionTransport` 之后三支为四支）：

```ts
        if (!mountedRef.current || finishedRef.current || generation !== transitionGenerationRef.current) return
        positionTransport(clamped, measure)
        if (currentPhase === 'ready') {
          phaseRef.current = 'ready'
          setPhase('ready')
        } else if (interruptedCountdown) {
          // 倒数被谱面点击打断（钦定）：不再自动 beginCountIn——initial 回 ready
          // 等用户重新起奏；续录落 performing 暂停态并记 pendingReplay，按播放才倒数
          transitionShouldResumeRef.current = false
          if (countdownWasInitial) {
            phaseRef.current = 'ready'
            setPhase('ready')
          } else {
            pendingReplayCountInRef.current = clamped
            phaseRef.current = 'performing'
            setPhase('performing')
          }
          showToast('已定位，播放时从这里继续')
        } else if (resumeAfter || initialCountdown) beginCountIn(clamped, initialCountdown)
        else {
          transitionShouldResumeRef.current = false
          phaseRef.current = 'performing'
          setPhase('performing')
          // 待重倒数的暂停态下再点小节：只更新待倒数目标，保持「等播放」语义
          if (pendingReplayCountInRef.current !== null) pendingReplayCountInRef.current = clamped
          showToast('已定位，播放时从这里继续')
        }
        wake()
```

- [ ] **Step 2.5** L1147 谱面点击入口传第 4 参：

```ts
            onMeasureSelect={(measure, time) => seekTo(time, measure, undefined, true)}
```

- [ ] **Step 2.6** `npx tsc --noEmit -p tsconfig.app.json` 零错；`$env:NODE_OPTIONS='--max-old-space-size=8192'; npx vitest run src/views/PerformPage.test.ts` → **全绿**（Task 1 两条转绿 + 既有全部不破）。若 `第一次封段仍在等待时重复点选…`（L894）变红，说明误伤了 performing 过渡路径——回查 Step 2.4 的 else 分支。

### Task 3: BPM / 进度轨特征锁定测试（对既有逻辑的补测，应直接绿）

**Files:**
- Modify: `src/views/PerformPage.test.ts`

**Interfaces:**
- Consumes: Task 2 的实现（行为锁定，非新功能）。BPM 面板流程与既有用例一致：`[aria-label="调整演奏速度"]` → `[aria-label="降低 BPM"]` → `.tempo-apply`（每次 apply 后面板关闭，重复点开）。

- [ ] **Step 3.1** 在 describe `演奏页伴奏音量初值（t_5957a725）` 末尾（`进度滑杆在定位和播放帧中同步暴露真实时间值` 用例之前）加 6 条 BPM 用例：

```ts
  it('就绪态改 BPM 后起奏：倒数节拍按 60/(tempo×rate) 缩放', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    expect(container.querySelector('.ov-start')).not.toBeNull()

    mocked.engine.scheduleTick.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks).toHaveLength(4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
  })

  // 【BPM 语义与谱面点击不同】BPM 是显式速度操作：倒数中改速 = 取消旧倒数、
  // 按新速度「自动」重排倒数（谱面点击才落暂停等播放）——本条与下条锁定该差异。
  it('initial 倒数中改 BPM：取消旧倒数并按新速度自动重排倒数', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())

    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks).toHaveLength(4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledOnce()
    expect(mocked.engine.playing).toBe(true)
  })

  it('续录倒数中改 BPM：按新速度自动重排倒数并从定位点续录', async () => {
    const mic = makeMic()
    mocked.openMic.mockResolvedValue(mic)
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.time = 0.25
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择第2小节"]')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.play.mockClear()
    mocked.engine.scheduleTick.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())

    const ticks = mocked.engine.scheduleTick.mock.calls
    expect(ticks).toHaveLength(4)
    expect(ticks[1]![0] - ticks[0]![0]).toBeCloseTo(60 / 119)
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()

    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.play).toHaveBeenCalledWith(0.5)
    expect(mocked.engine.playing).toBe(true)
  })

  it('tempoPending 中播放/暂停按钮无响应，setRate 完成后恢复', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    let prepared!: (value: boolean) => void
    mocked.engine.setRate.mockReturnValueOnce(new Promise<boolean>((resolve) => { prepared = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())

    mocked.engine.play.mockClear()
    mocked.engine.pause.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(mocked.engine.play).not.toHaveBeenCalled()
    expect(mocked.engine.pause).not.toHaveBeenCalled()

    await act(async () => prepared(true))
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="暂停"]')!.click())
    expect(mocked.engine.playing).toBe(false)
  })

  it('setRate 失败（保调变速不支持）：回 performing 暂停态并提示「未能继续」', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    mocked.engine.setRate.mockResolvedValueOnce(false)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())

    expect(container.textContent).toContain('未能继续')
    expect(container.querySelector('.perform-overlay.countdown')).toBeNull()
    mocked.engine.play.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="播放"]')!.click())
    expect(mocked.engine.play).toHaveBeenCalled()
  })

  it('连续三次快速改 BPM：只有最新 rate 回写并倒数，迟到的旧事务不回写不重启', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await beginPerformance(container)
    let resolveOld!: (value: boolean) => void
    mocked.engine.setRate.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveOld = resolve }))
    const applyNext = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="降低 BPM"]')!.click())
      await act(async () => document.querySelector<HTMLButtonElement>('.tempo-apply')!.click())
    }
    await applyNext() // 119：setRate 挂起
    await applyNext() // 118：立即成功但 generation 已被第三次作废
    await applyNext() // 117：最新事务

    expect(mocked.engine.rate).toBeCloseTo(117 / 120)
    mocked.engine.ctxTime = 20
    await flushRaf()
    expect(mocked.engine.playing).toBe(true)
    const ticksAfterApply = mocked.engine.scheduleTick.mock.calls.length

    await act(async () => resolveOld(true)) // 迟到的 119 事务：不得回写/重启
    expect(mocked.engine.rate).toBeCloseTo(117 / 120)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="调整演奏速度"]')!.textContent).toContain('117')
    expect(mocked.engine.playing).toBe(true)
    expect(mocked.engine.scheduleTick.mock.calls.length).toBe(ticksAfterApply)
  })
```

- [ ] **Step 3.2** 在 describe `演奏录音会话` 的 `进度拖动只在 pointer-up 提交一次跳转`（L833）之后加倒数中进度轨用例：

```ts
  it('倒数中拖动进度轨无效：不定位也不重启倒数', async () => {
    await mountPerformPage(1)
    const container = containers.at(-1)!
    await act(async () => container.querySelector<HTMLButtonElement>('.ov-start')!.click())
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
    const rail = container.querySelector<HTMLElement>('.progress-rail')!
    Object.defineProperty(rail, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON() {} }),
    })
    mocked.engine.seek.mockClear()
    mocked.engine.scheduleTick.mockClear()
    await act(async () => rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 80 })))
    await act(async () => rail.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientX: 80 })))
    expect(mocked.engine.seek).not.toHaveBeenCalled()
    expect(mocked.engine.scheduleTick).not.toHaveBeenCalled()
    expect(container.querySelector('.perform-overlay.countdown')).not.toBeNull()
  })
```

- [ ] **Step 3.3** `$env:NODE_OPTIONS='--max-old-space-size=8192'; npx vitest run src/views/PerformPage.test.ts` → 全绿。任何一条红：先判断是「实现破坏了既有行为」（改实现）还是「用例前提写错」（修用例），不许为绿而绿注释断言。

### Task 4: 全量验证（tsc + vitest + build）

- [ ] **Step 4.1** `npx tsc --noEmit -p tsconfig.app.json` → 零错。
- [ ] **Step 4.2** `$env:NODE_OPTIONS='--max-old-space-size=8192'; npm test` → 全绿（基线 263+ 用例 + 新增 9 条）。
- [ ] **Step 4.3** `$env:NODE_OPTIONS='--max-old-space-size=8192'; npm run build` → 绿。

### Task 5: Playwright 活体验证（verify 模式）

**Files:**
- Create: `D:/LLM_work/countdown-reclick/verify_countdown_fix.py`（仓库外，不提交）
- Create: `D:/LLM_work/countdown-reclick/verify_countdown_fix_output.txt`（运行输出存档）

- [ ] **Step 5.1** 写脚本（完整内容如下，参照 repro_countdown_reclick.py 改造；≥16 断言；chromium-1228 固定路径；端口参数化默认 5175）：

```python
# -*- coding: utf-8 -*-
"""验证（verify 模式）：倒计时中点击小节不再重启倒数，而是停止倒数并暂停定位。
S1 initial 倒数中点小节：数字不跳回4、浮层消失、toast、ov-start 重现；再按播放 → 4→3→2→1 重新倒数起奏推进
S2 initial 倒数中连点 3 次：全程零重启，最终停在选择处，播放可正常续
S3 回归：播放中点小节仍自动倒数续录；倒数中再点另一处 → 落暂停+toast；按播放 → 重新倒数并续奏
全程 pageerror 为空。启动参数：python verify_countdown_fix.py <port>
"""
import sys
from playwright.sync_api import sync_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "5175"
URL = f"http://localhost:{PORT}"
CHROME = r"C:/Users/54219/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe"
RESULTS = []

def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))

def install_traj(page):
    page.evaluate("""() => {
      window.__countTraj = [];
      const sample = () => {
        const el = document.querySelector('.count-num');
        if (el) window.__countTraj.push({t: performance.now(), n: el.textContent.trim()});
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }""")

def traj_changes(page):
    traj = page.evaluate("() => window.__countTraj")
    seq = []
    for item in traj:
        if not seq or seq[-1]["n"] != item["n"]:
            seq.append(item)
    return seq

def restarts(seq):
    nums = [int(s["n"]) for s in seq if s["n"].isdigit()]
    return sum(1 for i in range(1, len(nums)) if nums[i] > nums[i - 1])

def tap(page, box, fx, fy, pid):
    x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
    page.evaluate("""([x, y, pid]) => {
      const el = document.elementFromPoint(x, y);
      const opts = {bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, button: 0, buttons: 1};
      el.dispatchEvent(new PointerEvent('pointerdown', {clientX:x, clientY:y, ...opts}));
      el.dispatchEvent(new PointerEvent('pointerup', {clientX:x, clientY:y, ...opts}));
    }""", [x, y, pid])

def enter_performance(ctx):
    page = ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector(".intro-enter", timeout=15000)
    page.evaluate("document.querySelector('.intro-enter').click()")
    page.wait_for_selector(".song-card", timeout=15000)
    page.locator(".song-card").first.click()
    page.wait_for_selector(".btn-play-big", timeout=20000)
    page.evaluate("document.querySelector('.btn-play-big').click()")
    page.wait_for_selector(".ov-start", timeout=30000)
    return page

def start_countdown(page):
    page.evaluate("document.querySelector('.ov-start').click()")
    page.wait_for_selector(".perform-overlay.countdown", timeout=10000)
    page.wait_for_function(
        "() => { const el = document.querySelector('.count-num'); return el && parseInt(el.textContent) <= 3 }",
        timeout=10000)

def hud_time(page):
    return page.evaluate("() => [...document.querySelectorAll('.hud-stat .num')][1]?.textContent || ''")

def wait_playing_advance(page):
    page.wait_for_selector(".perform-overlay.countdown", state="detached", timeout=15000)
    t1 = hud_time(page)
    page.wait_for_timeout(900)
    t2 = hud_time(page)
    return t1 != t2 and t2 != ""

def run_scenario_s1(ctx, errors):
    print("--- S1: initial 倒数中点小节 ---")
    page = enter_performance(ctx)
    page.on("pageerror", lambda e: errors.append(f"S1: {e}"))
    install_traj(page)
    start_countdown(page)
    box = page.locator(".sheet-container").bounding_box()
    tap(page, box, 0.30, 0.35, 7)
    page.wait_for_timeout(1500)
    seq = traj_changes(page)
    check("S1.1 倒数数字不再跳回 4（无重启）", restarts(seq) == 0, f"traj={[s['n'] for s in seq[-8:]]}")
    check("S1.2 倒数浮层消失", page.locator(".perform-overlay.countdown").count() == 0)
    check("S1.3 toast 已定位", "已定位" in (page.locator(".perform-toast").text_content() or ""))
    check("S1.4 回到就绪浮层 .ov-start", page.locator(".ov-start").count() == 1)
    page.evaluate("document.querySelector('.ov-start').click()")
    page.wait_for_selector(".perform-overlay.countdown", timeout=10000)
    check("S1.5 按播放重新倒数（浮层重现）", True)
    check("S1.6 重新倒数后进入演奏并推进", wait_playing_advance(page), f"hud={hud_time(page)}")
    page.close()

def run_scenario_s2(ctx, errors):
    print("--- S2: 倒数中连点 3 次 ---")
    page = enter_performance(ctx)
    page.on("pageerror", lambda e: errors.append(f"S2: {e}"))
    install_traj(page)
    start_countdown(page)
    box = page.locator(".sheet-container").bounding_box()
    for i in range(3):
        tap(page, box, 0.30 + 0.15 * i, 0.35 + 0.075 * i, 9 + i)
        page.wait_for_timeout(600)
    page.wait_for_timeout(2000)
    seq = traj_changes(page)
    check("S2.1 连点 3 次全程零倒数重启", restarts(seq) == 0, f"restarts={restarts(seq)}")
    check("S2.2 最终无倒数浮层（停在选择处）", page.locator(".perform-overlay.countdown").count() == 0)
    btn = page.locator(".ov-start")
    if btn.count() == 1:
        page.evaluate("document.querySelector('.ov-start').click()")
    else:
        page.evaluate("document.querySelector('[aria-label=\"播放\"]').click()")
    page.wait_for_selector(".perform-overlay.countdown", timeout=10000)
    check("S2.3 播放可正常续：重新倒数", True)
    check("S2.4 倒数后进入演奏推进", wait_playing_advance(page), f"hud={hud_time(page)}")
    page.close()

def run_scenario_s3(ctx, errors):
    print("--- S3: 回归 + 续录倒数打断 ---")
    page = enter_performance(ctx)
    page.on("pageerror", lambda e: errors.append(f"S3: {e}"))
    install_traj(page)
    page.evaluate("document.querySelector('.ov-start').click()")
    check("S3.1 起奏后正常进入演奏推进", wait_playing_advance(page), f"hud={hud_time(page)}")
    box = page.locator(".sheet-container").bounding_box()
    tap(page, box, 0.30, 0.35, 11)
    page.wait_for_selector(".perform-overlay.countdown", timeout=5000)
    check("S3.2 回归：播放中点小节仍自动倒数续录", True)
    check("S3.3 自动倒数后续奏推进", wait_playing_advance(page), f"hud={hud_time(page)}")
    tap(page, box, 0.45, 0.4, 12)
    page.wait_for_selector(".perform-overlay.countdown", timeout=5000)
    page.wait_for_function(
        "() => { const el = document.querySelector('.count-num'); return el && parseInt(el.textContent) <= 3 }",
        timeout=10000)
    install_traj(page)
    tap(page, box, 0.65, 0.45, 13)
    page.wait_for_timeout(1500)
    seq = traj_changes(page)
    check("S3.4 续录倒数中点小节：数字不重启", restarts(seq) == 0, f"traj={[s['n'] for s in seq[-8:]]}")
    check("S3.5 倒数浮层消失（停止）", page.locator(".perform-overlay.countdown").count() == 0)
    check("S3.6 落暂停态（底栏呈播放键）", page.locator('[aria-label="播放"]').count() == 1)
    check("S3.7 toast 已定位", "已定位" in (page.locator(".perform-toast").text_content() or ""))
    page.evaluate("document.querySelector('[aria-label=\"播放\"]').click()")
    page.wait_for_selector(".perform-overlay.countdown", timeout=10000)
    check("S3.8 按播放重新倒数", True)
    check("S3.9 重新倒数后续奏推进", wait_playing_advance(page), f"hud={hud_time(page)}")
    page.close()

def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=["--autoplay-policy=no-user-gesture-required",
                  "--use-fake-ui-for-media-stream",
                  "--use-fake-device-for-media-stream"])
        ctx = browser.new_context(permissions=["microphone"], viewport={"width": 1440, "height": 900})
        run_scenario_s1(ctx, errors)
        run_scenario_s2(ctx, errors)
        run_scenario_s3(ctx, errors)
        browser.close()
    check("S4 全程 pageerror 为空", len(errors) == 0, f"errors={errors}")
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n=== VERIFY: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS ===")
    if failed:
        for name, _, detail in failed:
            print(f"  FAILED: {name} {detail}")
        sys.exit(1)

main()
```

- [ ] **Step 5.2** 确认 dev server 5175 活着：`Invoke-WebRequest http://localhost:5175 -UseBasicParsing`（挂了再自查换端口并在报告注明）。
- [ ] **Step 5.3** `python D:/LLM_work/countdown-reclick/verify_countdown_fix.py 5175 *> D:/LLM_work/countdown-reclick/verify_countdown_fix_output.txt` 然后读输出 → 必须 `21/21 PASS`（≥16 即验收，脚本共 21 条断言）。任何 FAIL：回实现排查，修完重跑。

### Task 6: 提交

- [ ] **Step 6.1** `git status` 复核：只应有 `src/views/PerformPage.tsx`、`src/views/PerformPage.test.ts`、本计划文档三处变更（`../designs/` 不动）。
- [ ] **Step 6.2** 逐文件 add 并提交：

```bash
git add src/views/PerformPage.tsx src/views/PerformPage.test.ts docs/superpowers/plans/2026-09-14-countdown-reclick-fix.md
git commit -m "fix(perform): 倒计时中点击小节改为停止倒数并暂停定位，不再自动重启"
```

- [ ] **Step 6.3** 三行收尾报告：提交 hash + 测试构建状态 + verify 结果。

---

## Self-Review（已执行）

- **Spec 覆盖**：钦定方案 4 条子规则 → Task 2（interruptedCountdown 四支分派 + toggle pendingReplay + onMeasureSelect 传参）；12 条单测 → Task 1（#1、#2，#2 兼收旧 L876 重写）、既有绿（#3=L809、#4=L773、#6=L364/L336、#11=L790/L972）、Task 3（#5、#7a/7b、#8、#9、#10、#12）；活体 13-16 → Task 5（S1/S2/S3 + pageerror）。BPM 倒数中自动重启语义（#7）由「interruptCountdown 仅 onMeasureSelect 传 true」结构性保证，测试注释已写明差异。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`seekTo` 第 4 参 boolean 默认 false，唯一 true 调用点在 onMeasureSelect；`pendingReplayCountInRef` 为 `number | null`，写入点（interrupted 分支/else 更新）与读取清理点（toggle/finish/unmount）类型一致。

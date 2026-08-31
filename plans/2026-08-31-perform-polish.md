# 演奏页交互与谱面优化 实现计划（看板卡 t_53aa8b7a）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除点谱面小节跳转、新增「停止演奏」按钮（含回放页截断口径）、谱面容器限宽缩窄（打印乐谱疏朗感）。

**架构：** 三个需求相互独立、按序提交。停止功能的语义核心是复用 PerformPage 既有 `finish()`（它已经原地 pause、以 `audioEngine.time` 封存 `durationSec`、进 ended 界面），新增的只有 ControlBar 按钮接线与回放页两处适配：统计用纯函数 `timelineUpTo` 截断时间轴、对照播放用 rAF 守卫把伴奏停在停止时刻。谱面缩窄用 CSS `max-width` 居中 + OSMD `Zoom` 放大音符。

**技术栈：** React 18 + TypeScript + Vite + vitest（happy-dom）+ opensheetmusicdisplay。

**验证命令**（每个任务收尾跑）：`cd app && npx vitest run`、`cd app && npm run build`、`cd app && npx oxlint`。铁律：开发期严禁 electron-builder / dist / dist:portable。

**关键口径决策（已勘察代码后确定）：**
- `Take.durationSec` 语义 = 封存时 `audioEngine.time` 的**绝对**伴奏时间轴位置（`finish()` 现状即如此，自然结束时 ≈ buffer.duration）。因此回放页的「停止时刻」直接取 `take.durationSec`，**不是**任务书字面的 `startSec + durationSec`——后者只在 startSec=0（绝大多数场景）时才等于前者；startSec>0（进度轨 seek 后重录再停止）时字面公式会把停止点推后 startSec 秒、把未演奏区间算进统计。取 `take.durationSec` 在两种场景下都精确等于点击时刻。此偏差写入最终报告。
- 自然结束路径零改动：`timelineUpTo` 在 `stopSec >= timeline.durationSec` 时返回原引用；对照播放守卫只在 `audioEngine.time >= stopSec` 才触发，自然结束的 stopSec=buffer.duration，与录音 `ended` 事件同时刻，结果不变。

**文件结构：**
- 修改 `app/src/views/PerformPage.tsx`：删 seekToMeasure/onMeasureClick；新增 stop 接线；ScoreSheet 传 zoom。
- 修改 `app/src/components/ScoreSheet.tsx`：删 onMeasureClick prop 与 onClick 分发；新增 zoom prop。
- 修改 `app/src/score/OSMDScore.ts`：删 measureAtPoint；构造器新增 zoom 参数。
- 修改 `app/src/components/ControlBar.tsx` / `ControlBar.css`：停止按钮。
- 修改 `app/src/pitch/compare.ts` + `compare.test.ts`：新增纯函数 `timelineUpTo`（TDD）。
- 修改 `app/src/views/ResultPage.tsx`：两处分析路径截断 + 对照播放截断守卫。
- 修改 `app/src/views/PerformPage.css` / `PreviewPage.css`：sheet-container 限宽居中。
- 新建 `D:/LLM_work/syrinx-perform-polish/cc-report.md`：最终报告。

---

### 任务 1：移除「点谱面小节 → 从该小节演奏」功能

**文件：**
- 修改：`app/src/views/PerformPage.tsx`（删 L446-458 seekToMeasure、L549 onMeasureClick 传参）
- 修改：`app/src/components/ScoreSheet.tsx`（删 onMeasureClick prop 与 onClick 分发）
- 修改：`app/src/score/OSMDScore.ts`（删 L218-256 measureAtPoint；修 noteAtPoint 注释里的引用）

已勘察：`measureAtPoint` 全仓只被 ScoreSheet 的 onClick 调用（SyncTunePage 用的是 noteAtPoint/setMarkers，保留）；「已跳转，本段重新录音」toast 属于进度轨 seekTo 共用文案，**保留**。

- [ ] **步骤 1.1：PerformPage.tsx** 删除 `seekToMeasure` 整个 useCallback 块（含其上方「点谱面小节 -> 从该小节头继续…」注释块），删除 `<ScoreSheet … onMeasureClick={seekToMeasure} />` 一行。注意：`seekTo`（进度轨用）与其依赖数组不受影响。
- [ ] **步骤 1.2：ScoreSheet.tsx** 删除 Props 里的 `onMeasureChange` 下方的 `onMeasureClick` 定义、解构参数里的 `onMeasureClick`，以及根 div 上的整个 `onClick={…}` 属性（div 上再无其他属性需保留 className）。
- [ ] **步骤 1.3：OSMDScore.ts** 删除 `measureAtPoint` 方法（L221-256，含其 doc 注释）；`noteAtPoint` 内注释「y 最近的小节行（与 measureAtPoint 同距离策略）」改为「y 最近的小节行（最近行距离策略）」。
- [ ] **步骤 1.4：全局 grep 确认**：`measureAtPoint|onMeasureClick|seekToMeasure` 在 `app/src` 0 命中。
- [ ] **步骤 1.5：跑验证**：`npx vitest run`（现有 15 个测试文件全绿）、`npm run build`、`npx oxlint`。
- [ ] **步骤 1.6：Commit**（先 `git log --oneline -3` 核对无并发提交，逐文件 add）：
  ```
  git add app/src/views/PerformPage.tsx app/src/components/ScoreSheet.tsx app/src/score/OSMDScore.ts
  git commit -m "refactor: 移除点谱面小节跳转演奏功能（保留进度轨 seek）"
  ```

---

### 任务 2：截断统计纯函数 `timelineUpTo`（TDD）

**文件：**
- 修改：`app/src/pitch/compare.test.ts`（新增 describe）
- 修改：`app/src/pitch/compare.ts`（新增导出函数）

- [ ] **步骤 2.1：先写失败测试**（compare.test.ts 末尾追加，复用文件顶部既有 `timeline` 替身）：

```ts
import { timelineUpTo } from './compare'

describe('timelineUpTo（停止演奏截断口径）', () => {
  it('停止时刻在中段：只保留 time < stopSec 的音符', () => {
    const t = timelineUpTo(timeline, 1.5)
    expect(t.notes.map((n) => n.midi)).toEqual([69, 60])
  })

  it('停止时刻早于首音符：音符清空（不抛异常）', () => {
    const t = timelineUpTo(timeline, 0.5)
    expect(t.notes).toEqual([])
  })

  it('停止时刻不早于全曲时长：返回原引用（自然结束零开销不截断）', () => {
    expect(timelineUpTo(timeline, 3)).toBe(timeline)
    expect(timelineUpTo(timeline, 99)).toBe(timeline)
  })

  it('与 scoreAgainst 组合：截断后第三秒音符不进统计', () => {
    const r = scoreAgainst(extractPitchTrack(makeBuffer()), timelineUpTo(timeline, 2.5))
    expect(r.notes).toHaveLength(2)
    expect(r.stats.noteCount).toBeLessThanOrEqual(2)
  })
})
```

- [ ] **步骤 2.2：运行确认失败**：`npx vitest run src/pitch/compare.test.ts`，预期 FAIL（`timelineUpTo is not a function`）。
- [ ] **步骤 2.3：实现**（compare.ts，`scoreAgainst` 上方）：

```ts
/** 截断时间轴：只保留 time < stopSec 的音符（停止演奏的统计口径，t_53aa8b7a）。
 *  stopSec = Take 封存时的 audioEngine.time（绝对停止时刻）：自然结束 ≈ 全曲时长
 *  （不早于 durationSec 时返回原引用零开销）；停止演奏 = 点击时刻，之后的音符
 *  未被演奏，不进命中率/漏音统计。 */
export function timelineUpTo(timeline: Timeline, stopSec: number): Timeline {
  if (!Number.isFinite(stopSec) || stopSec >= timeline.durationSec) return timeline
  return { ...timeline, notes: timeline.notes.filter((n) => n.time < stopSec) }
}
```

- [ ] **步骤 2.4：运行确认通过**：`npx vitest run src/pitch/compare.test.ts`，预期 PASS。
- [ ] **步骤 2.5：Commit**：
  ```
  git add app/src/pitch/compare.ts app/src/pitch/compare.test.ts
  git commit -m "feat: 音准统计新增停止时刻截断口径 timelineUpTo"
  ```

---

### 任务 3：ControlBar 停止按钮 + PerformPage 接线

**文件：**
- 修改：`app/src/components/ControlBar.tsx`（新增 onStop prop + 按钮）
- 修改：`app/src/components/ControlBar.css`（.ctl.stop 样式）
- 修改：`app/src/views/PerformPage.tsx`（stop 回调，走 finish()）

- [ ] **步骤 3.1：ControlBar.tsx** Props 加 `onStop: () => void` 并解构；在「回开头」按钮之后、音量之前插入：

```tsx
      <button
        className="ctl stop"
        onClick={onStop}
        disabled={ended || !playing}
        aria-label="停止演奏"
        title="停止演奏并进入回放"
      >
        ■
      </button>
```

- [ ] **步骤 3.2：ControlBar.css** 在 `.ctl.main:hover` 块后追加：

```css
/* 停止演奏：方块图标小于文字按钮基线，hover 转警示色提示「收束本段」 */
.ctl.stop {
  font-size: 13px;
}
.ctl.stop:not(:disabled):hover {
  color: var(--rec);
  background: rgba(243, 114, 127, 0.12);
}
```

- [ ] **步骤 3.3：PerformPage.tsx** 在 `restart` 之前加回调并接线（`finish` 已具备全部停止语义：原地 pause 不回 0、durationSec=audioEngine.time、ended 界面）：

```ts
  /** 停止演奏：走与自然结束相同的 finish() 封存流程（伴奏停在点击时刻、
   *  Take.durationSec 截断为该时刻，回放页按截断口径统计与播放） */
  const stop = useCallback(() => {
    if (phaseRef.current !== 'performing') return
    finish()
  }, [finish])
```

`<ControlBar …>` 加 `onStop={stop}`。
- [ ] **步骤 3.4：跑验证**（vitest/build/oxlint）+ 人工核对：空格仍走 toggle 不冲突；停止后 phase='ended' → ControlBar 其它按钮因 ended 全禁用 ✓。
- [ ] **步骤 3.5：Commit**：
  ```
  git add app/src/components/ControlBar.tsx app/src/components/ControlBar.css app/src/views/PerformPage.tsx
  git commit -m "feat: 演奏页控制条新增停止演奏按钮（复用 finish 截断封存语义）"
  ```

---

### 任务 4：回放页适配截断口径

**文件：**
- 修改：`app/src/views/ResultPage.tsx`

- [ ] **步骤 4.1：统计截断**。顶部 import 改为 `import { extractPitchTrack, scoreAgainst, timelineUpTo, type ScoreResult } from '../pitch/compare'`；音高分析 effect 开头（`if (!take) return` 之后）取 `const stopSec = take.durationSec`，两处 `scoreAgainst(…, timeline)` 调用（缓存路径与新鲜路径）都改为 `scoreAgainst(…, timelineUpTo(timeline, stopSec))`，并在 effect 上方加口径注释：

```ts
  // 停止时刻（伴奏时间轴绝对位置）= 封存时 finish() 记录的 audioEngine.time：
  // 自然结束 ≈ 全曲时长（timelineUpTo 原引用直通）；停止演奏 = 点击时刻，
  // 之后的音符未被演奏、不进统计，伴奏对照也只播到这（下方截断守卫）。
```

- [ ] **步骤 4.2：对照播放截断守卫**。在「对照播放」effect 之后新增：

```ts
  // 对照播放截断：伴奏只播到停止时刻（录音 ended 通常同时刻先到，此处兜底
  // 录音时长偏差/静音尾场景；自然结束 stopSec≈buffer 末尾，行为与现状一致）
  useEffect(() => {
    if (!syncPlaying || !take) return
    const stopSec = take.durationSec
    let raf = 0
    const check = () => {
      if (audioEngine.playing && audioEngine.time >= stopSec) {
        audioRef.current?.pause()
        audioEngine.pause()
        setSyncPlaying(false)
        return
      }
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [syncPlaying, take])
```

- [ ] **步骤 4.3：跑验证**（vitest/build/oxlint）。核对自然路径不回归：`timelineUpTo` 原引用直通；守卫触发点 = buffer 末尾 = 录音 ended 时刻。
- [ ] **步骤 4.4：Commit**：
  ```
  git add app/src/views/ResultPage.tsx
  git commit -m "feat: 回放页适配停止截断口径（统计只算已演奏音符、伴奏停在停止时刻）"
  ```

---

### 任务 5：谱面缩窄（打印乐谱疏朗感）

**文件：**
- 修改：`app/src/score/OSMDScore.ts`（构造器第 4 参 zoom）
- 修改：`app/src/score/osmd-score.test.ts`（zoom 接线断言）
- 修改：`app/src/components/ScoreSheet.tsx`（zoom prop 透传）
- 修改：`app/src/views/PerformPage.tsx`（传 zoom）与 `app/src/views/PreviewPage.tsx`（传 zoom）
- 修改：`app/src/views/PerformPage.css` / `app/src/views/PreviewPage.css`（限宽居中）

已勘察：OSMD `set Zoom(v){ this.zoom=v; this.zoomUpdated=true; …可选链保护 }`，load 前设置安全；`noteAtPoint/setMarkers` 的 unitPx=10×Zoom 已随动，几何自洽。SyncTunePage 自建 OSMDScore 不传 zoom（默认 1），行为不变。

- [ ] **步骤 5.1：先写失败测试**（osmd-score.test.ts 的 sync-tune 扩展 describe 里加）：

```ts
  it('zoom 参数：构造时写入 OSMD 实例（渲染前设置安全）', async () => {
    const cursor = new FakeCursor([0, 1])
    const fake = makeFakeOsmd(cursor)
    new OSMDScore(document.createElement('div'), '#3ddfae', fake, 1.15)
    expect((fake as unknown as { Zoom: number }).Zoom).toBe(1.15)
  })
```

- [ ] **步骤 5.2：运行确认失败**：`npx vitest run src/score/osmd-score.test.ts`，预期 FAIL（Zoom undefined ≠ 1.15）。
- [ ] **步骤 5.3：实现**。OSMDScore.ts 构造签名改 `constructor(container: HTMLElement, accent = '#3ddfae', osmdInstance?: OpenSheetMusicDisplay, zoom = 1)`，`this.osmd.FollowCursor = true` 后加：

```ts
    // 谱面缩窄（t_53aa8b7a）：Zoom 在 load/render 前设置（setter 只存值+置脏标，
    // 可选链保护未初始化状态），配合容器 max-width 减少每行小节数
    this.osmd.Zoom = zoom
```

- [ ] **步骤 5.4：运行确认通过**：`npx vitest run src/score/osmd-score.test.ts`。
- [ ] **步骤 5.5：ScoreSheet.tsx** Props 加 `/** 谱面缩放（配合容器限宽调整每行小节数，默认 1） */ zoom?: number`，解构默认 1，`new OSMDScore(divRef.current, accent, undefined, zoom)`；PerformPage 的 `<ScoreSheet …>` 加 `zoom={1.15}`，PreviewPage 的加 `zoom={1.1}`。
- [ ] **步骤 5.6：CSS 限宽**。PerformPage.css `.perform-stage .sheet-container` 块内追加：

```css
  /* 谱面缩窄（t_53aa8b7a）：容器限宽 + 居中，OSMD 按容器宽自适应换行，
     每行小节数下降、整体接近打印版乐谱的疏密 */
  max-width: min(880px, 100%);
  margin-inline: auto;
```

PreviewPage.css `.score-section` 块后追加：

```css
/* 谱面缩窄（t_53aa8b7a）：与演奏页同口径（预览容器外距已收窄一档） */
.score-section .sheet-container {
  max-width: min(820px, 100%);
  margin-inline: auto;
}
```

- [ ] **步骤 5.7：跑全量验证**（vitest/build/oxlint；重点回归 osmd-score.test、synctune logic/store 测试——标记层几何随 Zoom 已自洽）。
- [ ] **步骤 5.8：Commit**：
  ```
  git add app/src/score/OSMDScore.ts app/src/score/osmd-score.test.ts app/src/components/ScoreSheet.tsx app/src/views/PerformPage.tsx app/src/views/PreviewPage.tsx app/src/views/PerformPage.css app/src/views/PreviewPage.css
  git commit -m "style: 谱面容器限宽居中配合 Zoom 放大音符，接近打印乐谱排版"
  ```

---

### 任务 6：收尾验证 + 最终报告

- [ ] **步骤 6.1：使用 verification-before-completion 技能**，全量跑三条验证命令并记录真实输出摘要。
- [ ] **步骤 6.2：核对 git log**：5 个提交齐整、无 push、工作区 clean。
- [ ] **步骤 6.3：写报告** 到 `D:/LLM_work/syrinx-perform-polish/cc-report.md`（目录不存在则创建）：改动文件清单、各需求实现方式、验证输出摘要、遗留风险（重点：停止时刻取 `take.durationSec` 而非字面 `startSec + durationSec` 的理由；zoom/限宽参数未经目测，标注建议 dev 目测微调；startSec>0 场景「演奏时长」显示绝对停止位置的既有口径）。

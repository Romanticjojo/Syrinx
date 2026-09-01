# 入场闪图修复 + A4 谱面密度调整 + 展开谱多余谱号修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修三个用户实测反馈——①启动时闪现缩放 logo；②A4 谱面每行音符太少（2-3 小节）；③展开谱第二行第五小节前多出「谱号+4/4」。

**架构：** ①删 index.html 静态 `.boot` 里的 logo/文字，留纯深色底防白屏；③`expandRepeats()` 克隆小节时摘除 `<attributes>`（全曲只保留原始 m1 一份）；②演奏/预览页容器宽 `min(62vh,720px,100%)` → `min(66vh,860px,100%)`，zoom 统一 1.05，截图验收。

**技术栈：** Vite + React + TypeScript，vitest（happy-dom），OSMD 渲染，CDP 截图脚本（无 Playwright 依赖）。

**红线：** 严禁 electron-builder 打包；逐任务 commit、`git add` 指定文件（禁 `git add -A`）；不碰 `OSMDScore.ts` T3 成果；`app/scripts/shot-entry.mjs`（未提交）保持原样；不 push；不杀 5173 vite dev server（proc_cb621016b4f5）；`stripForcedBreaks`/`finish()`/`timelineUpTo` 语义不改。截图产物存 `D:/LLM_work/` 不进 git。

---

### 任务 1：boot 闪图修复（commit A）

**文件：**
- 修改：`app/index.html:10-39`（`<style>` 块 + `.boot` div）

- [ ] **步骤 1：改 index.html**

`<style>` 块替换为：

```html
    <style>
      /* 启动占位：JS 就绪前纯深色底防白屏（React 挂载后整体替换，不再放品牌位，
         避免 Intro 登场前闪现一张缩放 logo） */
      .boot {
        height: 100%;
        background: #0e0f0f;
      }
    </style>
```

`.boot` div 替换为：

```html
      <div class="boot"></div>
```

（删除 img 与 span，保留 div 结构。`theme-color` 已是 `#0e0f0f`，不动。）

- [ ] **步骤 2：Commit A**

```bash
git add app/index.html
git commit -m "fix(boot): 启动占位改纯深色底，删品牌位防 Intro 前闪现缩放 logo"
```

---

### 任务 2：expandRepeats 摘除克隆小节的 attributes（TDD，commit B）

**文件：**
- 修改：`app/src/score/musicxml.ts:127-132`（expandRepeats 克隆段）
- 测试：`app/src/score/musicxml.test.ts`（`describe('expandRepeats 反复展开')` 内追加）

**背景：** 克隆原始 m1 做第二遍时把 `<attributes>`（clef/key/time）一起克隆 → OSMD 在谱中间行内再画一遍小谱号 + 4/4。调号/拍号全程不变，全曲 attributes 只在原始 m1 保留一份。管线顺序 `expandRepeats(stripForcedBreaks(raw))`（songs/index.ts:61）不动。

- [ ] **步骤 1：写失败的测试**

在 `musicxml.test.ts` 的 `describe('expandRepeats 反复展开')` 内（`REPEAT_XML` 定义之后、第一个 `it` 之前任意位置）追加：

```typescript
  /** m1 带 attributes（divisions）+ forward repeat，m3 backward repeat：
      第二遍 m1 是克隆 → 不应带 attributes（否则 OSMD 在谱中间行内重画谱号/拍号） */
  it('克隆小节摘除 attributes，原始 m1 保留（防行内重复谱号/拍号）', () => {
    const expanded = expandRepeats(REPEAT_XML)
    // REPEAT_XML 只有 m1 一处 <attributes>；展开后（C D C D E）仍应只剩 1 处
    expect(expanded.match(/<attributes/g)).toHaveLength(1)
    const doc = new DOMParser().parseFromString(expanded, 'application/xml')
    const measures = Array.from(doc.querySelectorAll('measure'))
    // 原始 m1（演奏序第 1 小节）保留 attributes；克隆 m1（演奏序第 4 小节）摘除
    expect(measures[0].querySelector('attributes')).not.toBeNull()
    expect(measures[3].querySelector('attributes')).toBeNull()
  })
```

（`REPEAT_XML` 已满足构造要求：m1 带 `<attributes><divisions>1</divisions></attributes>` + forward repeat，m3 带 backward repeat。）

- [ ] **步骤 2：跑测试确认红**

运行：`cd app && npx vitest run src/score/musicxml.test.ts`
预期：新用例 FAIL（展开后 `<attributes>` 有 2 处）。

- [ ] **步骤 3：最小实现**

`musicxml.ts` 克隆段（约 130 行）改为：

```typescript
      const clone = measures[idx].cloneNode(true) as Element
      clone.setAttribute('number', String(seq + 1))
      clone.querySelectorAll('repeat, ending').forEach((r) => r.remove())
      // 摘除克隆小节的 attributes（clef/key/time）：调号拍号全程不变，原始 m1 已有一份；
      // 不摘则 OSMD 在展开谱中间行内重画小谱号 + 拍号（用户可见的多余符号）
      clone.querySelectorAll('attributes').forEach((a) => a.remove())
      frag.appendChild(clone)
```

- [ ] **步骤 4：跑测试确认绿 + 全量回归**

运行：`cd app && npx vitest run`
预期：全部 PASS（含 omr-check / omr-timeline-crosscheck / anchors 的既有展开用例——luv-letter 全曲只有 1 处 attributes，摘克隆不影响时间轴数学）。

- [ ] **步骤 5：Commit B**

```bash
git add app/src/score/musicxml.ts app/src/score/musicxml.test.ts
git commit -m "fix(score): expandRepeats 克隆小节摘除 attributes，防行内重复谱号/拍号"
```

---

### 任务 3：A4 密度调整（commit C，代码部分）

**文件：**
- 修改：`app/src/views/PerformPage.css:165-168`（容器宽）
- 修改：`app/src/views/PerformPage.tsx:548`（zoom）
- 修改：`app/src/views/PreviewPage.css:308-312`（容器宽）
- 修改：`app/src/views/PreviewPage.tsx:186`（zoom）
- 修改：`app/scripts/shot-perform.mjs:10`（OUT_DIR 支持 env 覆盖，产物进 shots2/）

- [ ] **步骤 1：改四处 CSS/zoom**

`PerformPage.css` 注释与宽度改为（保留 backdrop 等后续行不动）：

```css
  /* A4 纵版比例（t_c10d648d）：可用谱面高约占 90vh，A4 宽 ≈ 0.707×高，
     取 66vh 留页头控制条余量；860px 兜底超大屏、100% 兜底窄屏。
     换行由 OSMD 按容器宽自适应（强制换行已在 loadSong 剥离），zoom 1.05
     音符更小，每行 4-6 小节，观感接近竖版打印乐谱 */
  width: min(66vh, 860px, 100%);
```

`PerformPage.tsx:548`：`zoom={1.3}` → `zoom={1.05}`

`PreviewPage.css:308-312` 注释与宽度改为：

```css
/* A4 纵版比例（t_c10d648d）：与演奏页同口径（66vh + 860px 兜底，zoom 同为 1.05） */
.score-section .sheet-container {
  width: min(66vh, 860px, 100%);
  margin-inline: auto;
}
```

`PreviewPage.tsx:186`：`zoom={1.1}` → `zoom={1.05}`

移动端 ≤640 的 `width: 100%` 覆盖两条都已有，不动。

- [ ] **步骤 2：shot-perform.mjs 支持输出目录覆盖**

第 10 行改为：

```javascript
const OUT_DIR = process.env.SHOT_OUT_DIR ?? 'D:/LLM_work/syrinx-perform-polish/shots'
```

- [ ] **步骤 3：Commit C（脚本改动进 git，截图产物不进）**

```bash
git add app/src/views/PerformPage.css app/src/views/PerformPage.tsx app/src/views/PreviewPage.css app/src/views/PreviewPage.tsx app/scripts/shot-perform.mjs
git commit -m "feat(perform): A4 密度调整——容器 66vh/860px、zoom 1.05，预览页同口径"
```

---

### 任务 4：验证 + 截图验收

- [ ] **步骤 1：跑 4 档截图到 shots2/**

运行（vite dev server 已在 5173）：

```bash
cd app && SHOT_OUT_DIR=D:/LLM_work/syrinx-perform-polish/shots2 node scripts/shot-perform.mjs
```

预期：4 个 png（1920x1080 / 1366x768 / 768x1024 / 390x844），console 打印 containerWidth（1920 档应 ≈ 860px 上限或 66vh 内）。

- [ ] **步骤 2：亲自看图核对**

- 问题 2：每行 4-6 小节、音符清晰不挤（看 1920x1080 与 1366x768）。
- 问题 3：第二行第五小节前不再有行内小谱号 + 4/4。
- 问题 1：手动开 5173 目验启动无 logo 闪现（或代码审阅确认 `.boot` 无 img）。

- [ ] **步骤 3：全量验证**

```bash
cd app && npx vitest run && npm run build && npx oxlint
```

预期：全绿。

（注：若 npx/npm 类执行命令被权限自动拒绝，把验证命令原文交给用户手跑，实现照常完成。）

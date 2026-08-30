# Qoder 工具映射

Skills 使用 Claude Code 的工具名称。Qoder（阿里 AI IDE）大部分工具与 Claude Code **同名**，只有少数差异：

| Skill 中的引用 | Qoder 等价工具 |
|---------------|---------------|
| `Read` / `Write` / `Edit` | 同名（`Read` / `Write` / `Edit`） |
| `Bash` | 同名 |
| `Grep` / `Glob` | 同名 |
| `Task`（派遣子 agent） | 同名（`Task`） |
| `WebFetch` / `WebSearch` | 同名 |
| `AskUserQuestion` | 同名 |
| `Skill` | 同名 |
| `TodoWrite` | 同名 |
| `EnterPlanMode` / `ExitPlanMode` | **`EnterSpecMode` / `ExitSpecMode`**（Qoder 把"计划模式"称为"Spec 模式"）|

## Task 子 Agent 类型

> **适用范围：Qoder CLI。** 下表逐条核对自 [Qoder 官方文档 · 子代理](https://docs.qoder.com/zh/cli/subagent)（核对于 2026-08）。
> **Qoder IDE 的内置 subagent 集合与此不同，我们尚未核实** —— 见下方「IDE 与 CLI 的差异」。

| Claude Code Agent | Qoder CLI 等价 | 说明 |
|------------------|---------------|------|
| `general-purpose` | `general-purpose` | 通用研究型，适合复杂搜索、多文件分析、调用链追踪、多步骤任务 |
| `Explore` | `Explore` | 同名。只读代码探索 |
| `Plan` | `Plan` | 同名。只读设计与规划 |
| `claude-code-guide` | `qoder-guide` | 非 SDK 模式下可用 |

文档另列出 `statusline-setup`（TUI 模式）。**没有内置的 `code-reviewer`** —— 文档里出现的 `api-reviewer` 是用户自建 subagent 的示例，不是内置项。需要专职审查者时，用 `general-purpose` 配 `superpowers:requesting-code-review` 的 `code-reviewer.md` 模板。

### IDE 与 CLI 的差异

[#119](https://github.com/jnMetaCode/superpowers-zh/issues/119) 报告：在 **Qoder IDE** 里跑 `subagent-driven-development` 时，Qoder 说它只提供 `CodeReview` subagent、**没有** `general-purpose`，于是自行降级为「控制者直接实现 + CodeReview agent 做审查」。

官方 subagent 文档只覆盖 CLI，没有说这套内置集合同样适用于 IDE。**所以上表在 Qoder IDE 上不保证成立。** 如果你在 IDE 里遇到「找不到 general-purpose」，那是预期内的差异，不是 superpowers-zh 装错了 —— Qoder 的自动降级本身是合理适配。

## Quest MCP 工具（Qoder 原生）

Qoder 内置 Quest 系统提供以下工具，Claude Code 没有等价物，可在 skill 流程中直接调用：

| 工具 | 用途 |
|------|------|
| `mcp__quest__search_codebase` | 语义化代码搜索（按意图找代码） |
| `mcp__quest__search_symbol` | 按符号名搜索代码及关系 |
| `mcp__quest__get_problems` | 获取文件编译/语法错误 |
| `mcp__quest__run_preview` | 启动本地 Web 服务器预览 |
| `mcp__quest__search_memory` / `update_memory` | 跨会话记忆管理 |
| `mcp__quest__fetch_rules` | 查询规则文件 |

## 加载方式

Qoder 在每个会话自动加载 `.qoder/rules/superpowers-zh.md`（`trigger: always_on`），里面包含 skill 索引。`.qoder/skills/<name>/SKILL.md` 由模型按 description 自主调用，也可输入 `/<skill-name>` 手动触发。

# Copilot CLI 工具映射

技能使用 Claude Code 的工具名称。当你在技能中遇到这些工具时，使用你平台的等价工具：

| 技能中引用的工具 | Copilot CLI 等价工具 |
|-----------------|----------------------|
| `Read`（读取文件） | `view` |
| `Write`（创建文件） | `create` |
| `Edit`（编辑文件） | `edit` |
| `Bash`（运行命令） | `bash`（Windows 上常为 `powershell`，见[异步 Shell 会话](#异步-shell-会话)） |
| `Grep`（搜索文件内容） | `grep` |
| `Glob`（按名称搜索文件） | `glob` |
| `Skill` 工具（调用技能） | `skill` |
| `WebFetch` | `web_fetch` |
| `Task` 工具（分派子智能体） | `task`（参见[智能体类型](#智能体类型)） |
| 多个 `Task` 调用（并行） | 多个 `task` 调用 |
| Task 状态/输出 | `read_agent`、`list_agents` |
| `TodoWrite`（任务跟踪） | `sql` 配合内置 `todos` 表 |
| `WebSearch` | 无等价工具 — 使用 `web_fetch` 配合搜索引擎 URL |
| `EnterPlanMode` / `ExitPlanMode` | 无等价工具 — 留在主会话中 |

## 智能体类型

Copilot CLI 的 `task` 工具接受 `agent_type` 参数：

| Claude Code 智能体 | Copilot CLI 等价 |
|-------------------|----------------------|
| `general-purpose` | `"general-purpose"` |
| `Explore` | `"explore"` |
| 命名的插件智能体（如 `superpowers:code-reviewer`） | 从已安装的插件中自动发现 |

## 异步 Shell 会话

Copilot CLI 支持持久化的异步 shell 会话，这在 Claude Code 中没有直接等价物。

> ⚠️ **shell 工具面随平台和版本而异，下面两套工具名不会同时出现。** 动手之前先确认你这个 build 实际注册的是哪一套 —— 照着不存在的工具名调用，agent 会找不到工具然后即兴发挥。Windows 上常见的是 powershell 那一套（实测 Copilot CLI 1.0.69-1 / Windows 只有 powershell，没有任何 `bash` / `async` 家族工具）。

**Unix / macOS —— bash 一套：**

| 工具 | 用途 |
|------|---------|
| `bash` 配合 `async: true` | 在后台启动长时间运行的命令 |
| `write_bash` | 向运行中的异步会话发送输入 |
| `read_bash` | 读取异步会话的输出 |
| `stop_bash` | 终止异步会话 |
| `list_bash` | 列出所有活跃的 shell 会话 |

**Windows —— powershell 一套：**

| 工具 | 用途 |
|------|---------|
| `powershell` 配合 `detach: true` | 在后台启动长时间运行的命令（参数名是 `detach`，**不是** `async`） |
| `read_powershell` | 读取会话的输出 |
| `stop_powershell` | 终止会话 |
| `list_powershell` | 列出所有活跃的 shell 会话 |
| （无 `write_powershell`） | 这一套**没有**向运行中会话发送输入的工具 |

### Windows 上的两个坑

**1. `.sh` 脚本不能裸跑。** powershell 下直接执行 `scripts/start-server.sh` 会报 `The term 'scripts/start-server.sh' is not recognized...`，必须显式走 Git Bash：

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/start-server.sh
```

**2. `stop_powershell` 停不掉 `detach: true` 启动的进程。** detached 进程要按 PID 停：

```powershell
Stop-Process -Id <PID>
```

所以**不要把 `stop_*` 当作 detached 常驻进程的唯一清理路径** —— 必须先拿到真实的 Windows PID（不是 MSYS PID），再 `Stop-Process`。涉及长驻 server 的 skill（如 brainstorming 的视觉伴侣）在 Windows 上尤其要注意这一点。

## 额外的 Copilot CLI 工具

| 工具 | 用途 |
|------|---------|
| `store_memory` | 持久化代码库相关事实供未来会话使用 |
| `report_intent` | 更新 UI 状态行显示当前意图 |
| `sql` | 查询会话的 SQLite 数据库（待办、元数据） |
| `fetch_copilot_cli_documentation` | 查阅 Copilot CLI 文档 |
| GitHub MCP 工具（`github-mcp-server-*`） | 原生 GitHub API 访问（issue、PR、代码搜索） |

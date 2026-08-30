# Gemini CLI 工具映射

Skills 说的是动作（"分派一个子智能体"、"建一条待办"、"读一个文件"）。在 Gemini CLI 上，这些动作对应下面这些工具。

| Skill 请求的动作 | Gemini CLI 等价工具 |
|----------------|-------------------|
| 读取一个文件 | `read_file` |
| 一次读取多个文件 | `read_many_files` |
| 创建新文件 | `write_file` |
| 编辑文件 | `replace` |
| 执行 shell 命令 | `run_shell_command` |
| 搜索文件内容 | `grep_search` |
| 按名称查找文件 | `glob` |
| 列出文件和子目录 | `list_directory` |
| 抓取 URL | `web_fetch` |
| 搜索网页 | `google_web_search` |
| 调用一个 skill | `activate_skill` |
| 分派子智能体（`Subagent (general-purpose):` 模板） | `invoke_agent`，`agent_name: "generalist"`（也可用 `@generalist` 聊天语法调用——见[子智能体支持](#子智能体支持)） |
| 多个并行分派 | 同一条响应里发多个 `invoke_agent` 调用 |
| 任务跟踪（"建一条待办"、"标记完成"） | `write_todos`（状态：pending、in_progress、completed、cancelled、blocked） |

## 指令文件

当某个 skill 提到"你的指令文件"时，在 Gemini CLI 上指的是 **`GEMINI.md`**。Gemini CLI 按层级加载 `GEMINI.md`：全局的在 `~/.gemini/GEMINI.md`，项目级的在工作区目录及其各级父目录里，另外当某个工具访问子目录中的文件时，该子目录下的 `GEMINI.md` 也会被加载。

## 个人 skills 目录

用户级 skills 放在 **`~/.gemini/skills/`**，**`~/.agents/skills/`** 是跨运行时的别名目录（与 Codex、Copilot CLI 共用）。当同一层级下两个目录都存在时，`.agents/skills/` 优先。每个 skill 是一个子目录，里面有一份带 `name` 和 `description` frontmatter 的 `SKILL.md`。

## 子智能体支持

Gemini CLI 通过 `invoke_agent` 工具分派子智能体，该工具接收 `agent_name` 和 `prompt` 两个参数。同一个分派动作也有聊天语法快捷方式：输入 `@generalist <prompt>` 等价于以 `agent_name: "generalist"` 调用 `invoke_agent`。内置的 agent 名包括 `generalist`、`cli_help`、`codebase_investigator`，以及（启用浏览器工具后的）`browser_agent`。

Skills 用 `Subagent (general-purpose):` 来分派，并且要么引用一个提示词模板文件（例如 `superpowers:subagent-driven-development` 的 `./implementer-prompt.md`），要么直接给出内联提示词。在 Gemini CLI 上：

| Skill 里的分派形式 | Gemini CLI 等价做法 |
|------------------|-------------------|
| 引用某个 `*-prompt.md` 模板（implementer、task-reviewer、code-reviewer 等） | 把模板填好，然后以 `agent_name: "generalist"` 和填好的提示词调用 `invoke_agent` |
| 引用 `superpowers:requesting-code-review` 的 `./code-reviewer.md` | 以 `agent_name: "generalist"` 和填好的审查模板调用 `invoke_agent` |
| 内联提示词（没有引用模板） | 以 `agent_name: "generalist"` 和你的内联提示词调用 `invoke_agent` |

### 填写提示词

Skills 提供的提示词模板里有 `{WHAT_WAS_IMPLEMENTED}` 或 `[FULL TEXT of task]` 这类占位符。把所有占位符都填好，再把完整提示词交给 `invoke_agent`。模板本身就包含了该 agent 的角色、审查标准和期望的输出格式——子智能体会照着它执行。

### 并行分派

Gemini CLI 支持并行分派子智能体。在同一条响应里发出多个 `invoke_agent` 调用（或在一个提示词里写多个 `@generalist` 调用），即可让相互独立的子智能体工作并行跑。有依赖关系的任务保持串行，但**不要**为了让历史记录简单一点就把相互独立的子智能体任务串起来。

## Gemini CLI 额外工具

以下工具是 Gemini CLI 独有的：

| 工具 | 用途 |
|------|------|
| `save_memory`（旧版） | 当 `experimental.memoryV2 = false` 时，跨会话持久化事实 |
| `get_internal_docs` | 查阅 Gemini CLI 自带的文档 |
| `ask_user` | 向用户提出结构化问题（文本 / 单选 / 多选） |
| `enter_plan_mode` / `exit_plan_mode` | 进入和退出只读的计划模式 |
| `update_topic` | 更新当前会话的主题 / 战略意图元数据 |
| `complete_task` | 表示某个 Gemini 子智能体已完成，并把结果返回给父 agent |
| `tracker_create_task`、`tracker_update_task`、`tracker_get_task`、`tracker_list_tasks`、`tracker_add_dependency`、`tracker_visualize` | 功能完整的任务跟踪器，支持依赖关系与可视化 |
| `read_mcp_resource`、`list_mcp_resources` | 访问 MCP 资源 |

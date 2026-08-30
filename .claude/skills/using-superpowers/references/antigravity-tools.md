# Antigravity CLI（`agy`）工具映射

Skills 说的是动作（"分派一个子智能体"、"建一条待办"、"读一个文件"）。在 Antigravity CLI（`agy`）上，这些动作对应下面这些工具。

| Skill 请求的动作 | Antigravity CLI 等价工具 |
|----------------|----------------------|
| 分派子智能体（`Subagent (general-purpose):` 模板） | `invoke_subagent`，配一个内置的 `TypeName` —— 全能力工作用 `self`，只读调研用 `research` |
| 任务跟踪（"建一条待办"、"标记完成"） | 一个 **task artifact** —— 用 `write_to_file` 并带上 `IsArtifact: true` 与 `ArtifactType: "task"`（见下方[任务跟踪](#任务跟踪)）。**不是** `manage_task`，那个是管后台进程的。 |

## 任务跟踪

Antigravity **没有 todo 工具**（`manage_task` 管的是后台进程 —— `list`／`kill`／`status`／`send_input` —— 它**不是**清单工具）。当某个 skill 说要创建待办清单或跟踪任务时，改为维护一个 **task artifact**：一份用 `write_to_file` 保存的 markdown 清单（`IsArtifact: true`、`ArtifactMetadata.ArtifactType: "task"`），过程中用 `replace_file_content` ／ `multi_replace_file_content` 来编辑。

任何多步任务一开始，就创建这个 task artifact，把你计划里的每一步都列上。每完成一步，就编辑该 artifact 把它标记为完成（`- [x]`）。计划有变就更新清单。**保持它是最新的** —— 它是"还剩什么没做"的唯一事实来源；一旦对话变长，每开始一步之前先重读它。

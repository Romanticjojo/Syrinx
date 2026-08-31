# Syrinx 发布前安全扫描报告

日期：2026-08-31 · 范围：**重写后全历史**（88 个提交，媒体路径已用 filter-branch 从历史清除）+ 全部提交信息 + 待发布文件树（272 个文件）

## 结论：未发现任何 API Key 泄露，0 处命中，无需人工确认，可继续推送

## 扫描方法

1. `git log -p --all` 导出完整补丁历史（约 3 MB 文本），逐行正则匹配：
   - `sk-[a-zA-Z0-9]{20,}`（sk- 形态密钥）
   - `ARK_[A-Z_]*KEY` / `VOLC[A-Z_]*KEY`（火山引擎）
   - `ANTHROPIC_AUTH_TOKEN`
   - `(?i)api[_-]?key.{0,40}[a-zA-Z0-9]{16,}`（api_key 后跟 16 位以上字串）
   - `(?i)(secret|token|bearer)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{24,}`（其他密钥形态）
   - 每处命中均回溯定位到所属提交哈希（脚本：`scripts-release-scan.ps1`）
2. 提交信息单独扫描（`git log --all --format=%B`）
3. 待发布文件树扫描（`git ls-files` 抽查媒体扩展名 + 全文件在上述第 1 步中已覆盖）

## 结果

| 扫描对象 | 命中数 |
|---|---|
| 全历史 patch（5 组模式） | **0** |
| 提交信息 | **0** |
| 待发布文件树中的音视频/谱子媒体 | **0** |

## 附注

- `.claude/skills/` 下的技能文档含示例 key 字样，但 `.claude/` 自始被 .gitignore 排除、从未入库，不适用。
- 历史中的 `resources/`、`app/public/songs/`、`app/public/models/`（含 mp3/mp4/musicxml/glb/blend 等）已通过 `git filter-branch --index-filter` 从**全部 88 个提交**中移除，磁盘文件保留。

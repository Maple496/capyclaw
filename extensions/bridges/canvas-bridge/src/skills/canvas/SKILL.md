---
name: canvas
description: Canvas 文档工作台总入口：按用户意图路由到成稿/执行/API 手册技能；「用户说什么，画布就怎么变」。
whenToUse: 用户提到文档、文章、报告、说明书、长文、画布，或要求生成/修改/续写/排版文档内容时。
---

# Canvas 文档工作台路由

本技能只做路由。成稿、执行、工具手册是三条独立链路：

| 用户意图 | 加载技能 | 负责什么 |
|---|---|---|
| 从零写一份文档（方案/报告/说明） | `canvasist-authoring` | 结构设计 → 一次成稿 |
| 改现有文档（改字/换色/加表/调格式） | `canvasist-editing` | **纯执行**：指哪打哪，不回头验证 |
| 工具参数、命令面、撤销、页面命令 | `canvasist-api` | canvas_* 工具操作手册 |

## 加载顺序

- **改现有文档**：默认只加载 `canvasist-editing`；用户没说「检查/验收/截图」时不主动截图。
- **从零写文档**：`canvasist-authoring`（直接用块级写作模型成稿，不需要单独的叙事技能）。
- **不确定工具参数/命令名**：`canvasist-api`（内含构建生成的 `references/tool-contract.md`）。

## 交叉规则

- 先 `canvas_capabilities` 确认 contract 1.x 和编辑器连接；工具缺失或 major 不一致时停止，并提示用户安装/升级 canvas 套件。
- 写工具需要编辑器页面在线（错误信息会给出地址）；编辑器没连接时不要反复重试写工具。
- 用户说「文档/文章/画布」默认指 Canvas 编辑器页面里的内容。
- 成稿用 `canvas_write_document` 一次写入；续写用 `canvas_append_blocks`；不要逐段小步写。
- 编辑/成稿默认**不主动审计、不主动截图**；只有用户明确要求验收时才 `canvas_screenshot` + `canvas_audit`。
- 工具返回已含回执；改完一句话说明结果，不贴 JSON。

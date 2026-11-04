---
name: ppt
description: PPT 演示文稿总入口：默认先路由到“纯执行/成稿”，审美与审计作为独立技能按需加载，不混入日常修改。
whenToUse: 用户提到 PPT、演示文稿、幻灯片、Keynote、deck，或要求生成/修改/美化/预览演示内容时。
---

# PPT 工作台路由

本技能只做路由。执行、审美、审计是三条独立链路：

| 用户意图 | 加载技能 | 负责什么 |
|---|---|---|
| 方案结构、故事线、目录、章节、一页一观点 | `pptmaster-narrative` | 内容叙事，不碰工具/视觉 |
| 调工具、schema、编辑器状态、撤销、页面命令 | `pptist-api` | PPTist API 操作手册 |
| 打开/保存本地 .pptx | `pptist-api` | `ppt_import_pptx` / `ppt_export_pptx`，不手写 OOXML |
| 从叙事骨架落到干净成稿 | `pptist-authoring` | 桥接层：骨架 → 简洁版式工具 |
| 改现有 deck（文字/背景/元素/页/图片） | `pptist-editing` | **纯执行**：指哪打哪，不审美、不审计、不回头验证 |
| 配色、字体、版式、设计 token、反 AI slop | `pptmaster-design` | 独立审美技能，只在用户明确要审美判断时加载 |
| 审计、截图、交付前检查 | `pptist-visual-check` | 独立验收技能，只在用户明确要求检查/验收时加载 |
| 查资料、找数据、找配图 | `pptist-research` | 外部研究，产出分析卡 |

## 加载顺序

- **改现有 deck**：默认只加载 `pptist-editing`。用户没说“美化/配色/版式”时不加载 `pptmaster-design`；用户没说“检查/审计/验收/截图”时不加载 `pptist-visual-check`。
- **从零做方案**：`pptmaster-narrative` → `pptist-authoring`。`pptist-authoring` 默认出 clean 简洁稿；审美定制再叠加 `pptmaster-design`，验收再叠加 `pptist-visual-check`。
- **只做审美**：`pptmaster-design`。
- **只做审计/截图**：`pptist-visual-check`。
- **带外部资料**：`pptist-research` → `pptmaster-narrative` → `pptist-authoring`（审美/审计仍按需）。

## 交叉规则

- 叙事技能不调用工具；设计技能不调用工具；执行技能不做审美判断；审计技能不负责改稿。
- 先 `ppt_capabilities` 确认 contract 2.x 和编辑器状态；工具参数细节读 `pptist-api` 技能（安装包内随附构建生成的 `references/tool-contract.md`，源码树不保存该文件）。
- 用户说“背景/页面/幻灯片/标题”默认指右侧 PPTist 编辑器。
- 新建 deck 默认走内置简洁版式，不要另加装饰层。
- 编辑/成稿默认**不主动审计、不主动截图**；只有用户明确要求验收时，才由 `pptist-visual-check` 执行。
- 工具返回已含回执；改完一句话说明结果，不贴 JSON。

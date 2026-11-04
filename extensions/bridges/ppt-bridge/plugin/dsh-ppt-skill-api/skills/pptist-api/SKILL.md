---
name: pptist-api
description: PPTist Workbench API 操作手册：工具契约、参数、编辑器状态、页/元素/截图/历史/页面命令。只讲怎么调工具，不讲选题叙事与视觉审美。
whenToUse: 需要调用 ppt_* 工具读写当前 PPTist deck、确认 contract、处理编辑器连接/撤销/放映/截图/页面命令时。
---

# PPTist API 操作手册

本技能只负责 **工具调用与运行时行为**。内容叙事、设计审美、审计验收分别由独立技能负责；本技能不重复，也不主动触发它们。

## 启动

1. 调 `ppt_capabilities`：确认 `contractVersion` 为 2.x，并读取 `editorConnected`、`hasDeck`、`slides`、`seq`。
2. 需要工具参数细节时读 `references/tool-contract.md`（由构建生成，与 `ppt_capabilities` 同源）。
3. 编辑器未连接时，把 `editorUrl` 给用户；页面加载后自动连接，不要循环重试。

## 工具面

| 组 | 工具 | 用途 |
|---|---|---|
| 契约 | `ppt_capabilities` | contract、工具清单、运行时状态 |
| 导入/导出 | `ppt_import_pptx`、`ppt_export_pptx` | 打开本机 .pptx（原生转换）/ 导出 .pptx |
| 验收（按需） | `ppt_get_deck`、`ppt_audit`、`ppt_screenshot` | 结构读取、确定性审计、实时画面 |
| 新建 | `ppt_deck`、`ppt_page` | 整套成稿 / 逐页成稿 |
| 图片检索 | `ppt_images` | 纯搜索，返回候选直链（不下载） |
| 编辑 | `ppt_text`、`ppt_style`、`ppt_recolor`、`ppt_element`、`ppt_image`、`ppt_slide`、`ppt_fill` | 文字/样式/换色/元素/图片/页 |
| 控制 | `ppt_history`、`ppt_present`、`ppt_apply` | 撤销重做/放映/底层逃生口 |
| 恢复 | `ppt_task` | status/list/checkpoint/restore，长任务每阶段保存 |

## 调用规则

- 用户说“背景/页面/幻灯片/标题”指右侧编辑器，不是网页或文件。
- 用户给本地 `.pptx` 路径时，用 `ppt_import_pptx({path})` 打开；默认 `mode:"replace"` 替换当前 deck，要多文件拼接才用 `"append"`。不要自己解析 OOXML。
- 需要保存为 `.pptx` 时，用 `ppt_export_pptx({path})`；要覆盖原文件必须传 `overwrite:true`（默认会先备份为 `.bak-<时间>.pptx`）。返回的 `stats.warnings` 是降级项（自定义形状、LaTeX/音视频等），要如实告诉用户。
- 从本机 `.pptx` 打开时，`ppt_import_pptx` 会返回 `source.path`；用户说“保存回原文件”时用它 + `overwrite:true`。编辑器顶栏的“保存 PPTX”按钮也会走同一条备份写回逻辑。
- 改整体背景/配色只用 `ppt_recolor` 一次完成；不要逐页 `ppt_element` 改色。
- 改文字/加页/改背景不要先读整个 deck；只有定位具体元素时才 `ppt_get_deck({detailed:true})`，一次即可。
- 新建 deck 默认 `ppt_deck` + `preset: "clean"`，不要另加装饰层。
- 长 deck 用 `ppt_page` 一次只写当前一页；首屏 `replace:true`，后续逐页追加。
- 图片用 `ppt_image`（attachment_id/path/src）；不要用 shell 找图，不要用 `ppt_element` 传本机路径。
- 本技能只负责调用工具；审美、审计、截图验收由独立技能按需触发，不在这里主动执行。
- `ppt_apply` 只在专用工具覆盖不了时用；一次提交多个 op 时，`present/select` 等页面命令可一起提交。
- 工具返回已含回执；不要重复验证或贴 JSON。

## 错误处理

- 参数不合法：按返回的字段名修正，不要换工具硬试。
- 单次工具参数过大（如 `ppt_deck` 一次塞满 30 页完整 detail）容易让模型侧 tool input JSON 解析失败；先成稿骨架，再用 `ppt_fill`/`ppt_text` 分批补充。
- 模型侧报 `tool input is invalid JSON`：工具没有执行；不要原样重发同一大调用，缩小本次参数后重试一次。
- 页号越界：先 `ppt_get_deck` 确认真实页数。
- 截图超时：让用户刷新编辑器；不要循环重试，也不要用审计代替截图。
- 编辑历史：`ppt_history` 是服务端 deck 历史；页面级 `present/select` 不进历史。
- 长任务：每完成一个阶段调用 `ppt_task checkpoint`；新会话先用 `ppt_task status`，有 pending 或需要回退时用 `restore`。

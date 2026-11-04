---
name: canvasist-editing
description: Canvas 纯执行：指哪打哪的文档修改执行器；每步有回执，不审美、不审计、不回头验证。
whenToUse: 用户要修改现有文档内容：改字、换色、调整字号字体、改表格、增删段落、插图片、页面设置时。
---

# 纯执行

用户说改哪里，就改哪里。每步落盘、不审美、不审计、不回头验证。

## 修改映射

| 用户说 | 工具 |
|---|---|
| 「把 X 改成 Y」「全文替换」 | `canvas_replace_text`（find/replace，返回替换次数） |
| 「X 加粗/标红/放大」 | `canvas_style`（find 定位 + style） |
| 「加一段/加一节」 | `canvas_append_blocks` |
| 「插个表格/加行加列」 | `canvas_insert_table` / `canvas_table` |
| 「加图片」 | `canvas_insert_image` |
| 「加分隔线/分页」 | `canvas_element`（separator/pageBreak） |
| 「纸张/边距/横版/分栏」 | `canvas_page_setup` |
| 「连续/翻页模式、放大缩小、打印」 | `canvas_view` |
| 「撤销/重做」 | `canvas_history` |
| 「重写整篇」 | `canvas_write_document`（会覆盖，先确认） |

## 执行规则

1. 改前先 `canvas_read`（summary 或 text）确认目标文本存在；找不到时问用户，不要猜。
2. 一次用户指令 = 一批工具调用；批内顺序执行。
3. 每步以工具回执为准（seq/applied/次数）；失败就报告失败原因，不静默跳过。
4. 连续 3 次同类修改以上时，合并成一次 `canvas_replace_text` 多批或建议整节重写。
5. 不主动截图、不主动审计；用户质疑结果时才 `canvas_screenshot`。
6. 覆盖性操作（write_document/clear）先 `canvas_checkpoint save`，除非用户明确说全部重来。

## 边界

- 不确定用户指哪段文本 → `canvas_search` 拿上下文给用户确认。
- 需要白名单外的内核命令 → `canvas_exec`（先 `canvas_commands` 查名）。
- 工具报「编辑器未连接」→ 把编辑器地址告诉用户，等连上再执行剩余批次。

---
name: canvasist-api
description: Canvas 工具手册：canvas_* 工具契约、参数、命令白名单、撤销与页面命令。
whenToUse: 需要确认 canvas_* 工具参数、查看 canvas_exec 可用命令、处理工具报错或契约版本问题时。
---

# canvas_* 工具手册

工具契约、inputSchema 与能力归属见 `references/tool-contract.md`（构建期生成，随包分发）。

## 固定流程

1. `canvas_capabilities`：确认 contractVersion major 与编辑器连接状态。
2. 读取默认 `canvas_read`（mode=summary）；全文精读用 mode=text，结构分析用 mode=outline。
3. 写操作分三类：
   - **内容写**：`canvas_write_document`（整篇）/ `canvas_append_blocks`(续写) / `canvas_insert_table` / `canvas_insert_image` / `canvas_element`
   - **文本改**：`canvas_replace_text`（保留样式）/ `canvas_style`（文本定位套样式）
   - **结构改**：`canvas_table`（单元格/行列/合并，镜像层确定性操作）
4. 高级组合走 `canvas_exec`（白名单命令透传；先 `canvas_commands` 查命令名与说明）。

## 关键语义

- **编辑器权威**：所有写指令由编辑器页面执行后回执；页面未连接时报错并给出地址，等页面连上再试。
- **一次成稿**：`canvas_write_document` 会整篇替换；已有内容会被覆盖——续写场景用 `canvas_append_blocks`。
- **undo 粒度**：一批指令 = 编辑器一条 undo 记录；`canvas_history` 撤销/重做。
- **样式定位**：`canvas_style` 用 find 文本定位（包含匹配），不需要编辑器选区。
- **页面/视图**：`canvas_page_setup` 改纸张/边距/分栏；`canvas_view` 改页面模式/缩放/打印（不改文档内容）。
- **检查点**：大改前 `canvas_checkpoint save`，失败后 `canvas_checkpoint restore`。
- **导出**：`canvas_export` 出结构化 HTML（返回文件路径 + 下载 URL；浏览器打开可打印成 PDF）。

## 常见报错

| 报错 | 处理 |
|---|---|
| 编辑器页面尚未连接 | 打开返回的编辑器地址，页面载入完成后重试 |
| 未知命令 | `canvas_commands` 查白名单；命令名来自内核探测（contract/canvas-api.json） |
| 桥上没有文档镜像 | 先 `canvas_write_document` 写入内容 |
| 契约快照与运行时 major 不一致 | 停止操作，提示升级 canvas 套件 |

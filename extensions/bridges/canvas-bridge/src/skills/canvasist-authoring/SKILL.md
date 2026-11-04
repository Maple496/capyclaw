---
name: canvasist-authoring
description: Canvas 文档成稿：结构设计 → 块级写作 → 一次成稿 → 表格/图片/样式精修。
whenToUse: 用户要从零生成一份文档（报告/方案/说明书/长文），或要求整体重写文档时。
---

# 成稿流程

## 1. 定结构（不调用工具）

先想清楚：标题 → 章节标题（2-4 级）→ 每节要点 → 需要表格/图片的位置。
长文档（>1500 字）必须有二级结构；每节 200-500 字为宜。

## 2. 一次成稿

用 `canvas_write_document` 把全部内容按块写入：

- `heading`（level 1-4）/ `paragraph` / `bullet` / `number` / `quote` / `code` / `divider` / `pageBreak`
- 块级 `style` 可加行内样式（bold/color/size/font/highlight），但成稿阶段**少用**——结构优先，精修交给下一步。

## 3. 精修

- 数据对比 → `canvas_insert_table`（headers + rows，列宽自动适配）
- 配图 → `canvas_insert_image`（dataURL 或 /assets 引用）
- 强调 → `canvas_style`（如给结论句加粗/高亮）
- 署名/分隔 → `canvas_element`（separator/pageBreak/list）

## 4. 收尾

- 大改前先 `canvas_checkpoint save <里程碑名>`。
- 用户要求验收时才：`canvas_audit` → `canvas_screenshot` → 按发现修复。
- 用户要文件时：`canvas_export`。

## 硬规则

- 不逐段小步写：一次成稿 + 续写两次以内完成主体。
- 表格不超过 8 列；单元格文本 ≤ 40 字。
- 不编造引用来源；数据来源在文中标注。
- 成稿后报告字数与章节结构（来自工具返回），不目测。

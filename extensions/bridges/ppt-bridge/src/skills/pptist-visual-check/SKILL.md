---
name: pptist-visual-check
description: PPT 检查/审查技能：只跑确定性审计与按需截图，报告 pass/blocking 和逐页问题；不修改 deck，不承担设计决策。
whenToUse: 用户要求检查、审计、验收、预览、截图，或明确问“有没有文字重叠/溢出/对比度问题”时。
---

# PPTist 检查与审查

本技能只负责 **检查和报告**。修复由执行技能负责；配色/版式等审美判断由设计技能负责。本技能不修改 deck，也不把审计结论直接变成改稿动作。

## 1. 确定性审计

调用 `ppt_audit`，**以 `pass`/`blocking` 为准**，`score` 只作参考：

- `pass: false` 或存在 `error`：不得说“审计通过”；逐条列出 `blocking` 的页/元素/问题。
- 硬错误包括：文字越界/溢出、文本重叠、`duplicate-text`（同文案叠两层）、`text-invisible`（文字与自身高亮同色）、`text-occluded`（被上层遮挡）、`contrast`、`repeated-layout`（大块装饰版式重复 ≥3 页）。
- `warning`：逐条说明是否可能是误报；密度/配色漂移/重复图片通常要处理。
- 审计口径见 `references/visual-qa.md`。

## 2. 按需截图

- 用户明确说“看一下/截图/预览” → `ppt_screenshot` 一次。
- 用户只要求审计 → 只跑 `ppt_audit`，不截图。
- 用户要求检查复杂版面且确实不确定 → 最多补一次截图。
- 不要每改一步截一次；截图不是审计的替代品。

## 3. 报告

只报告：检查了哪些页、`pass` 状态、`blocking` 列表、warning 判断、是否截图。不要在本技能内改稿；用户要修时，交给执行技能按报告逐项修。

只有 `pass: true` 才能说“审计通过”；`pass: false` 时明确列出未解决的 error，不要用“判定口径问题”带过。

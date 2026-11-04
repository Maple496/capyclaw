---
name: pptist-authoring
description: 成稿技能：把 deck_brief 映射到内置简洁版式（clean），完成从零成稿；只做映射，不负责叙事、审美或审计。
whenToUse: 已经有方案骨架/大纲（deck_brief），或用户要求做一套新 PPT，需要从骨架落成干净排版时。
---

# PPTist 从骨架到成稿

本技能只负责 **deck_brief → PPTist 版式/工具** 的映射。叙事、设计、工具规则分别由独立技能负责；本技能只消费 `deck_brief` 并产出 deck。

## 前置

1. `ppt_capabilities` 确认 contract 2.x 和 `editorConnected`。
2. 没有 `deck_brief` 时，先由叙事技能产出封面/目录/brief/章节/总结论/行动的结构。
3. 默认 clean 预设已带设计基线；只有用户明确要求审美定制时，才另行加载设计技能。

## 设计 token（仅当本轮加载了设计技能）

设计技能给出 token 时，本技能负责落到工具参数，不重新解释、不新增 token：

1. `accent` / `ink` / `paper`：成稿后调一次 `ppt_style`，传 `theme_colors: [accent]`、`text_color: ink`、`background: paper`。
2. `font_sans`：同一次 `ppt_style` 里传 `font_name`，不要逐页重复设置。
3. `grid` / 字号留白约束：只影响 `layout` 选择和每页要点数量，不产生额外装饰元素。
4. 设计技能没给的维度沿用 clean 预设，不自行补 token。

## 映射

短稿（≤10 页）用 `ppt_deck` + `preset: "clean"` 一次成稿：把封面/章节/要点/结尾排成干净的 7 种页型，不叠装饰图形、不把正文塞进形状。

1. `ppt_deck` 一次传 `title` + `preset: "clean"` + `slides`。`slides` 按 `deck_brief` 展开：
   - 封面 → `{layout:"cover", title, subtitle, kicker?}`
   - 目录 → 不单独出页；直接进章节过渡（必须目录时用 `bullets` 一页列 3–6 项）
   - 每章 → `{layout:"section", title, index}` + 1–2 张内容页
   - 结尾 → `{layout:"end", title, subtitle}`
2. `layout_hint` 映射：

```text
big-number → stat
comparison/two/matrix → two
timeline/bullets/diagram → bullets
statement/quote → quote
```

3. 每页只放一个观点；`bullets` ≤4 条；`detail` ≤50 字。`ppt_fill` 的 slot 包含图形内文字。

## 逐页模式（长 deck 默认）

超过 10 页时，不要一次 `ppt_deck` 注入全部页面：

1. 先写一份**紧凑大纲**：页序、每页 layout、标题、≤4 条短要点；大纲只做指导，不把全文塞进工具参数。
2. 首页用 `ppt_page { layout:"cover", replace:true, ... }` 替换 deck。
3. 之后每页一次 `ppt_page { layout, ... }`，一次只处理当前页；完成后立即 `ppt_task action=checkpoint`，name 用 `page-01`、`page-02`。
4. 每页只保留当前页参数；不要回读整份 deck，不要把前面页的正文带进下一次调用。
5. 单页失败只重试当前页；不要重发整套页面。

## 大稿安全

- 16 页以上：用上面的逐页模式，每页一次 `ppt_page` + 一次 checkpoint；不要回读整份 deck。
- 研究资料先压缩成 3–5 条要点；不要把网页原文、长引文或整段研究笔记塞进 tool 参数。
- 每页完成后丢弃该页的研究笔记和旧参数，只保留大纲与当前页；避免上下文越滚越大。
- 如果模型侧报 `tool input is invalid JSON`：不要原样重发同一个大调用；缩小本次 `slides`/`ops` 后重试一次。

## 阶段落盘

每完成一个阶段（骨架/内容/视觉修正）调 `ppt_task action=checkpoint`，name 用稳定任务名；新会话先 `ppt_task action=status`。中断后从最近 checkpoint `restore`，不要从零重做。

## 成稿后

- 每完成一版立即 `ppt_task action=checkpoint` 落盘。
- 交付说明页数、每章要点；不贴 JSON。
- 审计/截图/审美验收不在本技能内触发；用户明确要求时再由独立验收技能执行。

## 禁止

- 不要在本技能重新解释叙事或设计规则；这些由对应独立技能负责。
- 默认用 `ppt_deck` + `preset: "clean"`，不要另加装饰层。
- 不要逐页 `ppt_element` 搭整套 deck。
- 不要把 5 条以上论据硬塞进一页；拆章，不要缩字号硬挤。

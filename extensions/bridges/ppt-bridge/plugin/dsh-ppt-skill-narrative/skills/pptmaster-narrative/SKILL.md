---
name: pptmaster-narrative
description: 方案叙事架构：SCQA 开场、金字塔结构、一页一观点、判断句标题、证据引用、章首过渡与收束。输出 deck 骨架，不负责 PPTist 工具调用与视觉渲染。
whenToUse: 用户要做方案型/汇报型/提案型 PPT，或要求梳理故事线、目录、章节、页面结构、把资料变成有结论的 deck 时。
---

# PPTMaster 叙事架构

本技能只负责 **内容结构**，不调用 `ppt_*` 工具，也不决定配色与版式。视觉/工具分别交给独立的视觉技能和工具技能。

## 硬纪律

| 纪律 | 对治 |
|---|---|
| **一页一观点**：一页只讲一个核心判断 + ≤4 条支撑论据 | 信息密度爆炸 |
| **消化不罗列**：每条论据挂在判断下，并标来源 | 资料一页页堆 |
| **SCQA 开场**：现状 → 冲突 → 核心问题 | 上来就讲内容 |
| **金字塔**：先顶层结论，再 3–5 个论点（=章节），每章 2–4 页 | 平铺、无结论 |
| **判断句标题**：标题是结论，不是话题词 | “品牌定位” vs “应占据日常可及的专业精品定位” |
| **章章递进**：章首过渡问题，章末收束判断，下一章承接 | 章节硬切 |

## 流程

1. **拆 brief**：目标 / 预算 / KPI / 时间 / YES / NO；提炼真正的根问题。
2. **SCQA**：写 `situation`、`complication`、`question`，顶层主张 `answer`。
3. **金字塔**：把 answer 拆成 3–5 个支撑论点；各章标题连读应能讲通 answer。
4. **切页**：每页写 `governing_thought`（判断句）+ ≤4 条 `points` + `evidence_refs`。
5. **补结构件**：封面、目录、brief 开场、章节过渡、章节收束、总结论、行动页。
6. **自检**：逐条对照硬纪律；结构件缺一不可，判断句标题不能是话题词。

## 输出：deck_brief JSON（内部使用）

```json
{
  "cover": { "title": "方案标题(可含主张)", "subtitle": "客户/项目/日期" },
  "toc": ["第1章 ...", "第2章 ..."],
  "brief_opening": {
    "situation": "现状事实",
    "complication": "变化/矛盾",
    "question": "本方案要回答的那一个核心问题"
  },
  "sections": [{
    "section_no": 1,
    "title": "章节标题",
    "transition_question": "章首引导问题",
    "pages": [{
      "page_no": 1,
      "governing_thought": "完整判断句",
      "points": ["论据1", "论据2"],
      "evidence_refs": ["ind-01", "comp-03"],
      "layout_hint": "big-number|comparison|timeline|matrix|statement|quote|diagram|bullets"
    }],
    "closing_judgment": "本章收束判断"
  }],
  "conclusion": { "governing_thought": "全案顶层结论", "action_items": ["下一步"] }
}
```

把 `deck_brief` 交给成稿技能：它负责选版式、把 `layout_hint` 映射到 PPTist 页型，并调用工具。不要让本技能直接写工具参数。

## 写作

- 用具体细节和数字，不用空洞形容词；不会的数据标“待验证/假设”，不编。
- 简洁、短句、动词；避免“赋能/抓手/闭环/全方位”等黑话。
- 每页标题能单独读懂；读者扫标题能得到完整论证线。
- 详细方法：`references/scqa-pyramid.md`、`references/page-craft.md`、`references/deck-structure.md`。

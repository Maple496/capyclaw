# Deck 结构件与骨架

## 结构件（方案型必备）

```text
封面               标题可直接打核心主张
目录               方案地图（纯创意案可省）
Brief 开场          S 现状 → C 冲突 → Q 根问题（SCQA）
第 N 章 过渡页      用一个问题引出本章
  内容页 ×K         一页一观点
  本章收束判断       本章结论，下一章承接
总结论页            SCQA 的 A / 金字塔顶
行动页             必须做 vs 可以做，给下一步
```

结尾不要只写“谢谢”；回到核心主张或留一句记忆点。

## 页面字段

```json
{
  "page_no": 1,
  "governing_thought": "完整判断句",
  "points": ["论据 1", "论据 2"],
  "evidence_refs": ["ind-01", "comp-03"],
  "layout_hint": "big-number|comparison|timeline|matrix|statement|quote|diagram|bullets"
}
```

硬规则：

- 每页有且仅有一个 `governing_thought`，必须是判断句。
- `points` ≤ 4；超过说明是两个观点，拆页。
- 每个内容页 `evidence_refs` 非空；没有来源的判断标假设或砍掉。
- 章节必须有 `transition_question` 与 `closing_judgment`。

## 简版 / 详版

- 简版 10–15 页：brief → 各章顶层判断 → 总结论 → 行动。
- 详版 20–50 页：每个判断展开论据与推导。

先按详版搭，简版 = 每章只留顶层判断页。

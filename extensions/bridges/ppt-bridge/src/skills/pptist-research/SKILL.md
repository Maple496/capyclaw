---
name: pptist-research
description: 为 PPT 搜集外部资料、数据和配图：用内置 web_search/web_fetch，产出带来源与置信度的分析卡，交给叙事技能消化。
whenToUse: 用户要求基于最新资料、行业数据、竞品信息或外部图片做 PPT，或要求核实事实/引用来源时。
---

# PPT 外部资料研究

## 工具边界

- 研究用 DSH 内置的 `web_search` / `web_fetch`，不要自己写爬虫或调用第三方搜索 API。
- 编辑 deck 仍只用 `ppt_*` 工具。
- 如果 `web_search` 不可见：告诉用户当前 profile 未启用 `dsh-tool-web`，不要假装搜过。

## 产出：分析卡

每条结论写成一张卡，交给叙事技能消费：

```json
{
  "analysis_type": "industry|competitor|self|user",
  "cards": [{
    "id": "ind-01",
    "claim": "判断句（不是现象）",
    "evidence": "含精确数字的论据",
    "source": "url 或本地文件",
    "source_tier": "T1|T2|T3|T4",
    "implication": "对方案的决策含义",
    "confidence": "high|med|low|hypothesis"
  }]
}
```

- T1/T2 优先：官方、一手、可核查；T3/T4 只作补充。
- 每条 `claim` 必须能被 `evidence` 支撑；没有来源就标 `hypothesis`，不要编。
- 不确定的数据写“约/据…”，并在卡片里标置信度。
- 同一指标冲突时，优先官方/更新时间更近的来源，并在交付说明里说明差异。

## 配图

- 优先用户提供的图片（`ppt_image {attachment_id}`）。
- 外部配图两步：`ppt_images { query, count }` 搜索返回直链候选；选中后 `ppt_image { src: url }` 插入（下载+入库由 ppt_image 负责）。
- `ppt_images` 会过滤非图片/小图/下载失败；不要自己 `web_fetch` Bing/百度图片页面找图。
- 不要用 shell 下载图片再传路径，除非用户明确要求本地文件。
- 图片插入后由 `ppt_image` 自校验；不要为了确认图片再截图。

## 交付

说明用了哪些来源、哪些数据是估算、哪些页面引用了外部资料。不要贴大段搜索结果。

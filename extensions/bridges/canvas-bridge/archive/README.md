# archive/ — 退役内容

- **relay-mode/**：旧中转方案。MCP relay（127.0.0.1:39312）经桌面网关桥
  （桌前面前端/backend/bridges/canvas_bridge.py）驱动桌面里的「Canvas 文档」窗口。
  含 server/ 全套、relay 专属测试（smoke/e2e_mcp/stability）与 cordis.patch.yml
  （DSH bundle 补丁）。被 standalone/ 取代（2026-10-26 拆仓批归档）。
  注意：其中对 `./canvas-model.mjs` 的引用已随该文件上提到 `lib/`，复活时需改路径。
- **dead-lib/**：host.mjs，拆仓时已无任何引用方。
- **headless-canvas-v2.mjs**：headless 方案的早期草稿，未被采用。
- **DELIVERY.md / STANDALONE_PLAN.md**：relay→standalone 过渡期的交付报告与设计文档。

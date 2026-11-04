# PPT Bridge 架构（2026-10-30 解耦批）

本文描述 `bridges/ppt-bridge` 的分层、依赖方向与扩展方式。核心目标：**一个能力一个模块、能力正交、可组合、可单独启停、新增能力不碰中央注册表**。

## 1. 分层

```text
┌──────────────────────── MCP transports ────────────────────────┐
│ stdio: src/mcp/index.mjs                                       │
│ HTTP:  plugin/dsh-ppt-workbench/server/mcp/*                   │
└───────────────────────────────┬────────────────────────────────┘
                                │ createRegistry(CAPABILITIES)
┌───────────────────────────────▼────────────────────────────────┐
│ capabilities/  24 个能力模块（一个关注点一个文件）             │
│   contract deck audit task text style element slide apply     │
│   compose recolor image screenshot present history            │
└───────────────────────────────┬────────────────────────────────┘
                                │ 只通过 ctx 端口/服务
┌───────────────────────────────▼────────────────────────────────┐
│ kernel/  define / registry / ports                             │
│   - 校验 id、工具名、requires、dependsOn、provides             │
│   - 派生 TOOLS / TOOL_IMPL / TOOL_META / FEATURES / CAPABILITIES│
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│ core/  纯 deck 域（零 DOM，可 node:test 直测）                 │
│   color / text / deck-layout / audit / ops/*                    │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│ relay: router + routes/* + store/* + runtime/*                 │
│ editor: main + session + runtime + transport/screenshot/ui      │
└────────────────────────────────────────────────────────────────┘
```

## 2. 依赖规则（`test/architecture.test.mjs` 强制）

1. `capabilities/*` 不得 import 另一个 capability；只允许：
   - `../kernel/define.mjs`
   - `../domains/*`
   - `../../../core/*`
   - `node:*` 内置模块（仅 image 的附件读取）
2. 所有 I/O 走 `ctx` 端口：`deck`、`status`、`editor`、`assets`、`task`、`contract`；能力不直接 import `bridge-client`。
3. 跨能力组合只通过声明：
   - `requires`: 依赖的端口/服务命名空间；
   - `dependsOn`: 依赖的能力 id（registry 自动递归启用）；
   - `provides`: 对外提供的服务命名空间（如 `media.insertImage`）。
4. recipe 型工具（`ppt_deck`、`ppt_recolor`）只组合 core 引擎与端口，不复制底层实现。
5. transport 只做协议适配，不含业务语义。

## 3. 能力矩阵

| 能力 | 工具 | 端口/服务 | 依赖能力 |
|---|---|---|---|
| `contract` | `ppt_capabilities` | `status`, `contract` | — |
| `deck` | `ppt_get_deck` | `deck` | — |
| `audit` | `ppt_audit` | `deck` | — |
| `task` | `ppt_task` | `deck`, `task` | — |
| `import` | `ppt_import_pptx` | `deck`, `editor`, `importer` | — |
| `export` | `ppt_export_pptx` | `deck`, `status` | — |
| `text` | `ppt_text`, `ppt_fill` | `deck` | — |
| `style` | `ppt_style` | `deck` | — |
| `element` | `ppt_element` | `deck`, `media` | `image` |
| `slide` | `ppt_slide` | `deck` | — |
| `apply` | `ppt_apply` | `deck` | — |
| `compose` | `ppt_deck`, `ppt_page` | `deck` | — |
| `recolor` | `ppt_recolor` | `deck` | — |
| `image` | `ppt_image` | `deck`, `assets`（provides `media`） | — |
| `imagesearch` | `ppt_images` | `assets` | — |
| `screenshot` | `ppt_screenshot` | `editor`, `status` | — |
| `present` | `ppt_present` | `deck` | — |
| `history` | `ppt_history` | `deck` | — |
| `chart` | `ppt_chart` | `deck` | — |
| `table` | `ppt_table`, `ppt_table_cells` | `deck` | — |
| `notes` | `ppt_notes` | `deck` | — |
| `shape` | `ppt_shape` | `deck` | — |
| `line` | `ppt_line` | `deck` | — |
| `formula` | `ppt_formula` | `deck` | — |

关键边界：

- **图片只有一条实现**：`image` 能力提供 `media.insertImage`；`ppt_element` 的 image 分支调用它，不再有第二套插图校验。
- **文字槽位填充归 text**：`ppt_fill` 与 `ppt_text` 共用 `domains/text-style.mjs`。
- **换色**：`ppt_recolor` 是新编辑器单条 op；旧编辑器回退由 `domains/recolor.mjs` 规划批量 op，亮度/对比色统一来自 `core/color.js`。
- **PPTX 导入是 view op**：`import-pptx` 只在编辑器页面执行（复用 PPTist 原生 `PptApp.importFile` 与 DOM/字体/图片上下文）；服务端 `runBatch` 把它投递到 ui 队列，不解析 OOXML。`mode=replace` 时导入后删除导入前的旧页，`append` 保留。
- **PPTX 导出在 Node 侧**：`domains/pptx-export.mjs` 用 pptxgenjs 把 deck 渲染成 OOXML；自定义 SVG 路径以矩形近似，LaTeX/音视频跳过，降级项写入 `stats.warnings`。

## 4. op 内核（21 个 op / 8 个域）

`src/core/ops.js` 是兼容 facade；真实注册表在 `src/core/ops/index.js`。

| 域文件 | op |
|---|---|
| `deck.js` | `load`, `title`, `theme` |
| `text.js` | `set-text`, `fill-slot` |
| `element.js` | `add-element`, `set-element`, `remove-element` |
| `slide.js` | `set-background`, `add-slide`, `update-slide`, `remove-slide`, `move-slide`, `duplicate-slide`, `select`, `set-notes` |
| `recolor.js` | `recolor` |
| `view.js` | `present`, `exit-present` |
| `history.js` | `undo`, `redo` |
| `playback.js` | `sleep` |
| `chart.js` | `add-chart`, `update-chart` |
| `table.js` | `add-table`, `update-table`, `set-table-cells` |

- `applyOp(P, c, ctx)` 仍保持原签名；`P.snapshot?.()` 语义不变。
- `mutates: false` 的 op 不产生 undo 快照（view/history/playback）。
- 浏览器图片压缩在 `core/ops/browser.js`，由编辑器以 `ctx.media.prepareImage` 注入；Node 侧不 import 该文件。

## 5. relay / store / editor

- `server/relay.mjs`：组合根，只负责解析配置、端口、锁、恢复、组装 router/stop。
- `server/routes/*`：`assets` / `mcp` / `editor` / `bridge` / `health` 五个 URL 家族。
- `server/store/*`：
  - `sanitize` 白名单；
  - `doc` 状态迁移纯函数；
  - `lease` owner 租约；
  - `checkpoints` 命名与读写；
  - `journal` 追加/轮转；
  - `backends/file-backend` 原子落盘；
  - `index` 对外的 `BridgeStore` facade（API 不变）。
- `server/mcp/*`：`handler`（JSON-RPC framing）/ `dispatch`（tools/list、tools/call、参数校验）/ `instructions`（从 capabilities 生成）。
- `editor/main.js`：启动/UI 接线；`session.js`：租约/心跳/轮询/镜像/截图；`runtime.js`：PPTist 装载与导出资产还原。

## 6. 包内目录镜像

`build-plugin.mjs` 把：

```text
src/core       → plugin/dsh-ppt-workbench/core
src/mcp/tools  → plugin/dsh-ppt-workbench/server/tools
src/mcp/*.mjs  → plugin/dsh-ppt-workbench/server/*.mjs
```

因此 capability 文件里的 `../../../core/...` 在源码与包内解析到同一相对位置，不需要路径改写。`server/tools-deps/` 已废弃。

## 7. 契约

- `contract/ops.json`：**op** 契约（envelope + 23 个 op），不再包含工具清单。
- `contract/ppt-contract.json`：**工具 + 能力**契约，构建时生成；包含 `contractVersion`、`toolCount`、`tools[]`（含 `capability`）、`features[]`、`capabilities[]`。
- `CONTRACT_VERSION` 保持 `2.2.0`；`ppt_capabilities` 的 `capabilities` 字段是 additive。
- `serverInstructions` 的能力表由 registry 生成，不再手写工具名。

## 8. 扩展

见 `docs/EXTENDING.md`。一句话：新建 `src/mcp/tools/capabilities/<id>.mjs` 导出一个 `defineCapability(...)`，在 `capabilities/index.mjs` 加一行；构建自动生成 contract、instructions 与 feature。新增 op 则再加一个 `core/ops/<domain>.js` 域文件并登记到 `core/ops/index.js` 与 `contract/ops.json`。

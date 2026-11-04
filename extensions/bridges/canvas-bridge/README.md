# Canvas 文档工作台（canvas-bridge）

> 把「Canvas 文档编辑器」内核接进 MCP/DeepSeek Harness 的独立中间件：
> 16 个 `canvas_*` MCP 工具，面向**长文档生成与精修**。独立仓库、独立运行，
> 不依赖桌面系统。

## 它解决什么

Agent 要写一份文档时，直接操作画布编辑器很难：命令面 150+、元素流是扁平的
`{value:'\n'}` 分隔、样式散落在元素属性上。本包把「用户意图」翻译成编辑器能
稳定执行的最小命令集：

- **块级写作模型**：heading / paragraph / bullet / number / quote / code / divider
  → 元素流（`lib/canvas-model.mjs` 的 `blocksToElements`）
- **一次成稿**：`canvas_write_document` 用一次 `setValue` 替换全文，避免几十次往返
- **分层读取**：summary（摘要+预览）/ text（纯文本）/ doc（完整结构）
- **确定性回执**：每个写工具等 `applied_seq` 追上才返回，Agent 不用自己轮询
- **视觉自检**：`canvas_screenshot` 由编辑器 renderer 出图，不是 DOM 截图
- **文件持久化**：`canvas_open/save/list/export`（standalone 模式新增，JSON 存档 + PDF 导出）

## 快速开始（独立运行）

```bash
npm install            # 唯一运行依赖 playwright（浏览器内核首次会自动下载）
npm test               # 端到端自测：起服务器 → 写文档/表格 → 截图 → 清理
npm start              # stdio 模式（DSH/MCP client 默认接法）
node standalone/server.mjs --http 39313   # HTTP 模式（调试用）
```

编辑器运行时内核在本仓 `runtime/canvas-full-app.js`（自包含，无需桌面仓）。
DSH 接入示例见 [standalone/README.md](standalone/README.md)。

## 架构

```
MCP client (DSH / 任意 stdio|http 客户端)
   └── standalone/server.mjs ──► canvas_* 工具（tools.mjs）
                                  ├── headless-canvas.mjs（Playwright Chromium + runtime/ 内核）
                                  └── storage.mjs（.canvas-docs/ 文档持久化）
```

- **standalone/ 是主路径**：编辑器跑在本仓自带的 headless Chromium 里，
  零桌面依赖、零外部服务。
- **archive/relay-mode 是退役路径**：旧方案经桌面网关桥
  （`桌前面前端/backend/bridges/canvas_bridge.py` + 桌面「Canvas 文档」窗口）
  中转，已被 standalone 取代，仅存档备查。
- 与桌面仓的关系：`runtime/canvas-full-app.js` 与桌面仓
  `backend/system_works/assets/canvas-full-app.js` 同源，桌面侧更新内核后
  拷贝过来同步即可。

## 工具（16 个）

| 工具 | 用途 |
|------|------|
| `canvas_status` | 轻量状态（在线 / seq / 字数） |
| `canvas_read(mode)` | summary / text / doc 三层读取 |
| `canvas_write_document(blocks)` | 一次成稿（整篇替换） |
| `canvas_append_blocks(blocks)` | 末尾追加（续写） |
| `canvas_insert_table(headers, rows)` | 插入表格（表头底色可选） |
| `canvas_insert_image(src, width, height)` | 插入图片（dataURL） |
| `canvas_style(...)` | 当前选区套样式（加粗/颜色/字号/字体/高亮） |
| `canvas_replace_text(find, replace)` | 全文替换（保留样式与结构） |
| `canvas_page_setup(...)` | 纸张 / 方向 / 页边距 / 分页模式 |
| `canvas_screenshot` | 编辑器渲染截图（自检排版） |
| `canvas_history(action)` | 撤销 / 重做 |
| `canvas_clear` | 清空文档 |
| `canvas_open/list/save` | 文档持久化（`.canvas-docs/` 工作区） |
| `canvas_export` | 导出 PDF |

## 目录

```
standalone/   主路径：MCP 服务器 + headless 编辑器 + 存储 + 工具层
lib/          共享模型（canvas-model.mjs：块级写作 → 元素流）
runtime/      canvas-full-app.js（编辑器内核 bundle，自包含）
dsh/          DSH 侧资产（AGENTS.md 提示词）
archive/      退役内容：relay-mode（旧 server/ + relay 测试）、dead-lib、headless 草稿
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CANVAS_RUNTIME` | `runtime/canvas-full-app.js` | 编辑器内核 bundle 路径 |
| `CANVAS_WORKSPACE` | `$(cwd)/.canvas-docs` | 文档持久化目录 |

## 与 PPT 工作台（../ppt-bridge）的差异

| 维度 | PPT | Canvas |
|------|-----|--------|
| 指令 | `{op: ...}` 业务指令（applyOp 解释） | `{cmd, args}` 直通 `CanvasApp.exec` |
| 文档 | `deck`（slides/elements） | `doc`（header/main/footer 元素流） |
| 预览 | renderSlides 拼图 | renderer getDataURL |
| 工具面 | 模板/配色/版式（演示导向） | 块级写作/表格/字数（文档导向） |
| 读取 | `/deck` 全量 | `/text` 纯文本投影（doc 很大时省 token） |

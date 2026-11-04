# Canvas 文档插件独立化方案

## 现状分析

当前架构：
```
DSH Agent → MCP relay (39312) → 桌面网关 (3311) → canvas.works 窗口
                ↓
          canvas-editor 内核 (浏览器)
```

**依赖链**：需要桌面前后端全套运行 + 浏览器打开 Canvas 应用。

---

## 目标架构（参考 pptist）

独立 MCP 服务器：
```
DSH Agent → Canvas MCP Server (本地 HTTP/stdio)
                ↓
           canvas-editor 内核 (Headless/Node)
                ↓
           本地文件存储 / 内存文档
```

**零依赖**：不需要桌面系统，纯 Node.js 进程，可打包成单文件可执行。

---

## 关键技术决策

### 1. 编辑器运行环境

**方案 A：Headless 浏览器（Puppeteer/Playwright）**
- 优点：canvas-editor 原样跑，零改动
- 缺点：体积大（~200MB Chromium）、启动慢（2-3s）、内存高（~150MB/实例）
- 适用：需要完整 DOM + Canvas 渲染（截图必须）

**方案 B：jsdom + 服务端 Canvas（node-canvas）**
- 优点：体积小、启动快
- 缺点：canvas-editor 依赖真实 DOM API，可能需要大量适配
- 适用：只要文档操作，不要截图

**方案 C：提取 canvas-editor 核心逻辑，去 DOM 化**
- 优点：最轻量、最快
- 缺点：需要深度改造上游（不可控）
- 适用：长期方案

**推荐**：先做 **方案 A**（最快验证），体积问题后续用 Playwright 的 `chromium-headless-shell`（~50MB）优化。

### 2. 文档存储

**当前**：桥内存镜像 + 编辑器状态  
**改造**：本地 SQLite 或 JSON 文件
- 每个文档一个 `.canvas.json`（`{header, main, footer, options}`）
- MCP 工具多一个 `file` 参数指定操作哪个文档
- 支持 `new` / `open` / `save` / `close`

### 3. MCP 工具面调整

| 工具 | 当前 | 改造后 |
|------|------|--------|
| `canvas_write_document` | 写当前编辑器 | `canvas_write_document(file, blocks)` |
| `canvas_screenshot` | 编辑器渲染 | Headless 渲染或返回「需 GUI 模式」 |
| `canvas_open` | - | 新增：打开本地 `.canvas.json` |
| `canvas_save` | - | 新增：持久化到文件 |
| `canvas_export` | - | 新增：导出 PDF/DOCX/HTML |

### 4. 打包与分发

参考 pptist 结构：
```
@zcode/canvas-plugin/
├── dist/
│   ├── server.mjs          # MCP 服务器（打包后单文件）
│   └── runtime/            # Playwright + canvas-editor
├── skills/
│   └── canvas/             # Agent 提示词
├── agents/                 # 专用 agent 配置
└── package.json
```

打包工具：esbuild（ESM bundle）+ pkg（可选：Node 二进制）

---

## 实施路线图

### 阶段 1：最小独立服务（1-2 天）

**目标**：不依赖桌面系统，能生成 + 读取文档

1. 拆出 `canvas-bridge/server/{tools,canvas-model,bridge-client}.mjs`
2. 把 `bridge-client` 改为直接操作 Playwright 页面（不走桥）
3. 启动时拉起 Headless 浏览器并注入 canvas-editor
4. 文档存内存，工具改为 `{file, blocks}` 参数
5. 跑通 `write_document` + `read` + `insert_table`

**验收**：
```bash
node canvas-mcp-server.mjs --port 39313
# DSH 连上后能生成文档并读回
```

### 阶段 2：文件持久化 + 导出（1 天）

1. 新增 `canvas_open(file)` / `canvas_save(file)`
2. JSON 文件存储 + 自动保存
3. 导出 HTML（`canvas-editor` 自带 `getHTML()`）
4. 导出 PDF（Playwright `page.pdf()`）

**验收**：生成的文档能保存为 `.canvas.json`，重启后能打开继续编辑

### 阶段 3：截图 + 优化（1 天）

1. `canvas_screenshot` 走 Playwright `page.screenshot()`
2. 按需启动浏览器（首次调用工具时才拉起）
3. 文档池管理（最多 N 个文档同时在内存）
4. 替换 chromium 为 chromium-headless-shell（体积优化）

### 阶段 4：打包 + 分发（0.5 天）

1. esbuild 打包成单文件 `dist/server.mjs`
2. 写 `.zcode-plugin-seed.json`
3. 发布到 DSH 插件仓库
4. 文档 + 示例

---

## 与当前桌面版的关系

**并存策略**：
- 桌面版（`backend/bridges/canvas_bridge.py` + `canvas.works`）：继续维护，面向「可视化编辑」场景
- 独立插件：面向「纯 Agent 生成」场景，不需要人工干预

用户可以：
- 用桌面版打开 `.canvas.json` 可视化编辑
- 用独立插件让 Agent 批量生成文档

---

## 成本估算

- 开发时间：**3-4 天**（含测试）
- 运行时开销：Headless Chromium ~150MB 内存 / ~50MB 磁盘（优化后）
- 启动时间：首次 ~2s（拉起浏览器），后续 ~50ms（复用实例）

---

## 下一步行动

1. **确认方案**：是走 Headless 浏览器（快）还是等我深度重构编辑器内核（慢但最优）？
2. **开工顺序**：我建议先做阶段 1，验证可行性，再决定是否继续打磨。

# Canvas 文档工作台（canvas-bridge）

> 参照 ppt-bridge 插件体系构建的 Canvas 文档工作台：**一个套件 + 一个运行时 + 4 个独立 skill 包**。
> 面向长文档生成与精修——用户说什么，画布就怎么变。复用 dsh-plugin-kit / dsh-document-workbench /
> dsh-suite-kit 公共基建，零重复造轮子。

## 架构（编辑器权威桥）

```
MCP client（dsh / 任意 streamable-http 客户端）
   └── relay :39313 ──► /mcp（22 个 canvas_* 工具）
        │   /api/desktop/works/canvas-bridge…（document-workbench 标准桥协议）
        │   /（编辑器静态页：canvas-full-app 内核 + 会话壳）
        └── 浏览器编辑器页面：claim 租约 → 长轮询 → CanvasApp 执行 → ack → 镜像回推
```

- **authority: 'editor'**：MCP 写指令由 relay 排队，编辑器页面应用后回执；
  工具等到 `applied_seq` 追上才返回（确定性回执，Agent 不用自己轮询）。
- **写路径（确定性优先）**：读镜像 → 纯函数变换（src/core）→ `setValue` 整篇回写；
  结果可在 node:test 直测，不受编辑器光标/选区影响。
- **命令透传**：`canvas_exec` 暴露内核探测出的 103 个已注册命令（白名单），
  分组见 `canvas_commands`；探测真源 `contract/canvas-api.json`。
- **复用基建**：会话/桥路由/编辑器客户端来自 `@capyclaw/document-workbench`；
  服务宿主/工具注册表/资产/编辑器托管来自 shared 快照（dsh-service-host 等 5 个公共插件）；
  skill provider 来自 `dsh-plugin-kit`。

## 快速开始

```bash
npm run build:plugin        # 组装 6 个插件包（workbench + 4 skill + suite）
npm test                    # 46 项单测（模型/契约/store/relay 集成/包结构）
npm run start:workbench     # 起 relay :39313（编辑器 http://127.0.0.1:39313/）
node scripts/e2e-verify.mjs # 端到端：真浏览器 + MCP 全链路（19 项检查）
npm run suite:validate      # dsh-suite-kit 校验套件清单
node scripts/discover-api.mjs --out contract/canvas-api.json  # 重新探测内核能力面
```

## 工具（22 个 / 13 能力）

| 能力 | 工具 | 用途 |
|---|---|---|
| contract | `canvas_capabilities` | 契约版本/工具面/编辑器状态；skill 先调 |
| doc | `canvas_read` / `canvas_write_document` / `canvas_append_blocks` / `canvas_clear` | 分层读取 / 一次成稿 / 续写 / 清空 |
| text | `canvas_replace_text` / `canvas_search` | 全文替换（保样式）/ 搜索定位 |
| element | `canvas_insert_table` / `canvas_insert_image` / `canvas_element` | 表格 / 图片 / 分隔线/分页/列表/按 id 更新 |
| table | `canvas_table` | 单元格文本/底色、行列增删、区域合并（镜像层确定性操作） |
| style | `canvas_style` | 按文本定位套行内样式（加粗/颜色/字号/字体/高亮） |
| page | `canvas_page_setup` | 纸张/方向/边距/分栏 |
| view | `canvas_screenshot` / `canvas_view` | 编辑器 canvas 出图 / 页面模式/缩放/打印 |
| history | `canvas_history` | 撤销/重做（一批 = 一条 undo） |
| audit | `canvas_audit` | 交付前只读审计（blocking/warn） |
| task | `canvas_task` / `canvas_checkpoint` | 批次状态 / 检查点存取恢复 |
| exec | `canvas_exec` / `canvas_commands` | 白名单命令透传（103 条）/ 命令手册 |
| export | `canvas_export` | 结构化 HTML 导出（含下载 URL） |

## 目录

```
contract/        canvas-contract.json（工具契约快照）+ canvas-api.json（内核能力探测）
src/core/        纯域层：blocks（块级写作模型）/ doc（投影）/ commands（白名单）/ audit / html
src/mcp/         工具层：bridge-client + tools/kernel + tools/capabilities（13 能力）
src/editor/      编辑器壳：main/session/transport/ui/screenshot（esbuild → editor/app.js）
src/skills/      4 个技能源（canvas / canvasist-api / canvasist-authoring / canvasist-editing）
plugin/
  capyclaw-canvas-workbench/   运行时包：relay + 编辑器页 + 22 工具 + 契约快照
  dsh-canvas-skill-*/          4 个单 skill provider 包
  capyclaw-canvas-suite/       组合包：dsh-suite.json + composition.lock + 生成的 patch
domains/canvas/  领域包（domain-canvas profile，只加载 Canvas 能力）
scripts/         build-plugin / lint-skills / discover-api / e2e-verify
test/            46 项：model / contract / store / relay（无浏览器集成）/ plugin 结构
standalone/      旧 headless 形态（保留作调试路径；主路径是 plugin 形态）
lib/             兼容 shim：canvas-model → src/core/blocks
runtime/         canvas-full-app.js（编辑器内核 bundle，828KB）
```

## 两种部署形态

| | standalone（旧） | dsh 套件（plugin/，主路径） |
|---|---|---|
| 编辑器 | 本仓 headless Chromium（Playwright） | relay 托管的浏览器页（用户可见、可编辑） |
| 指令执行 | headless 页内 | 同一 relay 桥协议，编辑器权威 |
| MCP | stdio / HTTP 双模式 | streamable-http（relay `/mcp`） |
| 工具 | 16 个（部分不支持） | 22 个（能力化 + 透传 + 审计 + 导出） |

## 桥契约（编辑器权威）

```
GET   /api/desktop/works/canvas-bridge            → 信封 + cmds 队列
POST  /api/desktop/works/canvas-bridge            {title?,cmds} → 入队 seq
POST  …/ack      {seq,applied,error}              → 编辑器回执
POST  …/state    {doc,seq}                        → 镜像回推（防抖 800ms）
GET   …/doc      → {doc,state_seq,applied_seq}    → 工具读取投影
GET   …/watch?seq=&shot=&ui=                      → 长轮询
POST  …/claim|release                             → owner 租约（TTL 10s）
GET|POST …/task/checkpoint(s)                     → 检查点
POST  /api/export  {name,html}                    → 导出落盘 + /exports 下载
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CANVAS_RUNTIME` | `runtime/canvas-full-app.js` | （standalone）内核 bundle 路径 |
| `CANVAS_ASSET` | 同上 | （build）内核 bundle 源 |
| `CANVAS_BRIDGE_HOME` | `~/.dsh-canvas-bridge` | relay 状态目录 |
| `CANVAS_TUNING_JSON` | - | 运行时调优覆盖 |
| `CANVAS_WORKSPACE` | `$(cwd)/.canvas-docs` | （standalone）文档持久化目录 |

## 与 PPT 工作台（../ppt-bridge）的对应

| 维度 | PPT | Canvas |
|------|-----|--------|
| 权威 | server（relay 执行 op） | **editor**（页面执行 cmd 后回执） |
| 写模型 | op 域（applyOp 解释） | 镜像变换 + setValue（+ canvas_exec 透传） |
| 文档 | `deck`（slides/elements） | `doc`（header/main/footer 元素流） |
| 包 | workbench + 8 skill + suite | workbench + 4 skill + suite |
| 复用 | plugin-kit / document-workbench / suite-kit | 同一套（零 fork） |

## 已知约束

- 写工具需要编辑器页面在线（编辑器权威）：错误信息会给出编辑器地址。
- 镜像写（read-modify-write）与人工编辑并发时存在 800ms 防抖窗口内的竞态；
  大改前用 `canvas_checkpoint save` 存档。
- 内核（canvas-full-app.js）与桌面仓同源；升级内核后重跑
  `node scripts/discover-api.mjs` 对账命令面，再跑 `npm run build:plugin`。

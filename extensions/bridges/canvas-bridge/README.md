# Canvas 文档工作台（canvas-bridge）

> 参照 ppt-bridge 插件体系构建的 Canvas 文档工作台：**一个套件 + 一个运行时 + 4 个独立 skill 包**。
> 面向长文档生成与精修——用户说什么，画布就怎么变。复用 @capyclaw/plugin-kit / @capyclaw/document-workbench /
> @capyclaw/suite-kit 公共基建，零重复造轮子。构建流程调用仓库级 `scripts/lib/bridge-build.mjs`，本 bridge 只声明差异配置。

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
  skill provider 来自 `@capyclaw/plugin-kit`。

## 快速开始

```bash
npm run build:plugin        # 组装 6 个插件包（workbench + 4 skill + suite）
npm test                    # 55 项单测（模型/契约/store/relay 集成/稳定性/包结构）
npm run start:workbench     # 起 relay :39313（编辑器 http://127.0.0.1:39313/）
node scripts/e2e-verify.mjs # 端到端：真浏览器 + MCP 全链路 + 性能预算（22 项检查）
node scripts/bench.mjs      # 交互实时性基准（小/大文档/并发/管线，p50/p95/max）
npm run suite:validate      # @capyclaw/suite-kit 校验套件清单
node scripts/discover-api.mjs --out contract/canvas-api.json  # 重新探测内核能力面
```

## 交互实时性（bench 实测，本机 headless Chromium）

| 指标 | 基线 | R1 调优 | R2 管线重构 | R2 手段 |
|---|---|---|---|---|
| 写工具（write/append/replace/style）p50 | 110ms | 63ms | **9-11ms** | 进程内直连 + 回执事件唤醒 |
| canvas_insert_table p50 | — | 65ms | **18ms** | 同上 |
| canvas_screenshot p50 | 319ms | 128ms | **37ms** | 截图等待事件唤醒（status-first） |
| 读类（summary/text/audit/capabilities）p50 | 2-4ms | 2-5ms | **1-2ms** | /view 投影按镜像引用 memo |
| 大文档（33KB 镜像）append p50 | 354ms | 323ms | **274ms** | 进程内镜像直读；地板=内核页内 reload |
| 大文档（33KB 镜像）replace p50 | — | 268ms | **216ms** | 同上 |
| 管线地板（HTTP push→applied）p50 | 63ms | 63ms | **33ms** | watch 事件唤醒（原 75ms 轮询粒度） |
| 5 路并发追加（整批） | ~~87ms~~ | 533ms | **162ms** | 单条管线 63→32ms（写互斥保留） |

> 旧值 ~~87ms~~ 是丢批次 bug 的假快；写互斥后串行化是正确性优先。

R2 优化手段（对齐 pptist「轻量读取 + 即时回执」方向，公共库 document-workbench 0.2.0 同步升级）：

- **watch 事件唤醒**：`DocumentSession` 新增 `subscribe`/`waitForChange`，push/ack/state/
  shot 变更即时唤醒挂起的长轮询与等待方——75ms 轮询粒度不再进入延迟路径（pollMs 保留兜底）。
- **进程内直连**：MCP 工具与 relay 同进程时注入 store（`setLocalSession`）——镜像读
  `structuredClone` 直取、回执等待事件唤醒，回环 HTTP + 全量 JSON 序列化双双消失；
  stdio MCP 等独立形态自动回退 HTTP。
- **响应轻量化**：`/watch` 只回编辑器消费的协议字段（旧：整个信封含全量镜像+截图
  base64）；push/ack/state/shot 的 POST 响应同步瘦身——大文档每批次省数 MB 往返。
- **status/health/metrics O(1) 摊销**：words 等投影按镜像引用 memo（镜像只在编辑器
  /state 推送时整体替换，引用不变即复用）。
- **新鲜度判定修正**：`applied_seq>0 且 state_seq 落后` 即追赶中——进程内直连快到
  「回执后纳秒级读镜像」，旧判定的 `state_seq>0` 守卫会误放行空镜像。

R1 及既有设计：

- **追加族零读直推**：append_blocks / insert_table / insert_image / element(结构)
  推单条 `appendElementList` 指令，不读镜像——延迟与文档大小脱钩。
- **heading → 内核真标题**：块模型把 heading 编译成 `{type:'title', level:'first'..'sixth'}`
  包装元素，内核展平后挂 titleId/level —— 编辑器目录（大纲导航）由此构建，
  字号(26/24/22/20/18/16)与加粗由内核按级应用，与用户手工插入的标题完全同形。
  行模型：换行只由 value 内 `\n` 决定，title 自带起行，正文行以 `\n` 开头。
- **用户编辑回推**：编辑器壳双通道订阅（门面 `change` + 内核 `eventBus contentChange`），
  用户在页面里手工键入/删改经 800ms 防抖回推镜像 —— agent 的读工具能看到用户改动，
  协作回路双向打通。
- **/view 轻量投影**：summary/text/outline 在 relay 侧从镜像计算，读路径只回传
  小结果；自带 seq/state_seq 新鲜度重试（编辑器先回执后推镜像，不会读陈旧）。
- **写互斥**：编辑器权威下 cmds 队列会被下一次 push 覆盖，并发 push 丢批次；
  bridge-client 进程内互斥（推 N+1 前等 N 回执）彻底关闭竞态（stability 回归覆盖）。
- **getDocOnly 先 status 后 doc**：等镜像追上用廉价 /status，全量 /doc 只拉一次。
- **版本化静态入口**：`/app-v*.js` + `/open.html` 绕过浏览器强缓存（对齐
  dsh-editor-host 模式）。
- 调优参数集中在 `src/mcp/tuning.mjs`（`CANVAS_TUNING_JSON` 可覆盖）。


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
  capyclaw-canvas-skill-*/          4 个单 skill provider 包
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

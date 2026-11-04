# capyclaw-ppt-workbench（PPT 工作台运行时）

DeepSeek Harness 插件：PPTist 运行时 + 工具面。**普通用户请装 `dsh-ppt-suite`**；
本包是套件里的运行时子包，也可单独安装用于调试。

- **27 个 `mcp__ppt__*` 工具**：导入 PPTX（`ppt_import_pptx`，编辑器原生转换）/ 导出 PPTX（`ppt_export_pptx`，pptxgenjs）/ 图表（`ppt_chart`）/ 表格（`ppt_table`）/ 数学公式（`ppt_formula`）/ 形状库（`ppt_shape`）/ 线条（`ppt_line`）/ 演讲备注（`ppt_notes`）/ 契约探测（`ppt_capabilities`）/ 读 deck / **确定性审计（`ppt_audit`）** / 改文字样式 /
  一键换色 / 元素页管理 / 插图（自动压缩+自校验）/ 简洁版式成稿（`ppt_deck`）/ 放映 / 撤销重做 / 截图。
- **浏览器实时编辑器**：`http://127.0.0.1:39311/`（本机 relay 托管，装完即有）。
  agent 的每一步修改实时出现在页面里；可本地快捷指令、导出 PPTX、放映。
- **本机桥**（127.0.0.1:39311）：agent（MCP）与编辑器之间的指令/回执/镜像/
  截图通道。**不依赖任何桌面系统**，一条 dsh 会话 + 一个浏览器标签页即可工作。

## 安装

前置：本机装有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh ≥ 0.2）
与 pnpm（插件安装经 pnpm 拉包）。插件本体**零构建脚本**；运行时依赖只有
`@capyclaw/document-workbench` 与纯 JS 的 `pptxgenjs`（PPTX 导出），安装不会触发
构建脚本审批。

```bash
# 推荐：通过套件安装（同时获得 workbench + skills）
dsh plugin --profile <你的profile> install /path/to/dsh-ppt-suite

# 只调试运行时：单独安装本包
dsh plugin --profile <你的profile> install /path/to/capyclaw-ppt-workbench

# 也可以走 Web 界面：侧边栏「插件」页 → 安装 → 填本地路径 / git 地址
```

装好后（无 HMR 的 profile 需重启会话），工具组 `mcp__ppt__*` 出现在 agent
工具清单里；同时本机 39311 端口的桥随之就绪（由插件内置宿主在进程内拉起，
dsh 关闭时自动停止）。

## 使用

1. 浏览器打开 **http://127.0.0.1:39311/** —— 页面显示即可用（打开即连接，无需任何操作）。
2. 在 dsh 会话里直接说需求，例如：
   - 「用都市蓝调做一套 Q4 销售规划的 PPT，封面写 XXX」
   - 「把背景改成天蓝色」「第 2 页标题换成 X」「加一页介绍 Y」「整体换成深色系」
   - 「插入这张图」（聊天里贴图，用 `ppt_image` 附件通道）
3. agent 的改动实时出现在编辑器页；说「看一下效果」会用 `ppt_screenshot`
   回传全页拼图。
4. 收尾在编辑器页点「导出 PPTX」。

多开标签页时后打开者自动成为活动页（内部租约仲裁，静默切换，无任何提示）。

## 运行时架构（三件）

| 件 | 位置 | 说明 |
|----|------|------|
| 宿主插件 | `lib/host.mjs` | cordis 入口：进程内拉起 relay，disposer 随插件停用关闭 |
| relay 组合根 | `server/relay.mjs` | 只保留 PPT 业务装配；端口/锁/复用/健康/指标/静态由 `dsh-service-host` 提供 |
| 公共插件快照 | `server/shared/*` | `dsh-service-host` / `dsh-tool-host` / `@capyclaw/state-service` / `dsh-asset-service` / `dsh-editor-host`；仅独立运行时回退，state 快照只服务 file backend |
| 路由 | `server/routes/*` | assets / mcp / editor 走公共插件；bridge 是 PPT 专属协议 |
| 存储 | `server/store/*` | `doc/lease/sanitize` 是 PPT 业务；journal/checkpoint/file backend 使用 vendored 的 state-service 库代码，不依赖 `ctx.state` |
| MCP 协议 | `server/mcp/*` | 协议壳/分派来自 `dsh-tool-host`；instructions 只放 PPT 文案 |
| 工具面 | `server/tools/*` | 构建期从 `src/mcp/tools` 拷贝：kernel + domains + 15 个 capability |
| 领域核心 | `core/*` | 构建期从 `src/core` 拷贝：ops 域、color、text、layout、audit |
| 编辑器 | `editor/` | PPTist 运行时（打补丁版）+ 工作循环（自动连接/长轮询/应用/回执/镜像/自截图） |

工具实现（`server/tools.mjs`）由上游工程 `ppt-bridge/src/mcp/` 构建期拷贝——
**不要手改包内拷贝**，改上游后重跑 `node scripts/build-plugin.mjs`。
能力清单与扩展方式见仓库 `docs/ARCHITECTURE.md` / `docs/EXTENDING.md`。

配套包：

- `capyclaw-ppt-skill-*`：8 个单 skill 包，每个独立版本、独立评测；
- `dsh-ppt-suite`：组合入口，普通用户只装它。

## 契约（2.2）

- `ppt_capabilities` 返回 `contractVersion`、`packageVersion`、`toolCount`、
  工具清单（name/kind/since/capability）、`features`、`capabilities`（id/title/tags/tools）
  和 `editorUrl`。
- `contract/ppt-contract.json` 是构建时快照；工具/能力清单由
  `src/mcp/tools/capabilities/*` 经 registry 派生，`src/mcp/contract.mjs` 只保留版本与报告格式。
- 工具名/参数/返回结构发生不兼容变化 → contract major +1；8 个 skill 包的 major 必须同步。
- `capyclaw-ppt-skill-*` 不 import 本包代码，只通过 `ppt_capabilities` 检查兼容性。

## 运行时接口

- `GET /healthz`：版本、contract、端口、deck 页数、编辑器连接、seq/state、uptime。
- `GET /metrics`：Prometheus 文本指标（up/uptime/slides/seq/editor_connected/memory）。
- `GET /ui`：页面级命令队列（present/select/exit-present）。
- `GET /task/status`、`/task/checkpoints`、`POST /task/checkpoint`：任务进度与命名 checkpoint。
- MCP 调用会先按 `inputSchema` 校验参数；非法参数返回 `isError`，不再进实现。
- 编辑器顶栏：状态点、临时提示、本地快捷指令、导出 PPTX / 保存 JSON / 放映。
- 服务只绑定 `127.0.0.1`，并带 `nosniff` / `no-referrer` / `no-store` 响应头。

## 持久化与恢复

- `~/.dsh-ppt-bridge/state.json`：deck 权威状态，原子落盘。
- `~/.dsh-ppt-bridge/journal.jsonl`：每次 push/applied/checkpoint 的追加日志，2MB 自动轮转。
- `~/.dsh-ppt-bridge/checkpoints/`：`ppt_task checkpoint` 保存的 deck 快照。
- 启动时若 `seq > applied_seq`，自动重放未完成批次。

## 端口与发现

- 首选端口 **39311**（patch 里的 MCP URL 是静态常量）。被占时：若占用者
  是本桥旧实例则直接复用；否则向后扫描最多 50 个端口，实际地址写入
  `~/.dsh-ppt-bridge/bridge.json`（编辑器同源无感；此时 MCP 需重启会话后
  由新 relay 占用 39311）。
- 想换端口/目录：在 profile patch 里覆写 `ppt-workbench-host` 行的
  `config: { port, hostDir }`。
- 想按 profile 选择能力：加 `config: { capabilities: ['text', 'image', ...] }`；
  `dependsOn` 会自动带上依赖能力，缺省为全部 15 个。

## 也可脱离 dsh 独立运行（调试/演示）

```bash
node server/relay.mjs [--port 39311]   # 桥 + 编辑器 + MCP 一并拉起
```

## 已知约束

- MCP 固定连 `http://127.0.0.1:39311/mcp`；39311 被外部应用长期抢占时工具
  不可用（工具结果会提示），属可接受降级。
- `ppt_image` 的聊天附件按 `$DSH_HOME/attachments/v1/objects` 解析；跨机器
  贴图请重新粘贴。
- 默认走内置 clean 简洁版式，不依赖外部样式；更换新版 PPTist 后重跑
  `build-plugin.mjs` 即可。

## 许可

AGPL-3.0-or-later。编辑器运行时基于 [PPTist](https://github.com/pipipi-pikachu/PPTist)
（AGPL-3.0），详见 `THIRD_PARTY_NOTICES.md`。

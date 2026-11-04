# @capyclaw/canvas-suite（Canvas 文档工作台套件）

一键安装的入口包。内部包含 Canvas 编辑器运行时、4 个独立 skill 包、4 个公共基建插件和文档工作台框架，套件负责锁定兼容版本。

```text
capyclaw-canvas-suite
├─ @capyclaw/service-host        公共基建：HTTP 宿主/健康/指标/锁/复用
├─ @capyclaw/tool-host           公共基建：能力 DSL/注册表/契约/MCP
├─ @capyclaw/asset-service       公共基建：sha256 对象资产/`/assets`
├─ @capyclaw/editor-host         公共基建：编辑器托管/租约/心跳
├─ @capyclaw/document-workbench  文档框架库：会话/命令/桥路由/编辑器客户端（非 row）
├─ @capyclaw/canvas-workbench    运行时：relay + editor + 22 个 canvas_* MCP 工具
├─ @capyclaw/canvas-skill-canvas     路由
├─ @capyclaw/canvas-skill-api        工具手册
├─ @capyclaw/canvas-skill-authoring  成稿
└─ @capyclaw/canvas-skill-editing    纯执行
```

安装后 4 个公共插件作为独立 row 出现在 profile 中；本套件通过 `components`
引用它们自己的 suite manifest，不复制 packages/rows。`@capyclaw/canvas-workbench`
优先通过 `ctx.serviceHost` / `ctx.toolHost` / `ctx.assets` / `ctx.editorHost`
使用它们，独立运行时再回退到 `server/shared` 快照。

relay 不 insert 进 dsh 进程：`services.json` 声明 `canvas-workbench` 服务，
由 dsh-service-broker 以独立进程拉起（编辑器权威桥，streamable-http `/mcp`）。
Canvas 的文档状态由 `server/store/*` + `@capyclaw/document-workbench` 直接落盘，
不依赖 `ctx.state`，因此套件不安装 `@capyclaw/state-service`。

组合层是标准件 `@capyclaw/suite-kit` 的实例：

- `dsh-suite.json` 是唯一真源（packages / rows / checks / 端口 / 能力）；
- `cordis.patch.yml` 由 manifest 生成，不手写；
- 安装、组合、doctor 都用同一套 CLI。

## 安装

```bash
# 本地开发（在 extensions/bridges/canvas-bridge 下执行）：
npm run build:plugin && npm run suite:validate

# 消费侧（dsh 环境）：
# 经 registry 或 zip 源安装本套件，一键获得上述全部包
```

# 公共插件架构

> 目标：功能插件只写业务；宿主、工具面、状态、资产、编辑器全部由公共插件提供。

## 分层

```text
功能插件（业务）
  ├─ tools/ + impl/ + editor/ + skills/
  ├─ lib/host.mjs（生命周期）
  └─ server/relay.mjs（业务装配，~60-80 行）
        │
        ├─ 同进程：ctx.serviceHost / ctx.toolHost / ctx.state / ctx.assets / ctx.editorHost
        └─ 独立分发：server/shared/* 公共插件源码快照
              │
              └─ @capyclaw/plugin-kit（底层协议/传输/存储算法）
```

## 公共插件

| 包 | ctx 服务 | 职责 | 不负责 |
|---|---|---|---|
| `@capyclaw/service-host` | `ctx.serviceHost` | HTTP 路由、`/healthz`、`/metrics`、静态资源、单实例锁、端口复用、discovery、优雅关闭；standalone/embedded 双模式 | 业务状态、工具、资产 |
| `@capyclaw/tool-host` | `ctx.toolHost` | `defineTool`/`defineCapability`、能力注册表、参数校验、契约报告、MCP 协议壳、instructions 模板 | HTTP 监听、业务实现 |
| `@capyclaw/state-service` | `ctx.state` | 原子状态、journal（2MB 轮转）、命名 checkpoint、崩溃恢复 | work 文件归属（属于 workspace） |
| `@capyclaw/asset-service` | `ctx.assets` | sha256 对象仓库、`/assets/<id>`、base64 上传、content-type | 作品目录、版本 |
| `@capyclaw/editor-host` | `ctx.editorHost` | 编辑器静态托管、租约仲裁、心跳、连接状态 | 编辑器业务 UI |

## 文档工作台框架

`@capyclaw/document-workbench` 是纯库（无 `ctx.*`、无端口、无 service row），把编辑器类插件反复实现的协议层抽出来：

| 子路径 | 职责 |
|---|---|
| `session` | `DocumentSession`：seq/命令队列/ack/state/ui/shot/owner lease/checkpoint/recover |
| `ops` | `defineOp` / `createOpRegistry`：op 元数据、snapshot 策略、未知指令 |
| `bridge` | `createDocumentBridge`：push/read/watch/task/claim/state/shot 端点族 |
| `client` | `createEditorClient`：浏览器端 claim/心跳/长轮询/镜像/应用/截图请求 |
| `screenshot` | contact sheet 合成 |
| `testing` | 内存 backend、fake adapter、一致性测试工具 |

PPT 是第一个消费者；`capyclaw-ppt-workbench` 的 `server/store`、`server/routes/bridge`、`server/runtime/{watch,recovery}`、`core/ops`、`src/editor/session.js` 都已改为调用该框架。其他编辑器插件只需提供 `documentKey`、领域文档、op 实现和浏览器 adapter，不再复制桥协议。

## 新插件标准形态

```text
dsh-my-plugin/
├─ package.json
├─ cordis.patch.yml
├─ dsh-suite.json
├─ lib/host.mjs              # ~20 行
├─ server/
│  ├─ relay.mjs              # ~60-80 行，只装配业务
│  ├─ tools.mjs              # defineTool / defineCapability / createRegistry
│  ├─ impl.mjs               # 业务
│  └─ shared/                # 公共插件 + kit 快照（生成）
├─ contract/
├─ editor/                   # 可选
└─ skills/                   # 可选
```

生成方式：

```bash
cd plugin-development
node create-plugin.mjs --name dsh-my-service --type service --port 39500 \
  --out ./my-plugins --domain my-service --yes
```

编辑器类插件在公共插件之上再加 `@capyclaw/document-workbench`：不要复制 PPT 的 `server/store`、`server/routes/bridge`、`src/editor/session.js`，只实现领域文档、op、HTTP 投影和浏览器 adapter。

更新公共插件快照：

```bash
node scripts/sync-shared.mjs --out <plugin>/server/shared --force
node scripts/sync-shared.mjs --out <plugin>/server/shared --check
```

## API 契约

每个 `ctx.*` 服务都必须带 `api`：

```js
ctx.serviceHost = {
  api: { name: 'serviceHost', version: '1.0.0', capabilities: ['http', 'static', 'health', ...] },
  createApp,
  createSharedHost,
}
```

消费者在注入时校验 major：

```js
import { assertServiceApi } from '@capyclaw/plugin-kit/service/api'
assertServiceApi(ctx.serviceHost, { name: 'serviceHost', major: 1 })
```

公共插件的 `package.json` 同时声明 `dsh.apiVersion`，`server/shared/SHARED_MANIFEST.json` 记录该版本和源码 hash。

## 组合方式

`dsh-ppt-suite` 不再复制公共插件的 packages/rows，而是用 `components` 引用它们自己的 suite manifest：

```json
"components": [
  "../../../../packages/capyclaw-service-host",
  "../../../../packages/capyclaw-tool-host",
  "../../../../packages/capyclaw-state-service",
  "../../../../packages/capyclaw-asset-service",
  "../../../../packages/capyclaw-editor-host"
]
```

`loadSuiteManifest()` 会展开 components，并把组件行排在功能插件行之前，保证 `ctx.*` 先就绪。
`scripts/check-suite-drift.mjs` 检查两边元数据不漂移。

## 共享宿主与原生工具

- `ctx.serviceHost.createSharedHost()`：多个功能插件共用一个 HTTP server / 端口，按 `/plugins/<id>` 前缀分发。
- `ctx.toolHost.registerWithDsh(ctx, registry)`：把能力直接注册到 DSH 原生 `ctx.tools`，不再需要每个插件一条 MCP row。
- `ctx.assets.mount(hostApp)`：每个宿主 app 只挂一次 `/assets` 路由。

## 版本与依赖

- 公共插件 `package.json` 声明 `@capyclaw/plugin-kit` 依赖，源码使用包名 import。
- 本地开发执行 `node scripts/link-workspace.mjs` 建立仓库根 `node_modules` junction；发布时由 npm 正常安装。
- `dsh-ppt-suite` 版本 `2.3.0`，`composition.lock.json` 记录实际解析到的包版本和 apiVersion。

## PPT 的两种运行形态

- **DSH 内（当前套件安装）**：`dsh-ppt-suite` 的 packages/rows 包含 5 个公共插件；
  `capyclaw-ppt-workbench` 通过 `ctx.serviceHost` / `ctx.toolHost` / `ctx.state` / `ctx.assets` / `ctx.editorHost` 使用它们。
- **独立运行/打包**：`capyclaw-ppt-workbench/server/shared/` 保留公共插件源码快照，无 DSH 时自动回退。
- 升级公共插件后，运行 `node scripts/sync-shared.mjs --out bridges/ppt-bridge/plugin/capyclaw-ppt-workbench/server/shared --force`，
  再跑 `node bridges/ppt-bridge/scripts/build-plugin.mjs` 和全量测试。

## PPTist 抽取映射

| 原模块 | 去向 |
|---|---|
| `server/relay.mjs` 的端口/锁/复用/静态/关闭 | `@capyclaw/service-host` |
| `server/router.mjs`、`routes/health.mjs`、`runtime/metrics.mjs` | `@capyclaw/service-host` |
| `server/mcp/handler.mjs`、`dispatch.mjs`、`validate.mjs` | `@capyclaw/tool-host` |
| `server/tools/kernel/{define,registry}.mjs` | `@capyclaw/tool-host` |
| `server/contract.mjs` 的报告结构 | `@capyclaw/tool-host` |
| `server/store/backends/file-backend.mjs`、`runtime/recovery.mjs` | `@capyclaw/state-service`（backend）/ `@capyclaw/document-workbench/session`（recover） |
| `server/store/{doc,index,sanitize,lease,checkpoints}.mjs` | `@capyclaw/document-workbench/session` |
| `server/routes/bridge.mjs`、`server/runtime/watch.mjs` | `@capyclaw/document-workbench/bridge` / `session` |
| `core/ops/*` | `@capyclaw/document-workbench/ops` |
| `src/editor/session.js`、`src/editor/screenshot.js` | `@capyclaw/document-workbench/client` / `screenshot` |
| `server/routes/assets.mjs`、`lib/host.mjs` 的 assetStore | `@capyclaw/asset-service` |
| `server/routes/editor.mjs`、编辑器租约 | `@capyclaw/editor-host` |
| `core/*`、`server/tools/capabilities|domains`、`ppt-shim`、`bridge-client` | 保留（PPT 领域） |
| `editor/ppt-full-app.js` | 保留（PPTist AGPL 编译产物，不能进 MIT 公共包） |

## 许可证边界

- 公共插件默认 MIT。
- PPT 的 `lib/`、`server/`、`editor/app.js` 当前按 AGPL-3.0-or-later 分发；从中抽取通用代码到 MIT 包前需确认原创版权与再许可。
- PPTist 前端编译产物（`editor/ppt-full-app.js`）只能留在 AGPL 包内。

## 版本化安装与回滚

公共插件可以打包成本地 artifact，并按精确版本安装：

```bash
# 打包公共插件（默认 ~/.dsh-store/artifacts，可用 DSH_ARTIFACT_STORE 覆盖）
node scripts/artifact-store.mjs pack --all
node scripts/artifact-store.mjs list

# 安装时覆盖某个包的版本
node bridges/ppt-bridge/scripts/install-plugin-suite.mjs \
  --profile web --package @capyclaw/state-service@0.1.0

# 按 profile 的历史组合锁回滚
node bridges/ppt-bridge/scripts/install-plugin-suite.mjs \
  --profile web --rollback-to ~/.dsh/profiles/web/dsh-composition.lock.json.bak-<时间>
```

`installSuites` 会：
- 解析 `name@version` 到 artifact store；
- 把实际版本写入 `dsh-composition.lock.json`；
- 对比旧 lock，报告 `updated` / `api-major` / `suite-updated`；
- `--rollback-to` 逐包解析历史版本并重新安装。

## 单模块演化探针

```bash
node scripts/module-probe.mjs state
node scripts/module-probe.mjs asset --health-url http://127.0.0.1:39311
node scripts/module-probe.mjs all
```

探针先跑模块自己的测试，再可选抓取运行时 `/healthz`；适合独立优化时快速看影响面。

## 状态与租约边界

- `ctx.workspace` 管作品文件（work manifest / 版本 / 归属）；`ctx.state` 管插件运行状态（doc / journal / checkpoint / recovery）。两者不要同时写同一份 `state.json`。
- PPT 的 `server/store/lease.mjs` 是 **deck owner 租约**（谁在操作这份 deck）；`ctx.editorHost.lease` 是 **编辑器标签页租约**（哪个浏览器页面是活动页）。语义不同，不要混用。
- PPT 当前使用 workspace backend 存 deck；`ctx.state` 主要用于没有 workspace-service 的独立运行/测试。

## 非目标

- `@capyclaw/suite-kit`、`create-plugin`、`pack-build` 是构建期工具，不做运行时插件。
- `@capyclaw/plugin-kit` 的纯函数不做插件，保留为库。
- `@capyclaw/document-workbench` 只抽协议/会话/客户端框架；deck ops、布局、审计、PPTist bundle 仍属 PPT 领域，不因框架抽取而上移。

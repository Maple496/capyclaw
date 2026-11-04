# DSH 插件开发指南

本文是当前唯一开发指南。旧的独立服务器/侧边栏方案已废弃；新插件统一走 **Cordis 插件 + loopback 服务 + MCP 工具 + suite/domain**。

## 1. 插件是什么

一个 DSH 插件包至少包含：

```text
my-plugin/
├── package.json          # main / dsh.bundle.patch / meta / files
├── cordis.patch.yml      # 注册到 Harness 的 row
├── lib/host.mjs          # cordis 入口：apply(ctx, config) -> disposer
└── README.md
```

需要给 AI 提供工具时，再加：

```text
server/
├── relay.mjs             # 业务装配（~60 行）
├── tools.mjs             # 能力 DSL + 注册表
├── impl.mjs              # 业务实现
└── shared/               # 公共插件 + kit 的构建期快照
contract/my-contract.json # 契约快照（推荐）
test/plugin.test.mjs      # 冒烟测试
```

需要用户界面时，再加 `editor/`，由 `dsh-editor-host` 静态托管。

**公共插件**（通过 `ctx.*` 注入，功能插件零成本接入）：

| 服务 | 插件 | 用途 |
|---|---|---|
| `ctx.serviceHost` | `dsh-service-host` | HTTP、健康、指标、锁、复用、静态 |
| `ctx.toolHost` | `dsh-tool-host` | 能力 DSL、注册表、校验、契约、MCP |
| `ctx.state` | `dsh-state-service` | 状态、journal、checkpoint、恢复 |
| `ctx.assets` | `dsh-asset-service` | sha256 对象资产、`/assets` |
| `ctx.editorHost` | `dsh-editor-host` | 编辑器托管、租约、心跳 |

## 2. 生命周期

`lib/host.mjs` 的职责只有启动和关闭：

```js
export const name = 'my-service-host'

export async function apply(ctx, config) {
  const service = await startService({
    port: Number(config?.port) || 39500,
    hostDir: config?.hostDir,
  })
  return async () => {
    await service.stop()
  }
}
```

不要在 `host.mjs` 里写业务逻辑，也不要在模块顶层启动服务。`apply` 返回的 disposer 必须能关闭服务、释放锁。

## 3. 用脚手架生成

```bash
cd plugin-development
node create-plugin.mjs --help
```

最常用：

```bash
node create-plugin.mjs \
  --name dsh-my-service \
  --type service \
  --title "My Service" \
  --port 39500 \
  --out ./my-plugins \
  --domain my-service \
  --yes
```

类型：

| 类型 | 生成内容 | 适用 |
|---|---|---|
| `service` | 插件 + suite + domain，带 MCP 工具 | 大多数服务接入 |
| `ui` | 在 service 基础上增加 `editor/` | 需要可视化界面 |
| `minimal` | 只有 host 生命周期，不生成 suite/domain | 纯进程内插件 |

## 4. 工具与 MCP 契约

每个工具必须有稳定的 `name`、`inputSchema` 和返回形状。所有调用在 `dsh-plugin-kit` 的 `createMcpHandler` 里先经过 `validateToolArguments`。

推荐每个服务暴露一个只读探测工具：

```js
{
  name: 'my_service_capabilities',
  description: '返回契约版本、工具清单和能力说明',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} }
}
```

返回 JSON 至少包含：

```json
{
  "name": "dsh-my-service",
  "version": "1.0.0",
  "contractVersion": "1.0.0",
  "tools": ["my_service_echo", "my_service_capabilities"]
}
```

suite 的 `checks` 用 `contract` 类型调用这个工具并校验 major 版本。

## 5. 服务契约

每个服务型插件必须满足：

| 端点 | 要求 |
|---|---|
| `GET /healthz` | `{ ok, name, version, contractVersion, uptimeSec, port }` |
| `GET /metrics` | Prometheus 文本，至少 `<slug>_up`、`<slug>_uptime_seconds` |
| `POST /mcp` | MCP Streamable HTTP；只支持 POST |
| 绑定地址 | `127.0.0.1` |
| 单实例 | 由 `dsh-service-host` 统一处理 |
| 关闭 | 由 `dsh-service-host` 统一处理 |

## 6. 使用公共插件

新插件不要重复实现 HTTP/MCP/锁/校验/状态/资产/编辑器。脚手架会自动把公共插件源码快照到 `server/shared/`：

```bash
node scripts/sync-shared.mjs \
  --out ./my-plugins/my-plugin/server/shared --force
```

导入方式：

```js
import { createServiceApp } from './shared/service-host.mjs'
import { defineTool, createRegistry } from './shared/tool-host.mjs'
import { createFileBackend, replayPending } from './shared/state-service.mjs'
import { createAssetRoutes } from './shared/asset-service.mjs'
import { createEditorHost } from './shared/editor-host.mjs'
```

同进程插件也可以直接 `inject: ['serviceHost', 'toolHost', 'state', 'assets', 'editorHost']`，由 DSH 加载公共插件，不需要快照。

公共插件版本升级后，重跑 `scripts/sync-shared.mjs`，并把 `server/shared/SHARED_MANIFEST.json` 一起提交，保证插件可独立分发。

## 7. suite 与 domain

- **plugin**：真正干活的包。
- **suite**：一组插件 + 注册 row + health/contract check，是安装单位。
- **domain**：选择某个工作领域要加载哪些 suite，生成独立 profile。

安装 suite 到 profile：

```bash
node packages/dsh-suite-kit/bin/dsh-suite.mjs install \
  ./my-plugins/my-service/plugin/my-service-suite --profile web
```

安装 domain：

```bash
node packages/dsh-suite-kit/bin/dsh-domain.mjs install \
  ./my-plugins/my-service/domains/my-service --profile domain-my-service
```

校验：

```bash
node packages/dsh-suite-kit/bin/dsh-suite.mjs validate <suite-dir>
node packages/dsh-suite-kit/bin/dsh-domain.mjs validate <domain-dir>
```

## 8. 测试

生成的插件自带冒烟测试，覆盖：

- `/healthz` 返回 `ok/name/contractVersion`
- `/metrics` 有 `<slug>_up 1`
- MCP `initialize` / `tools/list` / `tools/call`
- 契约工具返回 `contractVersion`

运行：

```bash
cd my-plugins/my-service/plugin/my-service
npm run validate-plugin -- .
```

接入真实服务后，至少再补：

1. 正常路径每个工具一次；
2. 参数越界/缺参数一次；
3. 下游超时/报错一次；
4. 进程重启后状态恢复（如使用状态存储）。

## 9. 安装到 Harness

单个插件包：

```bash
dsh plugin --profile web add /path/to/plugin
```

suite：

```bash
node packages/dsh-suite-kit/bin/dsh-suite.mjs install /path/to/suite --profile web
```

安装后 profile 的 `dsh.profile.bundles` 会出现 suite 名；MCP 工具以 `mcp__<serverName>__<tool>` 出现在模型工具列表。

## 10. 打包

```bash
cd plugin-development
node pack-plugin.mjs ./my-plugins/my-service/plugin/my-service
```

产物在 `plugin-development/dist/`。打包器会：

- 始终包含 `package.json`、README、LICENSE/THIRD_PARTY_NOTICES；
- 支持 `files` 中的目录、文件和 `!` 排除项；
- 打包后自检 `main`、`dsh.bundle.patch`、`dsh.suite`；
- 生成跨平台 ZIP。

分发 bundle 见 [PLUGIN_PACKAGING_GUIDE.md](./PLUGIN_PACKAGING_GUIDE.md)。

## 11. 常见问题

**插件加载了但工具不出现？**
检查 `cordis.patch.yml` 是否有 `@deepseek-ai/dsh-mcp-client` row，且 `url` 指向真实服务；`/healthz` 必须已可访问。

**端口被占用？**
标准 relay 会先探测同服务并复用；如果被其他服务占用会直接报错。请同时修改 `cordis.patch.yml` 和 `dsh-suite.json` 里的端口。

**打包后缺少文件？**
`package.json` 的 `files` 必须包含所有运行文件；公共插件快照在 `server/shared/` 会被 `server/` 一并包含。打包器会自检，不会静默产出坏包。

**旧插件导入 `shared/` 怎么办？**
`plugin-development/shared/` 仍然保留，但已废弃。新代码一律使用公共插件（`ctx.*` 或 `server/shared/*`）。

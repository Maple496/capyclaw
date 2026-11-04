# 新插件稳定接入清单

> 新插件优先使用公共插件：`dsh-service-host`、`dsh-tool-host`、`dsh-state-service`、`dsh-asset-service`、`dsh-editor-host`。
> 本文件只描述底层 kit 的接入方式，供公共插件实现或旧插件维护使用。

## 1. 包结构

```text
my-plugin/
├─ package.json          # dsh.bundle.patch + dsh.suite（可选）
├─ cordis.patch.yml      # 只放插件行；不内联大段业务配置
├─ lib/host.mjs          # 只负责生命周期，不写业务
├─ server/
│  ├─ relay.mjs          # 路由/生命周期：/healthz /metrics /mcp
│  ├─ store.mjs          # 业务状态（可扩展 JournalStore）
│  ├─ tools.mjs          # 工具 schema + 分派
│  ├─ impl.mjs           # 业务实现
│  └─ infra/             # 构建期从 dsh-plugin-kit 拷贝的稳定快照
└─ editor/               # 浏览器端（可选）
```

## 2. 必须实现的基础协议

| 项 | 要求 |
|---|---|
| `GET /healthz` | `{ ok:true, name, version, contractVersion, uptimeSec, ...业务状态 }` |
| `GET /metrics` | Prometheus 文本；至少 `*_up`、`*_uptime_seconds` |
| `/mcp` | 使用 `createMcpHandler`，所有工具调用先 `validateToolArguments` |
| 绑定地址 | 只绑定 `127.0.0.1`，不要 `0.0.0.0` |
| 单实例 | 由 service-host 内置实例锁承担（锁文件/复用探测/残留接管一体）；不要自建第二套 |
| 状态落盘 | 每次变更原子写；journal + checkpoint 可选但推荐 |
| 编辑器 | 显示即连接；心跳用 Worker；lease TTL 与心跳间隔匹配 |
| 关闭 | `server.close` + `closeAllConnections`，释放锁和 discovery 文件 |

## 3. kit 快照

```bash
node packages/dsh-plugin-kit/bin/sync.mjs --out <plugin>/server/infra --force
```

生成 `INFRA_MANIFEST.json`；插件导入示例：

```js
import { listen, send, sendText, readBody } from './infra/service/http.mjs'
import { createMcpHandler } from './infra/service/mcp-http.mjs'
```

## 4. 工具接入

1. 工具 schema 放在独立 `schema` 模块或 `tools.mjs`；
2. 实现按领域分组（`impl-*.mjs`），由 `index.mjs` 汇合；
3. 每个工具都有稳定的 name / inputSchema / 返回形状；
4. 参数超限必须返回 `isError`，不能进入实现；
5. 契约版本和工具清单通过一个只读 `*_capabilities` 工具暴露；
6. 大参数工具必须在 schema 里限制 `maxItems` / `maxLength`。

## 5. 技能接入

```js
import { createSkillProvider } from 'dsh-plugin-kit/skills/provider'

const provider = createSkillProvider({
  assetRoot,
  skillDirs: ['my-router', 'my-edit'],
  providerName: 'dsh-my-plugin',
  contractRoot,
  contractFile: 'my-contract.json',
})
ctx.skills.registerProvider(() => provider)
```

技能正文只写 instructions；运行时能力通过工具名/契约引用，不复制工具实现。

## 6. 领域接入

- 用 `dsh-suite.json` 描述组件与能力；
- 用 `dsh-domain.json` 选择领域所需组件；
- 新插件先 `dsh-suite validate`，再 `dsh-domain stage`，最后 `dsh-domain launch`；
- 不要自定义 profile 结构，统一用 `dsh-suite-kit` 生成。

## 7. 稳定性验收

- `dsh-plugin-kit` 单测通过；
- 插件自身契约测试通过；
- MCP E2E：capabilities / tools / 错误路径 / 恢复；
- 压测：并发读、并发写、非法参数、超大参数、截图/长任务；
- 进程重启后 `state.json` / journal / checkpoint 可恢复；
- 两个 profile 同时启动可复用 bridge 或使用独立端口。

## 8. Runtime / Content Store 接入

- 插件启动时 `runtimeContextFromConfig(config)` 读取 `runtime.json`，拿
  `ports.content`、`paths.contentState`、`store.root`、`store.token`；
- 用 `createRuntimeStoreClient(context)` 得到 scoped `WorkspaceClient`；
- 插件状态用 `WorkspaceBackend` 映射到对象仓库（state/journal/checkpoint）；
- 不要硬编码 `39311`、`~/.dsh-ppt-bridge` 或全局锁文件；
- `BlobStore` 只存对象；work 归属、版本 CAS、catalog 和生命周期由
  `WorkspaceManager` 中间层负责；
- 多 runtime 同时运行时，每个 runtime 的 `harness` / `content` 端口和
  namespace token 都不同，不能复用其他 runtime 的端口或 store token。

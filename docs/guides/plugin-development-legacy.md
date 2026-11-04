# DSH 插件开发中心

本目录是 DeepSeek Harness 插件的**唯一开发入口**。旧的重复/过时文档已删除；历史实现请直接看 `bridges/ppt-bridge/` 和 `git` 历史。

## 先看这里

| 需求 | 文档 |
|---|---|
| 第一次写插件 | [PLUGIN_DEVELOPMENT_GUIDE.md](./PLUGIN_DEVELOPMENT_GUIDE.md) |
| 查命令/代码片段 | [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) |
| 接入一个外部服务 | [docs/SERVICE_INTEGRATION.md](./docs/SERVICE_INTEGRATION.md) |
| 打包与分发 | [PLUGIN_PACKAGING_GUIDE.md](./PLUGIN_PACKAGING_GUIDE.md) |
| 插件 UI 体验规则 | [PLUGIN_UX_STANDARD.md](./PLUGIN_UX_STANDARD.md) |

插件基础设施分为两层：

- **公共运行时插件**（新插件默认消费）：`dsh-service-host`、`dsh-tool-host`、`dsh-state-service`、`dsh-asset-service`、`dsh-editor-host`，通过 `ctx.*` 注入。
- **文档工作台框架**（编辑器类插件）：`packages/dsh-document-workbench`，提供版本化文档会话、op registry、桥路由、浏览器编辑器客户端和截图协议；PPT 是第一个消费者。
- **底层协议库**：`packages/dsh-plugin-kit`，只保留纯函数/传输/存储算法；不再让每个插件手写 relay/MCP/store。

脚手架会把公共插件源码快照到插件的 `server/shared/`，功能插件只写业务。`shared/`（历史兼容层）不再新增功能。

## 5 分钟创建一个服务插件

```bash
cd plugin-development

# 默认生成 plugin + suite + domain 三件套
node create-plugin.mjs \
  --name dsh-my-service \
  --type service \
  --title "My Service" \
  --port 39500 \
  --out ./my-plugins \
  --domain my-service \
  --yes

cd my-plugins/dsh-my-service/plugin/dsh-my-service
npm test
```

生成结构：

```text
my-plugins/dsh-my-service/
├── plugin/
│   ├── dsh-my-service/            # 运行时插件
│   │   ├── package.json
│   │   ├── cordis.patch.yml
│   │   ├── lib/host.mjs           # 只负责生命周期
│   │   ├── server/
│   │   │   ├── relay.mjs          # 业务装配（~60 行，不再有宿主样板）
│   │   │   ├── tools.mjs          # 能力 DSL + 注册表
│   │   │   ├── impl.mjs           # 业务实现
│   │   │   └── shared/            # 公共插件 + kit 的构建期快照
│   │   ├── contract/
│   │   └── test/
│   └── dsh-my-service-suite/      # suite 包
└── domains/my-service/
    └── dsh-domain.json
```

## 接入方式决策树

```text
目标服务是否已经提供 MCP server？
├─ 是 → 不用写插件：在 suite 里加一条 @deepseek-ai/dsh-mcp-client row
│        （见 docs/SERVICE_INTEGRATION.md 方案 A）
└─ 否 → 服务是否有 HTTP/数据库/SDK？
         ├─ 是 → 用 create-plugin 生成 service 插件，在 server/impl.mjs 实现工具
         │        （方案 B；这是大多数内部服务的路径）
         └─ 还需要用户界面？
                  → 用 --type ui 生成 editor/，按 PLUGIN_UX_STANDARD.md 做“显示即连接”
                    （方案 C）
```

## 常用命令

```bash
# 生成插件
node create-plugin.mjs --help

# 同步公共插件源码到插件的 server/shared/
node ../scripts/sync-shared.mjs --out ./my-plugins/my-plugin/server/shared --force

# 测试
npm test

# 打包单个插件
node pack-plugin.mjs ./my-plugins/my-plugin

# 校验 suite / domain
node ../packages/dsh-suite-kit/bin/dsh-suite.mjs validate ./my-plugins/my-plugin/plugin/my-plugin-suite
node ../packages/dsh-suite-kit/bin/dsh-domain.mjs validate ./my-plugins/my-plugin/domains/my-plugin
```

## 标准边界

- **公共插件**：宿主/工具/状态/资产/编辑器不写在功能插件里，使用 `ctx.serviceHost`、`ctx.toolHost`、`ctx.state`、`ctx.assets`、`ctx.editorHost`。
- **插件运行形态**：cordis 插件（`lib/host.mjs`）在 Harness 进程内拉起 loopback 服务；对 AI 暴露工具走 MCP Streamable HTTP。
- **服务契约**：每个插件必须有 `/healthz`、`/metrics`、`/mcp`；这些由 `dsh-service-host` 提供，业务只注册字段。
- **安装单位**：suite 包；多插件产品用 domain 包选择要加载的 suite。
- **绑定地址**：只监听 `127.0.0.1`，不要 `0.0.0.0`。
- **状态落盘**：优先使用 `ctx.state`（JournalStore/checkpoint/recovery）。

## Runtime / 文件管理契约

新插件不要硬编码端口、`~/.xxx` 目录或 `state.json` 路径。标准做法：

1. 在 `dsh-domain.json` 的 `runtime.requires` 声明需要的 tools / capabilities / services；
2. 在 `runtime.scope.sessions` 声明会话目录，在 `runtime.scope.files` 声明修改文件根目录；
3. 在 `runtime.scope.workspace` 声明这个 work 管理哪些逻辑文件（`allowNew: false` 时严格限制）；
4. 插件 `lib/host.mjs` 用 `runtimeContextFromConfig(config)` 读取端口/路径；
5. 持久化通过 `createRuntimeStoreClient()` + `WorkspaceBackend` 写入共享对象仓库，不直接写全局目录；
6. 端口/目录注入写在 `runtime.bindings`，通用层不按插件名硬编码；`scope.files` 用 `kind: workspace | content` 标记用途；
7. 构建期用 `scripts/sync-shared.mjs` 把公共插件源码同步到插件 `server/shared/`；功能代码只 import `server/shared/*`，不再手写宿主/工具/状态/资产/编辑器。

脚手架生成的新插件已经按这套契约生成；PPT workbench 是生产级参考实现。

## 目录约定

| 目录 | 用途 |
|---|---|
| `create-plugin.mjs` | 脚手架 |
| `templates/` | 脚手架模板（公共插件 shared 快照） |
| `examples/dsh-hello-service/` | 最小可用服务接入样例（plugin + suite + domain） |
| `my-plugins/` | 你的插件项目 |
| `shared/` | **已废弃**，历史插件兼容层 |
| `docs/` | 专题文档 |

## 历史项目

- 当前生产用 PPT 套件以 `bridges/ppt-bridge/plugin/` 为准。
- `examples/dsh-ppt-workbench/` 是 1.x 历史示例，仅用于对照旧代码，不要作为新插件模板。

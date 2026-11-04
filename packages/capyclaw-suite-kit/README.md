# @capyclaw/suite-kit（DSH 组合标准件）

把“多个插件 + 一组 patch 行 + 健康检查 + 安装脚本”收成一个可校验、可组合、可诊断的标准件。

## 一个 suite 的最小结构

```text
my-suite/
├─ package.json          # dsh.bundle.patch -> cordis.patch.yml, dsh.suite -> dsh-suite.json
├─ dsh-suite.json        # 唯一真源：packages / rows / checks
├─ cordis.patch.yml      # 由 rows 生成，不手写
└─ lib/index.mjs         # 可选：组合包自身的空实现
```

`dsh-suite.json`：

```json
{
  "name": "my-suite",
  "version": "1.0.0",
  "title": "我的组合",
  "packages": {
    "my-plugin": {
      "role": "runtime",
      "version": "^1.0.0",
      "path": "./plugins/my-plugin",
      "provides": { "tools": ["my_*"], "ports": [39311] }
    }
  },
  "rows": [
    { "id": "my-host", "name": "my-plugin" }
  ],
  "checks": [
    { "id": "health", "type": "http", "url": "http://127.0.0.1:39311/healthz", "expectStatus": 200 }
  ]
}
```

## 两种组合粒度

### Suite（组件集合）

一个 suite 描述一组插件包和 patch 行。适合“一个产品/一个套件”。

suite 可以用 `components` 引用其他 suite，而不是复制它们的 packages/rows：

```json
{
  "name": "my-suite",
  "components": ["../../packages/capyclaw-service-host", "../../packages/capyclaw-tool-host"],
  "packages": { "my-plugin": { "role": "runtime", "version": "^1.0.0", "path": "../my-plugin" } },
  "rows": [{ "id": "my-host", "name": "my-plugin" }]
}
```

`loadSuiteManifest()` 会展开组件，并把组件行排在功能插件行之前，保证 `ctx.*`
在功能插件 `apply()` 时已经就绪。`stageDomain` 会把展开后的 manifest 写入 staged
组件，目录统一为 `components/<packageName>`。

### Domain（领域包 / 启动单位）

一个 domain 只选择某个工作领域需要的 suite，并生成独立 profile：

```text
domain.json
  components: [../ppt-suite, ../canvas-suite]
  baseBundles: [dsh-base, dsh-web-app]
  profile: { name: domain-ppt, port: 3080 }
```

启动时只加载 base + web-app + 选中的 suite；未选中的插件、skill、MCP 不注册。`stage` 只复制选中组件，形成一个可带走的领域包。

## CLI

```bash
dsh-suite validate ./my-suite
dsh-suite compose ./ppt-suite ./canvas-suite --out ./composed
dsh-suite install ./ppt-suite ./canvas-suite --profile web
dsh-suite doctor --profile web --dsh-bin /path/to/dsh
dsh-suite init ./new-suite --name my-suite --title "我的组合"

dsh-domain validate ./my-domain
dsh-domain resolve ./my-domain
dsh-domain install ./my-domain --profile domain-my --dsh-home ~/.dsh
dsh-domain stage ./my-domain --out ./dist/my-domain

# 直接启动需要处理 dsh 的登录 token；桌面/本地推荐走 auth-proxy 零登录
dsh-domain launch ./my-domain --auth-proxy /path/to/auth-proxy.mjs --port 3090 --proxy-port 3091

# 推荐：每个 DSH 进程一个 runtime（独立端口/目录/namespace）
dsh-runtime create --name my-runtime --domain ./my-domain
dsh-runtime start <runtimeId>
dsh-runtime list
dsh-runtime works <runtimeId>
dsh-runtime declare <runtimeId> main --files "state.json,journal.jsonl,checkpoints/**" --no-new
dsh-runtime stop <runtimeId>
```

## Runtime（统一中间层的启动单位）

`@capyclaw/suite-kit` 是统一中间层：它同时负责“打包哪些插件、分配哪些端口、
创建哪个 runtime、这个 runtime 声明需要哪些工具/能力、工作范围多大、
文件归属和生命周期”。

每个 runtime 获得：

- `harness` 端口：浏览器访问 DSH 的入口；
- `dsh` 端口：auth-proxy 后面的 DSH 上游端口；
- `content` 端口：作品/编辑器的显示端口；
- 独立 `DSH_HOME`、profile、workspace、日志、临时目录、auth-proxy 锁；
- 独立 Content Store namespace token。

启动声明写在 `dsh-domain.json` 的 `runtime` 段：

```json
{
  "runtime": {
    "driver": "node",
    "workId": "main",
    "bindings": [
      {
        "row": "ppt-workbench-host",
        "config": {
          "port": "${ports.content}",
          "hostDir": "${paths.contentState}",
          "strictPort": true,
          "workId": "${workId}"
        }
      }
    ],
    "env": {
      "PPT_BRIDGE_HOME": "${paths.contentState}"
    },
    "model": {
      "id": "llm-deepseek",
      "plugin": "@deepseek-ai/dsh-llm-deepseek-api-key",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com/anthropic"
    },
    "requires": {
      "tools": ["ppt_*"],
      "capabilities": ["ppt.runtime@^2.2.0"],
      "services": ["ppt-workbench"]
    },
    "scope": {
      "sessions": { "path": ".dsh/sessions", "isolated": true },
      "files": [
        { "id": "workspace", "kind": "workspace", "path": "workspace", "patterns": ["**"] },
        { "id": "ppt", "kind": "content", "path": "content/ppt", "patterns": ["state.json", "journal.jsonl", "checkpoints/**"] }
      ],
      "workspace": {
        "workId": "main",
        "files": ["state.json", "journal.jsonl", "checkpoints/**"],
        "allowNew": false
      },
      "network": { "bind": ["127.0.0.1"], "outbound": "none" }
    },
    "ports": {
      "harness": { "preferred": 3080, "range": 100 },
      "content": { "preferred": 39311, "range": 100 }
    }
  }
}
```

`dsh-runtime create` 在分配端口之前先校验 `requires`；`scope.workspace`
会变成该 work 的 `manifest.json.declaration`，后续写入由中间层校验。
`scope.sessions` 和 `scope.files` 会解析成 `runtime.json.paths` /
`runtime.json.storage` 里的绝对路径：会话记录落在该 runtime 的
`DSH_HOME/sessions`，修改文件落在声明的 files 根目录内。
`bindings` 按 row/package 注入端口、目录、workId 等模板值，通用层不认具体插件名。
`env` 可按 runtime 注入插件兼容环境变量。`model` 会生成 runtime 自己的 `DSH_HOME/cordis.patch.yml` 模型通道，
避免把用户的全局模型配置带进 runtime；`workspaceController` 会把
DSH 默认 workspace 固定到该 runtime 的 workspace 根目录下。
`declare` 命令可以在运行时调整声明：

```bash
dsh-runtime works <runtimeId>
dsh-runtime declare <runtimeId> main --files "state.json,journal.jsonl,checkpoints/**" --no-new
```

同一个 runtime 内的多个会话共享同一个 work（例如 `main`）；不同 runtime 即使
使用相同 `workId` 也互相隔离。

所有落盘文件都在同一个 `DSH_STORE_ROOT`（默认 `~/.dsh-store`）：

```text
<storeRoot>/
├─ objects/<aa>/<sha256>                  # 纯对象仓库（不关心文件关系）
├─ workspaces/<runtimeId>/<workId>/manifest.json  # 中间层：文件关系/版本/归属
├─ catalog/works.json                     # 供 UI / 生命周期管理读取的作品目录
├─ namespaces/<runtimeId>.json            # token 哈希 / TTL
├─ runtimes/<runtimeId>/                  # DSH_HOME、workspace、日志、锁、runtime.json
└─ registry.json                          # 端口租约
```

`objects/` 只负责存字节；`workspaces/` 和 `catalog/` 是中间层，负责“哪些文件属于同一个作品、谁能修改、版本和生命周期”。`catalog/works.json` 是展示索引，采用最终一致性刷新，不作为热路径事务日志。

`runtime.driver` 预留 `node`（L1 逻辑隔离）、`jobobject`、`docker`、`wsl`；
需要真正的文件/网络强隔离时接 L2/L3 driver。

## 组合规则

- `components`：先展开组件 suite 的 packages/rows/checks，再合并本 suite；组件行优先。
- `packages`：同名包版本/role 必须一致；`provides` 合并去重。
- 能力（capability）：`provides.capabilities` 声明“我提供什么”，`requires.capabilities` 声明“我需要什么”；组合时解析 provider，缺失或不兼容会报错。
  - 例如 `dsh-ppt-skills` 只依赖 `ppt.runtime@^2`，不依赖某个具体 workbench 包，因此可以替换实现。
- `rows`：同 id 同 name/config 自动去重；不同则报冲突（除非 `allowOverride`）。
- 端口：同一个端口被不同包声明 → 冲突。
- 工具名：精确重名 → 冲突；多个通配工具面 → 告警。
- `checks`：同 id 去重；不同则冲突。

## 安装规则

- profile 里只把 suite 包作为 `link:` 依赖；子包通过 junction 放进 `node_modules`，不进入 profile 的 `dependencies`。
- `dsh.profile.bundles` 只列 suite 名；suite patch 负责插入子包的行。
- 重复安装时按 `dshSuiteKit.managedPackages` 清理旧链接，避免残留。
- `doctor` 会检查：suite manifest、子包存在性、HTTP 健康、MCP contract major、组合后 row id 重复。

## 从 domain 构建 bundle

`scripts/build-bundle.mjs` 直接使用本包的 `resolveDomain` / `stageDomain`：

```bash
node scripts/build-bundle.mjs \
  --domain bridges/ppt-bridge/domains/ppt \
  --out builds/ppt --target portable
```

生成的 bundle 内含 `domain/`（组件 + kit + domain.json）、`setup.mjs` 和启动脚本。
`setup.mjs` 调用 `installDomain({ runPnpm: false })`，在 bundle 自带的
`DSH_HOME` 下建立 profile 和组件链接，不依赖 pnpm，也不写用户主目录。

## 设计边界

- 这个包是**开发/安装工具**，不是 DSH 运行时插件；不会出现在 agent 工具面里。
- 组合层不替子包做业务；它只负责“谁和谁一起跑、怎么验证、冲突在哪”。
- 运行时通信用 Cordis service / MCP / HTTP；suite-kit 不创建跨进程总线。

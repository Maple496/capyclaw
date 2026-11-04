# dsh-stack-kit

把「启动清单」收成**一份** `dsh-stack.json`：插件 bundles、broker 服务、端口、`DSH_HOME/profile`、workspace 全部由它决定。

`dsh` 和 `dsh-service-broker` 仍然读现有契约；本包只是**编译层**：

```
dsh-stack.json
  ├─ <home>/profiles/<profile>/package.json    dsh.profile.bundles + link/registry 依赖
  └─ <stateDir>/stack-services.json            broker {services:[...]}
```

生成物不要手改；改 stack 后重新 `apply`。

## 快速开始

```bash
# 看会生成什么 / 是否有漂移（只读）
node tools/dsh-launcher/bin/dshd.mjs stack plan --stack tools/dsh-launcher/dev-stack.json

# 物化 profile + 生成 broker 清单（默认会跑 pnpm install）
node tools/dsh-launcher/bin/dshd.mjs stack apply --stack tools/dsh-launcher/dev-stack.json

# 一条命令：apply + start
node tools/dsh-launcher/bin/dshd.mjs start --stack tools/dsh-launcher/dev-stack.json
```

`--no-install` 跳过 `pnpm install`；`stack plan/apply` 默认不启动进程。

## 示例

```json
{
  "$schema": "../../packages/dsh-stack-kit/stack.schema.json",
  "name": "dev",
  "home": "./.dshd/home",
  "profile": "web",
  "workspace": "../../core-harness/deepseek-harness/workspace",
  "stateDir": "./.dshd/dev-state",
  "ports": { "broker": 13593, "proxy": 13594, "upstream": 13595 },
  "plugins": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      { "name": "dsh-launchpad", "path": "../../extensions/official/dsh-launchpad" }
    ],
    "install": true
  },
  "services": [
    {
      "id": "launchpad",
      "path": "../../extensions/official/dsh-launchpad/server.mjs",
      "args": [
        "--roots", "${STACK_DIR}/../..",
        "--dsh-home", "${home}",
        "--broker-url", "http://127.0.0.1:${ports.broker}"
      ],
      "ports": { "main": 13596 },
      "healthPath": "/healthz",
      "keepAlive": true
    }
  ]
}
```

## 字段

| 字段 | 含义 |
|---|---|
| `name` | stack 名称 |
| `home` | `DSH_HOME`，相对 stack 文件 |
| `profile` | `profiles/<profile>`，决定插件 profile |
| `workspace` | dsh 工作区，默认 `<stackDir>/workspace` |
| `stateDir` | dshd 运行态/日志/生成清单，默认 `<stackDir>/.dshd/state` |
| `ports.broker/proxy/upstream` | dshd 三端口；`auto` 或固定整数 |
| `plugins.bundles` | 字符串（已安装/基础包）或 `{name,path\|version}` |
| `plugins.dependencies` | 安装但不加载的依赖（如 `dsh-plugin-kit`），值可 `link:<path>`、版本或 `{path\|version}` |
| `plugins.overrides` | 写入 profile `pnpm.overrides`；相对路径自动转 `link:<abs>` |
| `plugins.install` | 默认 `true`；`false` 时不跑 pnpm |
| `services[]` | broker spec 的简写：`path` + `args` 或完整 `cmd`；`ports/url/healthPath/keepAlive/requires/env` |
| `env` | 同时传给 broker 和 dsh 进程的环境变量 |
| `open` | 启动后开浏览器（dshd 使用） |

### 占位符

在 `args`、`env`、`url`、`cwd`、`path` 的外层字符串里：

- `${STACK_DIR}` → stack 文件所在目录
- `${home}` → 解析后的 `DSH_HOME`
- `${profile}` → profile 名
- `${ports.broker|proxy|upstream}` / `${ports.services.<id>}` → 固定端口数值（`auto` 不会展开，会 warning）
- `${PORT}` / `${PORT_<NAME>}` / 其它 `${VAR}` **原样留给 broker**（由 broker 分配/从环境展开）

`path` 模式且 `args` 里没有 `--port`/`-p` 时，编译器会自动补 `--port ${PORT}`。

## 生成物

| 文件 | 内容 |
|---|---|
| `<home>/profiles/<profile>/package.json` | 合并后的 `dependencies` + `dsh.profile.bundles`（保留其它字段与 `cordis.patch.yml`） |
| `<home>/profiles/<profile>/cordis.patch.yml` | 仅在缺失时创建空 patch；不覆盖用户已有覆盖层 |
| `<stateDir>/stack-services.json` | `{_generatedBy, _stack, services:[spec...]}`，直接交给 broker |

## domain 型（v2，2026-11-03）

`kind: "domain"` 的一份清单不再编译 profile/services，而是把装配交给
`dsh-domain.json` + `dsh-suite-kit` runtime；`dshd` 负责创建/启动/停止：

```json
{
  "kind": "domain",
  "name": "ppt",
  "stateDir": "./.dshd/state",
  "ports": { "proxy": "auto", "upstream": "auto", "content": 39311, "broker": "auto" },
  "domain": {
    "source": "../extensions/bridges/ppt-bridge/domains/ppt",
    "runtimeId": "rt-stack-ppt",
    "recreate": false
  },
  "open": false
}
```

```bash
dshd stack plan  --stack <file>   # domain 摘要 + runtime 是否存在
dshd stack apply --stack <file>   # 创建/复用 runtime（不启动）
dshd start       --stack <file>   # apply + start（broker + dsh + suite services）
dshd status|doctor|stop --stack <file>
```

- `domain.source`：domain 目录或 `dsh-domain.json`；
- `domain.runtimeId`：默认 `rt-stack-<stack slug>`；稳定 id 让 start/stop 幂等；
- `domain.storeRoot`：默认 `<stateDir>/store`；
- 顶层 `ports`：`proxy→runtime.harness`、`upstream→runtime.dsh`、`content→runtime.content`、
  `broker→runtime.broker`、`services.*→suite 服务端口偏好`（`"auto"`/0 现场分配）；
- `domain.requires/scope/model/workspaceController/env`：覆盖 domain.runtime 对应字段；
- `domain.recreate: true`：apply/start 时先删同名 runtime 再重建（破坏性，会清 runtime 内容）；
- domain 型忽略顶层 `plugins`/`services`（插件/服务由 domain + suite `services.json` 决定）。

domain runtime 的服务由 `dsh-service-broker` 按 suite `services.json` 拉起；profile 型
和 domain 型现在是同一份 `dsh-stack.json` 的两种 `kind`，共用 `dshd` 的 start/stop/status/
doctor/logs 入口。

## 边界

- profile 型：`pnpm install` 只负责 profile 的 `dependencies`；`@deepseek-ai/*` base bundles 仍由 dsh 安装提供。
- `path` 服务会自动补 `--port ${PORT}`；如果脚本不接受该参数，请改用完整 `cmd`。
- 现有 `dshd.config.json` / `services.json` 不受影响；`dshd --config` 继续可用。`--stack` 是新的推荐入口。
- domain 型的 `--foreground` 由 dshd 守护 proxy；proxy 死 → 整组 stop+start（限次），不是进程内热重启。

## 测试

```bash
cd packages/dsh-stack-kit
npm test
```

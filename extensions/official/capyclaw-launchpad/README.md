# dsh-launchpad

**启动清单管理器 + 启动器 + 编辑器**。

- 用 `launchpads/*.stack`（DSL）描述“启动哪个 dsh 模式、装哪些插件、跑哪些服务、用什么端口”；
- 浏览器管理界面点击 **启动 / 停止 / Plan / 校验 / 保存**，执行器把 DSL 编译成 `dsh-stack.json` 后交给 `dshd`；
- DSH 侧边栏提供「启动清单」入口（独立服务页面 iframe）；
- 同时保留原来的只读盘点：发现并校验 broker `services.json`、`.works`、
  `dsh-domain.json`、`dshd.config.json`、profile bundles，并检测它们与生成物的漂移。

```
┌───────────────────────────────────────────────┐
│ 管理界面 / HTTP API（server.mjs，独立端口）      │
│   launchpads/*.stack DSL  → 校验/编辑/Plan      │
│   启动/停止 → dshd → broker → dsh/服务进程       │
│   inventory/validate/status/doctor（只读盘点）   │
└───────────────────────────────────────────────┘
        │                         │
        ├── DSH client（侧边栏 iframe，只注入 URL）
        └── CLI: bin/launchpad.mjs
```

## 管理界面

启动独立服务后打开：

- **dev 本机：<http://127.0.0.1:13596/>**
- DSH 13594 刷新后，左侧「启动清单」入口打开同一个页面

页面能力：

- 左侧列出 `launchpads/` 下的 DSL（`dev` / `example`，以及你新建的）；
- 点击项目 → 右侧编辑 DSL、看校验/状态/问题；
- **启动**：执行器调用 `dshd start --stack <编译后的 JSON>`，在 DSL 声明的
  home/profile/端口上拉起 broker + dsh + 服务；
- **停止**：调用 `dshd stop`（当前 launchpad 服务所在的 HOST 栈禁止自停）；
- **Plan**：先看 dshd 会生成什么、有没有错误，不启动；
- **保存 / 校验 / 删除 / 新建**；API 可用 `--token`/`LAUNCHPAD_TOKEN` 保护。

### 插件面板

选中一个 launchpad 后，页面里有三列：

- **DSL 声明**：当前 DSL `plugins.bundles`，可移除；
- **Profile 实际**：`<home>/profiles/<profile>/package.json` 实际 bundles，
  以及 `missing/extra` 漂移；
- **仓库可用**：扫描 `extensions/**` 与 `plugin-development/my-plugins/**` 中带
  `dsh.bundle.patch` 的包（本仓 19 个，含 `dsh-port-sidebar`、`dsh-llm-tempkey`、
  `dsh-ppt-suite` 等），点「添加」即写入 DSL。

插件面板只改 DSL 的 `plugins` 块（保留 `dependencies`/`overrides`/`install`
和块外注释）；添加本地插件时若包声明了 `dsh-plugin-kit`，会自动补依赖。
改动写入 DSL 后：

- 停着的 launchpad：点 Plan / 启动才会物化到 profile；
- 运行中的 launchpad：需要 stop → start 才生效；
- `HOST` 栈（当前 13594）：请从外部 `dshd stop/start --stack` 重启。
- **3016 的插件属于另一个 DSH_HOME/profile，不会出现在这里**；catalog 只列本仓库
  可安装 bundle。要让 launchpad 复用某个 profile，把 DSL 的 `home/profile` 指过去
  （注意 HOST/单例锁边界）。

## 启动清单 DSL（`launchpads/*.stack`）

DSL 是**作者层**；`dsh-stack.json` 是执行器编译出的中间契约，两者都不需要手写
profile/services。示例（仓库里的 `launchpads/dev.stack` 是当前 dev 栈）：

```text
stack "example" {
  kind "profile"
  home "../.dshd/launchpads/example/home"
  profile "web"
  workspace "../.dshd/launchpads/example/workspace"
  stateDir "../.dshd/launchpads/example/state"

  ports { broker "auto" proxy "auto" upstream "auto" }

  plugins {
    bundle "@deepseek-ai/dsh-base"
    bundle "@deepseek-ai/dsh-web-app"
    plugin "my-plugin" { path "../extensions/official/my-plugin" }
    dependency "dsh-plugin-kit" { path "../packages/dsh-plugin-kit" }
    install true
  }

  service "example" {
    path "../path/to/server.mjs"
    args ["--port", "${PORT}"]
    port 39700
    health "/healthz"
    keepAlive true
  }
}
```

- 占位符：`${STACK_DIR}` = **DSL 文件目录**（发射时展开为绝对路径）；
  `${home}`/`${profile}`/`${ports.*}`/`${PORT}` 交给 dsh-stack-kit / broker。
- 执行链：`DSL → launchpads/.launchpad/<id>.json → dshd stack apply/start`；
  生成物在 `<stateDir>/.launchpad/` 下，不要手改。
- **扩展新启动形态**：在 `lib/dsl.mjs` 的 `KIND_HANDLERS` 注册一个新
  handler（`kind "xxx"`）。已实现 `profile` 与 `domain`；domain 型示例：

```text
stack "ppt" {
  kind "domain"
  stateDir "../data/launchers/ppt/state"
  ports { broker "auto" proxy 39100 upstream "auto" content "auto" }
  domain {
    source "../launchers/ppt/domain"
    runtimeId "rt-ppt"
    name "PPT 工作台"
  }
}
```

  domain 型由 dshd 交给 `dsh-suite-kit` runtime（broker + dsh + suite services）；
  管理界面/状态从 runtime.json + discovery 读，不再依赖 profile 的 state.json。
- 当前服务所在的栈会在列表里标 `HOST`；停止它会中断本页面，因此禁用。
- 执行器默认找仓库内 `tools/dsh-launcher/bin/dshd.mjs`；可用
  `--dshd` / `DSH_LAUNCHPAD_DSHD` 覆盖。DSL 目录用 `--launchpads` /
  `DSH_LAUNCHPAD_DIR` 覆盖。

## 它管哪些清单

| 类型 | 典型文件 | 本插件检查什么 |
|---|---|---|
| 可执行启动 DSL | `launchpads/*.stack` | DSL 语法、插件/服务路径、端口；Plan 时交给 dshd 深校验 |
| 统一启动清单（编译契约） | `dsh-stack.json`、`*-stack.json` | 插件 bundles、服务 spec、路径/端口；与生成的 profile bundles、`stack-services.json` 做漂移对比 |
| broker 开机清单 | `services.json`、`local-services.json`、`*.services.json` | 服务 id/cmd/env/ports/requires；同清单重复 id/端口；命令路径；依赖是否同批声明 |
| 部署清单 | `*.works`（META + CODE 双段） | META 必填字段、`view.kind`、`deployment.source` 是否存在、是否指向 domain、runtime ports |
| 领域清单 | `dsh-domain.json` / `domain.json` | name/version/components；组件路径；suite 的 rows 与各级 `cordis.patch.yml` 行覆盖；preferred 端口 |
| 启动器/激活清单 | `dshd.config.json`、`profiles/*/package.json` | dshHome/manifest/harnessDir/brokerDir 路径；state.json 里的 broker/dsh pid；bundles 是否在 node_modules 中 |

另外会读取 **runtime discovery**（`services.json` 的 `{services:{...}}` 形态）
展示运行态，但它不是启动清单，不会被当成 broker 清单盘点。

### 编译契约（`dsh-stack.json`）

`dsh-stack.json` 是 `dshd --stack` 的编译契约：它决定 profile bundles、broker
服务、端口、`DSH_HOME/profile`。日常编辑用上面的 `launchpads/*.stack` DSL；
执行器把它编译成这份 JSON 后交给 `dshd`。launchpad 对已有 JSON/生成物做
**只读盘点与漂移检查**：

- 插件路径是否存在、是否有 `dsh.bundle.patch`；
- stack 的 `plugins.bundles` 与 `<home>/profiles/<profile>/package.json` 是否一致；
- stack 的 `services` 与生成的 `<stateDir>/stack-services.json` 是否一致；
- 服务端口是否与生成清单一致。

生成物不要手改；改 stack 后重新 `dshd stack apply`。完整 schema 见
[`packages/dsh-stack-kit`](../../../packages/dsh-stack-kit/README.md)。

## 快速开始

管理界面（dev 栈已在跑）：

```text
http://127.0.0.1:13596/
```

或手动起服务：

```bash
node extensions/official/dsh-launchpad/server.mjs \
  --port 39700 \
  --launchpads launchpads \
  --dshd tools/dsh-launcher/bin/dshd.mjs
```

只读盘点/校验/运行态（仓库根目录）：

```bash
# 盘点：四类清单 + 服务 + 问题
node extensions/official/dsh-launchpad/bin/launchpad.mjs scan

# 校验：有 error 时退出码 1，适合 CI
node extensions/official/dsh-launchpad/bin/launchpad.mjs validate

# 运行态：读 discovery，可选探测 /healthz
node extensions/official/dsh-launchpad/bin/launchpad.mjs status --probe

# 体检：roots / discovery / broker / launcher / 清单错误
node extensions/official/dsh-launchpad/bin/launchpad.mjs doctor
```

安装为可执行命令后（`npm link` 或 profile 安装）：

```bash
launchpad scan
launchpad validate
launchpad status --probe
```

默认扫描根自动探测（从当前目录/包目录向上找 `workspaces` 的 `package.json`）；
显式指定：

```bash
launchpad scan --roots .,../another-repo --dsh-home ~/.dsh
```

## CLI

```
launchpad scan      [--roots a,b] [--json] [--fail-on error|warning]
launchpad validate  [--roots a,b] [--json] [--fail-on error|warning]
launchpad status    [--roots a,b] [--probe] [--no-probe] [--json]
launchpad doctor    [--roots a,b] [--json]
launchpad start <service-id> [--manifest <ref>] [--dry-run] [--json]
launchpad stop  <service-id> [--manifest <ref>] [--dry-run] [--json]
launchpad apply <manifest-ref> [--dry-run] [--json]
launchpad serve     [--port 39700] [--host 127.0.0.1] [--roots a,b] [--token <t>]
                    [--launchpads <dir>] [--dshd <path/to/dshd.mjs>]
```

通用选项：

| 选项 | 含义 |
|---|---|
| `--roots a,b` / `--root <dir>` | 扫描根；默认自动探测仓库根 |
| `--dsh-home <dir>` | DSH_HOME；默认 `$DSH_HOME` 或 `~/.dsh` |
| `--no-profiles` | 不扫描 `<DSH_HOME>/profiles/*/package.json` |
| `--discovery <file>` | discovery 文件；默认 `$DSH_DISCOVERY_FILE`、launcher state、`~/.dsh/services.json` |
| `--broker-url <url>` | broker 控制端点；默认 `$DSH_BROKER_URL`、launcher state |
| `--broker-token <t>` | broker token；默认 `$DSH_BROKER_TOKEN` |
| `--json` | 机器可读输出 |
| `--dry-run` | start/stop/apply 只打印将发送的 spec/命令，不调用 broker |
| `--wait <ms>` | 传给 broker `waitMs` |
| `--allow-self-stop` | 允许 stop `launchpad` 自身（默认拒绝） |
| `--launchpads <dir>` | DSL 目录；默认仓库根 `launchpads/`（`DSH_LAUNCHPAD_DIR`） |
| `--dshd <path>` | 执行器；默认仓库内 `tools/dsh-launcher/bin/dshd.mjs`（`DSH_LAUNCHPAD_DSHD`） |

退出码：`0` 正常；`1` 校验/操作失败；`2` 用法或配置错误。

## HTTP API

独立服务（含管理界面 `/`）：

```bash
node server.mjs --port 39700 --roots . --broker-url http://127.0.0.1:39610 \
  --launchpads launchpads --dshd tools/dsh-launcher/bin/dshd.mjs
```

只绑 `127.0.0.1`。`/healthz` 返回 pid/port，broker 靠它收编与身份核验：

```
GET  /                               管理界面（HTML）
GET  /healthz                        {ok, service:"dsh-launchpad", pid, port, version, uptimeSec}
GET  /api/inventory                  全量盘点
GET  /api/validate                   校验结果
GET  /api/status[?probe=1]           运行态
POST /api/refresh                    强制重新扫描
GET  /api/manifests                  清单列表
GET  /api/manifests/:id              单清单详情
POST /api/manifests/:id/apply        {dryRun?, waitMs?}
GET  /api/services                   服务列表
POST /api/services/:id/start         {manifestId?, dryRun?, waitMs?}
POST /api/services/:id/stop          {manifestId?, dryRun?, allowSelfStop?}
GET  /api/doctor                     体检

GET  /api/plugins/catalog            仓库可用插件（name/path/title/category）
GET  /api/launchpads                 DSL 列表（含 running/host 状态）
GET  /api/launchpads/:id/plugins     DSL 声明 + profile 实际 + catalog
PUT  /api/launchpads/:id/plugins     {bundles} 写回 DSL plugins 块
POST /api/launchpads                 {name} 新建 .stack
GET  /api/launchpads/:id             DSL 原文 + 解析后的 stack + 状态
PUT  /api/launchpads/:id             {text} 保存
DELETE /api/launchpads/:id           删除（运行中/HOST 拒绝）
POST /api/launchpads/:id/validate    语法/字段校验
POST /api/launchpads/:id/plan        dshd stack plan（不启动）
POST /api/launchpads/:id/start       dshd start（点击启动）
POST /api/launchpads/:id/stop        dshd stop（HOST 拒绝）
GET  /api/launchpads/:id/status      运行态
```

示例：

```bash
curl -s http://127.0.0.1:39700/api/inventory | jq '.summary'
curl -s "http://127.0.0.1:39700/api/status?probe=1" | jq '.services'
curl -s -X POST http://127.0.0.1:39700/api/services/ppt-workbench/start \
  -H 'content-type: application/json' \
  -d '{"manifestId":"broker-0816f7aaf9","dryRun":true}' | jq
```

启动/停止示例：

```bash
curl -s -X POST http://127.0.0.1:13596/api/launchpads/example/start | jq '{ok, state: .status.state, url: .status.dsh.url}'
curl -s -X POST http://127.0.0.1:13596/api/launchpads/example/stop  | jq '{ok, state: .status.state}'
```

设置 `--token` / `LAUNCHPAD_TOKEN` 后，`/api/*` 都要带（`/` 静态界面与 `/healthz` 不拦）：

```bash
curl -H "x-launchpad-token: $LAUNCHPAD_TOKEN" http://127.0.0.1:39700/api/inventory
```

CORS 只放行回环 Origin（`127.0.0.1` / `localhost` / `::1`），方便本机其他工具页调用。

## 注册为 broker 服务

把 `services.example.json` 里的条目合并进你的 broker 开机清单
（例如 `tools/dsh-launcher/local-services.json`）：

```json
{
  "services": [
    {
      "id": "launchpad",
      "cmd": ["node", "${PACKAGE_DIR}/server.mjs", "--port", "${PORT}"],
      "ports": { "main": 39700 },
      "url": "http://127.0.0.1:${PORT}",
      "healthPath": "/healthz",
      "keepAlive": true
    }
  ]
}
```

`${PACKAGE_DIR}` 由 broker 展开为清单文件所在目录。如果 launchpad 的 cwd
不在仓库内，给 `cmd` 追加 `"--roots", "<仓库根>"`（或设置
`LAUNCHPAD_ROOTS`）；启停还需要 `DSH_BROKER_URL`（或 launcher state 里的
`broker.url`），否则服务只读，`/api/doctor` 会如实报「启停不可用」。

## 校验口径

同一份清单内的错误会让 broker 静默合并或抢占端口，因此按 **error** 处理；
跨清单同名/同端口可能是「替代部署」，按 **warning** 处理：

| 情况 | 级别 |
|---|---|
| 同一 broker 清单内重复服务 id / 固定端口 | error |
| 同一 domain/works 内 preferred 端口重复 | error |
| 跨清单同名服务（规格相同 / 不同） | warning |
| 跨清单同端口 / 固定端口与 preferred 重叠 | warning |
| cmd 路径不存在、cwd 不存在 | error |
| `requires` 引用的服务不在同一清单 | error |
| `.works` 的 `deployment.source` 不存在 | error |
| domain 组件路径不存在 / 行覆盖缺失 | error |
| suite 缺 `dsh-suite.json`、profile bundle 未安装 | warning |
| `${VAR}` 环境变量当前未设置 | warning |
| discovery 不存在 / state.json 解析失败 | doctor 里如实报告 |

跨清单同名且规格不同时，`start <id>` 必须加 `--manifest <ref>` 消歧；否则
CLI/API 返回 `AMBIGUOUS`（409）。

## 启停边界

- **只投递命令**：`start` → `POST /control/apply {commands:[{op:"up",service:spec}]}`；
  `stop` → `POST /control/stop {id}`。不 spawn、不 kill、不绕开 broker。
- **保留占位符**：`${PACKAGE_DIR}` 在本地展开；`${PORT}` / `${PORT_<NAME>}` 原样
  交给 broker，由中间件分配/仲裁。
- **不直接拉起 `.works`/domain**：部署运行时的启停属于
  `dsh-deploy` / `dsh-runtime-control` 生命周期，本插件首版只做校验与运行态
  引用，避免清单越过中间件直接拉进程。
- **自停保护**：`stop launchpad` 会中断当前 API，默认拒绝（`SELF_STOP_REFUSED`）。
- **dry-run**：先看将发送的 spec/命令，确认后再执行。

## DSH 进程内的只读体检

`cordis.patch.yml` 只挂一个 host：启动时扫描一次清单，输出

```
[dsh-launchpad] 启动清单体检：2 errors / 1 warnings（8 份清单，6 条服务，12ms）
[dsh-launchpad] ✗ [domain-row-missing] 行引用不存在于组件链: missing-row
```

`strict: true` 时有 error 直接拒绝启动 dsh；默认只告警。host 不监听端口、
不写文件、不 spawn，完整 API/启停能力在独立服务里。

## 扫描边界

- 排除 `node_modules`、`.git`、`archives`、`bundles`、`dist`、`release`、
  `.dshd`、`.zcode`、`data`、`logs`、`fixtures` 等；不跟随 symlink；深度上限 8；
  单文件读取上限 1MB；按 realpath 去重。显式把 `--roots` 指到 `fixtures`
  目录时仍会扫描（测试夹具场景）；`*.example.json` / `*.sample.json` /
  `*.template.json` 默认不作为生产清单。
- 源码树里的套件 `services.json` 可能指向 `node_modules/...`（打包态才有）；
  这类条目在源码树会报缺失命令路径，装进 bundle 后再扫描即正常。
- 识别「形状优先、文件名辅助」：先看 JSON 结构，避免把 discovery、suite、
  package-lock 等误判成启动清单。
- 解析器自包含（不 deep-import `dsh-suite-kit` / `dsh-service-broker` 的
  lib 深路径），保证插件可独立分发；深度语义校验仍以
  `dsh-deploy validate` / `dsh-domain validate` 为准。

## 非目标

- 不做可视化 UI、不做 MCP 工具、首版不做清单在线编辑。
- 不在首版一键拉起 `.works`/domain 运行时（需要另接 runtime-control 的服务发现）。
- 不修改任何现有清单；只提供 `services.example.json` 与合并说明。

## 开发与测试

```bash
cd extensions/official/dsh-launchpad
npm test
node ../../../tools/plugin-validator/bin/cli.mjs .
```

测试覆盖：DSL 解析/发射/错误、plugins 块重写、launchpad 管理器 CRUD/校验/
插件 catalog 与 BUNDLE 写回、管理界面静态页与 launchpads API、`dsh-stack.json` 漂移、
`${PACKAGE_DIR}` 展开与 env 脱敏、
works source、domain 行覆盖、跨清单冲突、discovery 优先级、pid/健康探测、
mock broker 的 start/stop/apply、HTTP API 鉴权/CORS/400/404/409、host strict 行为。

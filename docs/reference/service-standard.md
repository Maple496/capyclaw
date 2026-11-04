# DSH 服务解耦标准（2026-11-01 起强制）

> 一句话：**服务与服务彼此独立；各自只守自己的端口；跨端口调动或拉起
> 其他服务，一律交给中间件（dsh-service-broker）。**

## 原则

1. **一服务一进程一端口**。服务是独立进程，不是被 import 进 dsh（或任何
   其他服务）的模块。服务崩溃不拖垮别人，生命周期独立。
2. **能力边界 = 端口边界**。服务能做什么，全部通过自己端口上的 HTTP 面
   暴露（业务路由 + 标准健康/指标）；不向别的进程伸手要对象、不改别人
   的内存/状态。
3. **启动清单不碰进程**。清单（services.json / 作品 / 桌面后端声明）只
   产生**结构化命令**，投递给中间件执行；任何组件不得直接 spawn 另一个
   端口服务。
4. **中间件是唯一组织者**。dsh-service-broker 负责按命令拉起、拓扑排序
   （requires）、端口分配与冲突仲裁、健康等待、keepAlive 守护、discovery
   登记、停机回收。
5. **dsh 进程内只留中间件一个插件**。业务代码、静态资源、技能内容一律
   不再通过 cordis insert 进 dsh；dsh 与服务之间只经 loopback HTTP/MCP。

## 服务规格（spec）

与桌面后端 `works_services` 契约对齐（同一形状可双向投递）：

```json
{
  "id": "ppt-workbench",
  "cmd": ["node", "…/server/relay.mjs", "--port", "${PORT}"],
  "env": { "KEY": "${SOME_VAR}" },
  "cwd": "…",
  "ports": { "main": 39311, "flow": "auto" },
  "url": "http://127.0.0.1:${PORT}",
  "healthPath": "/healthz",
  "keepAlive": true,
  "requires": ["dep"]
}
```

- `${PORT}` / `${PORT_<NAME>}` 端口占位符：`"auto"` 由中间件现场分配；
  其余 `${VAR}` 从环境展开，缺失 → 空串（诚实降级）。
- `requires` 只在中间件里解析（拓扑排序，成环报错）。

## 服务必须提供的 HTTP 面

| 端点 | 必须 | 形状 |
|------|------|------|
| `GET /healthz` | ✅ | 200 + `{ ok, service, pid, port, … }`（**pid 必报**，中间件靠它收编/核验身份） |
| `GET /metrics` | 建议 | 文本/JSON 指标 |
| 业务路由 | ✅ | 一切能力都走这里 |

独立入口约定：`node <service>/server.mjs [--port N] [--dir <dataDir>]`，
收到 SIGINT/SIGTERM 优雅退出。

## 生命周期归属

| 动作 | 归谁 |
|------|------|
| 拉起 / 重启 / 守护 / 停止 | 中间件（`POST /control/apply`、`/control/start`、`/control/stop`） |
| 复用仲裁 | 中间件（端口上有健康实例 → 收编；被占且不健康 → 诚实失败，不抢） |
| 发现 | 只读 discovery（`~/.dsh/services.json`），谁都不许据此直接拉别人 |
| 身份核验 | 中间件 stop 前比对 discovery pid 与健康端点自报 pid |

## 投递入口（中间件控制端点，只绑 127.0.0.1）

```
POST /control/apply   { commands: [{op:"up",service:spec} | {op:"stop",id}] }
POST /control/start   { id } 或 { service: spec }
POST /control/stop    { id }
GET  /control/list | /control/doctor?id= | /healthz
```

设 `DSH_BROKER_TOKEN` 后需带 `x-broker-token`。

## 形态迁移对照（旧 → 新）

| 旧（已废弃） | 新 |
|------|------|
| `cordis.patch.yml` insert 业务插件（进程内 host.mjs 拉端口） | 服务 standalone 入口 + broker 清单一行 spec |
| `ctx.provide` / `inject` 进程内对象共享 | 服务 HTTP API；消费方走 loopback 调用 |
| `ctx.skills.registerProvider` 进程内技能注册 | dsh-skills 服务（HTTP）+ broker 的 ctx.skills 瘦客户端 |
| setup.mjs 追加 host 行 | setup.mjs 装 broker + 写 manifest + 只保留 MCP/UI 行 |
| 服务写死别人端口 | 端口来自 spec（固定或 auto），别人只读 discovery |

## 违例判据（自查）

- 代码里出现 `http.createServer` 且该模块被 insert 进 dsh → 违例
- 插件 A spawn 插件 B 的进程 → 违例（应投递命令给中间件）
- 代码里写死**别人服务**的端口并直连 → 违例（应读 discovery 或经中间件）
- 清单/安装脚本直接 spawn 服务 → 违例（只生成 spec 投递）

## domain runtime 的落地方式（2026-11-03）

`dsh-suite-kit` 的 domain / `.works` 部署现在也遵守本标准的同一路径：

1. suite 根 `services.json` 是服务清单（broker spec 形状，通常由套件维护）；
2. `createRuntime` 把它物化成 `<runtime>/service-manifest.json`：
   - `portFrom: "content"` → 主端口绑到 runtime content 端口（PPT relay 与 MCP/检查同端口）；
   - `dirFrom: "contentState"` → `--dir` 指向 runtime 内容目录；
   - `${PACKAGE_DIR}/node_modules/<pkg>` 展开为包实际目录；
3. `startRuntime` 拉起 `dsh-service-broker`（独立进程），由 broker 按清单拉起/守护/登记服务；
   runtime 只拉起中间件，不直接 spawn 业务服务；
4. broker 的 discovery 指向 `<runtime>/services.json`，dsh 进程通过 `DSH_DISCOVERY_FILE` 读同一张表；
5. `stopRuntime` 先停 broker（防 keepAlive 复活），再按 discovery PID 补杀 detached 服务。

PPT 是首个消费者：`dsh-ppt-suite/services.json` 里 `ppt-workbench` 声明 `portFrom: "content"`，
relay standalone 入口从 `DSH_RUNTIME_FILE` 接上当前 runtime 的 workspace store，不再退化成全局文件库。

## 参考实现

- 中间件：`packages/dsh-service-broker`（README 有全部端点与 spec 说明）
- 服务标准件：`packages/dsh-service-host`（`createServiceApp`：路由/静态/
  healthz/metrics/单实例锁/优雅关闭）
- 合规样板：`extensions/official/dsh-port-sidebar`（只注入 URL，不拉服务）
- 已迁移服务：`bridges/ppt-bridge/plugin/dsh-ppt-workbench`（relay standalone）

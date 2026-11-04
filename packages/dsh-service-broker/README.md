# dsh-service-broker

DSH 服务中间件。服务解耦标准的执行者：**启动清单/后端/用户不直接拉服务，
一切结构化命令投递到这里，由中间件把每个服务作为独立进程拉起、守护、登记。**

原则对应关系：

| 原则 | 本插件的做法 |
|------|--------------|
| 服务彼此独立 | 每个服务 = 独立进程 + 独立端口，互不感知、不互相带动 |
| 能做什么局限在自己的端口里 | 引擎只按 spec 拉起/回收，不解释服务内容 |
| 跨端口调动交给中间件 | `requires` 拓扑、端口分配、复用/冲突仲裁、discovery 都在这里 |
| 不硬耦合 | 引擎零 dsh 依赖；embedded（cordis 插件壳）与 standalone（独立端口）同一份逻辑 |

## 两种形态

### standalone（桌面/外部场景的主形态）

```bash
node server.mjs [--port 39610] [--manifest services.json] [--stop-on-exit]
```

- 开机清单：`--manifest` 指向的 JSON（`{"services":[…spec]}` 或裸数组）幂等拉起；
- 之后外部（如桌面后端）把结构化命令投递到控制端点。

### embedded（dsh 场景）

cordis insert 唯一一行（`cordis.patch.yml`），config：

```yaml
- insert:
    - id: service-broker
      name: "dsh-service-broker"
      config:
        manifest: "C:/…/services.json"   # 开机清单（可省略=待命）
        controlPort: 0                    # >0 时embedded 也开控制端点
        stopOnUnload: false               # true=插件卸载时全停（默认服务独立存活）
        skills:
          url: "http://127.0.0.1:39321"   # 可选：ctx.skills 瘦客户端数据源
```

## 服务规格 spec（与桌面后端 works_services 契约对齐）

```json
{
  "id": "ppt-workbench",
  "cmd": ["node", "…/server.mjs", "--port", "${PORT}"],
  "env": { "EXAMPLE": "${SOME_VAR}" },
  "cwd": "…",
  "ports": { "main": 39311, "extra": "auto" },
  "url": "http://127.0.0.1:${PORT}",
  "healthPath": "/healthz",
  "keepAlive": true,
  "requires": ["dep-service"]
}
```

- `${PORT}` / `${PORT_<NAME>}`：端口占位符（auto 由中间件现场分配；固定端口原样使用）；
  cmd/env/url/cwd 里都可引用；其余 `${VAR}` 从环境展开，缺失 → 空串（诚实降级）。
- `requires`：中间件按闭包拓扑排序拉起（成环报错）；只在本批内解析。
- `keepAlive`：默认 true，进程死亡由守护按**原端口**自动重启（连续失败限次）。

## 结构化命令投递（控制端点，只绑 127.0.0.1）

```
GET  /healthz            中间件自身健康
GET  /control/list       服务全量列表（含 running/pid/ports/url）
POST /control/apply      { commands: [{op:"up",service:spec} | {op:"stop",id}], waitMs? }
POST /control/start      { id }（重放清单/上次规格）或 { service: spec }
POST /control/stop       { id }（pid 身份核验后 taskkill /T /F）
GET  /control/doctor?id  存活 + 健康端点体检
```

设置 `DSH_BROKER_TOKEN` 后，`/control/*` 需带 `x-broker-token` 头。

## discovery 注册表

`~/.dsh/services.json`（可 `--discovery`/`config.discoveryPath` 改）：

```json
{ "version": 1, "updatedAt": "…", "services": {
    "ppt-workbench": { "id": "…", "state": "running", "url": "http://127.0.0.1:39311",
                       "healthPath": "/healthz", "pid": 1234, "ports": {"main": 39311},
                       "keepAlive": true, "reused": false, "startedAt": "…" } } }
```

UI/侧栏/其他工具只读这张表做发现，**永远不直接拉起别人**。

## 复用优先（幂等）

`up` 前先看目标端口：已有健康实例（`/healthz` 200 且自报 pid）→ 收编复用，
不重启；被不健康进程占用 → 诚实失败，不抢端口。

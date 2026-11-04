# dsh-runtime-control

控制面插件，提供：

```js
ctx.runtimeControl.list()
ctx.runtimeControl.create({ name, domainInput })
ctx.runtimeControl.start(runtimeId)
ctx.runtimeControl.stop(runtimeId)
ctx.runtimeControl.doctor(runtimeId)
ctx.runtimeControl.remove(runtimeId)
```

同时可在 `config.port` 上启动 loopback HTTP 控制端点：

```text
GET  /healthz
GET  /control/list
GET  /control/show?runtimeId=
GET  /control/doctor?runtimeId=
GET  /control/services
GET  /control/catalog
GET  /control/resolve?domain=
POST /control/create
POST /control/start
POST /control/stop
POST /control/remove
POST /control/gc
```

它只应在控制面 runtime 中挂载，不应把控制面自身作为 worker 管理。

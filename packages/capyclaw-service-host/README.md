# @capyclaw/service-host

DSH 公共服务宿主插件。功能插件通过 `ctx.serviceHost` 获得统一的 HTTP 运行时，不必再为每个插件复制 relay/路由/健康/指标/锁/静态资源代码。

## 使用

```js
export const inject = ['serviceHost']

export function apply(ctx, config) {
  const app = ctx.serviceHost.createApp({
    id: 'my-plugin',
    title: 'My Plugin',
    version: '1.0.0',
    contractVersion: '1.0.0',
    health: () => ({ ready: true }),
    metrics: () => [['my_items', 3]],
  })
  app.use(myRoutes)
  await app.listen({
    port: config.port,
    hostDir: config.hostDir,
    strictPort: config.strictPort,
  })
  return () => app.close()
}
```

独立运行：

```js
import { createServiceApp } from 'dsh-service-host/src'
const app = createServiceApp({ id: 'my-plugin' })
app.get('/ping', (req, res) => res.end('pong'))
const info = await app.listen({ port: 39500 })
```

嵌入 DSH Web：

```js
await app.listen({ webServer: ctx.webServer, basePath: '/plugins/my-plugin' })
```

## 共享宿主（多插件一个端口）

```js
const host = ctx.serviceHost.createSharedHost({ id: 'dsh-app' })
host.mount('/plugins/ppt', pptApp)
host.mount('/plugins/canvas', canvasApp)
await host.listen({ port: 3080 })
```

子 app 仍由 `createServiceApp()` 创建；共享宿主只做前缀分发和统一生命周期。

## 提供什么

- `createServiceApp(options)`：路由、静态、健康、指标、生命周期
- `createServiceHost(config)`：插件侧工厂
- 标准 `/healthz`：`{ ok, service, name, version, contractVersion, pid, port, uptimeSec, ...业务字段 }`
- 标准 `/metrics`：`<slug>_up`、`<slug>_uptime_seconds`、`<slug>_port` + 业务指标
- standalone：端口扫描、`strictPort`、复用探测、单实例锁、discovery 文件、优雅关闭
- embedded：注册到 `ctx.webServer` 的 `<basePath>` 前缀

## 边界

- 不拥有业务状态；状态用 `@capyclaw/state-service`
- 不拥有资产；资产用 `dsh-asset-service`
- 不拥有编辑器；编辑器用 `dsh-editor-host`

# dsh-mcp-gateway

DSH 公共 MCP 网关插件。把多个插件各自的 `/mcp` 工具面聚合成一个外部端点，外部 MCP 客户端只连网关。

## 使用

```js
export const inject = ['mcpGateway']

const gateway = ctx.mcpGateway.createGateway({
  servers: [
    { name: 'ppt', url: 'http://127.0.0.1:39311/mcp' },
    { name: 'canvas', url: 'http://127.0.0.1:39411/mcp' },
  ],
})
await gateway.refresh()
const app = ctx.serviceHost.createApp({ id: 'mcp-gateway' })
app.use(gateway.routes())
await app.listen({ port: 39500 })
```

或者作为独立插件启动：

```json
{
  "id": "mcp-gateway",
  "name": "dsh-mcp-gateway",
  "config": {
    "port": 39500,
    "servers": [
      { "name": "ppt", "url": "http://127.0.0.1:39311/mcp" }
    ]
  }
}
```

## 行为

- `refresh()`：依次向上游 `initialize` + `tools/list`，失败的上游只记录错误，不影响其他上游。
- 工具名唯一时保持原名；冲突时自动加 `<server>_` 前缀。
- `tools/call` 按工具名路由到对应上游。
- `/healthz` 暴露 `{ upstreams, tools, lastError }`。

## 边界

- 不执行插件业务，只做 MCP 协议聚合/路由。
- 不做持久化、不做鉴权；本地 loopback 使用。
- 同进程插件优先用 `ctx.toolHost.registerWithDsh()`，网关主要服务跨进程/外部客户端。

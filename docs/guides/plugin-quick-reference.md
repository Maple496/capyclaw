# DSH 插件开发快速参考

## 创建

```bash
cd plugin-development

# service + suite + domain
node create-plugin.mjs --name dsh-my-service --type service --port 39500 \
  --out ./my-plugins --domain my-service --yes

# 带 UI
node create-plugin.mjs --name dsh-my-ui --type ui --port 39501 \
  --out ./my-plugins --domain my-ui --yes

# 只有生命周期
node create-plugin.mjs --name dsh-mini --type minimal --out ./my-plugins --yes
```

## 标准目录

```text
plugin/
├── package.json
├── cordis.patch.yml
├── lib/host.mjs
├── server/relay.mjs         # 业务装配（宿主/工具/资产/编辑器来自公共插件）
├── server/tools.mjs         # defineTool / defineCapability / registry
├── server/impl.mjs          # 业务实现
├── server/shared/           # 公共插件 + kit 的构建期快照
├── contract/*.json
└── test/plugin.test.mjs
```

## 公共插件

| 服务 | 用途 |
|---|---|
| `ctx.serviceHost` | HTTP 路由、健康、指标、锁、复用、静态 |
| `ctx.toolHost` | 能力 DSL、注册表、校验、契约、MCP |
| `ctx.state` | 状态、journal、checkpoint、恢复 |
| `ctx.assets` | sha256 对象资产、`/assets` |
| `ctx.editorHost` | 编辑器托管、租约、心跳 |

功能插件不要自己写 relay/MCP/store/routes；使用公共插件或 `server/shared/*` 快照。

## 最小 host

```js
export const name = 'my-host'

export async function apply(ctx, config) {
  const { startService } = await import('../server/relay.mjs')
  const service = await startService({ port: config?.port || 39500 })
  return async () => { await service.stop() }
}
```

## MCP 工具

```js
import { defineTool, defineCapability, createRegistry } from './shared/tool-host.mjs'

const echo = defineTool({
  name: 'my_service_echo',
  description: '回显文本',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', maxLength: 2000 } },
    required: ['text'],
  },
  handler: ({ text }) => ({ content: [{ type: 'text', text }] }),
})

const capability = defineCapability({
  id: 'my-service',
  title: 'My Service',
  tools: [echo],
})

export const registry = createRegistry([capability])
export const tools = registry.TOOLS
export const callTool = (name, args) => registry.TOOL_IMPL[name]?.(args)
```

## cordis.patch.yml

```yaml
- insert:
    - id: my-service-host
      name: dsh-my-service
      config:
        port: 39500
    - id: mcp-my-service
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: my-service
        transport: streamable-http
        url: http://127.0.0.1:39500/mcp
        failOnStartupError: false
        toolCallTimeoutMs: 120000
```

## suite manifest 关键字段

```json
{
  "name": "dsh-my-service-suite",
  "version": "1.0.0",
  "packages": {
    "dsh-my-service": {
      "role": "runtime",
      "version": "^1.0.0",
      "path": "../dsh-my-service",
      "provides": {
        "tools": ["my_service_*"],
        "ports": [39500],
        "capabilities": { "my-service.runtime": "1.0.0" }
      }
    }
  },
  "rows": [
    { "id": "my-service-host", "name": "dsh-my-service" }
  ],
  "checks": [
    { "id": "my-health", "type": "http", "url": "http://127.0.0.1:39500/healthz", "expectStatus": 200 }
  ]
}
```

## 常用命令

```bash
# 测试插件
cd my-plugins/my-service/plugin/my-service && npm run validate-plugin -- .

# 同步公共插件到 server/shared
node scripts/sync-shared.mjs \
  --out my-plugins/my-service/plugin/my-service/server/shared --force

# 校验 suite / domain
node packages/capyclaw-suite-kit/bin/dsh-suite.mjs validate my-plugins/my-service/plugin/my-service-suite
node packages/capyclaw-suite-kit/bin/dsh-domain.mjs validate my-plugins/my-service/domains/my-service

# 安装
dsh plugin --profile web add /abs/path/to/plugin
node packages/capyclaw-suite-kit/bin/dsh-suite.mjs install /abs/path/to/suite --profile web

# 打包
node pack-plugin.mjs my-plugins/my-service/plugin/my-service

# 构建 bundle
node scripts/build-bundle.mjs --domain bridges/ppt-bridge/domains/ppt --out builds/ppt --target portable
```

## 调试

```bash
curl http://127.0.0.1:39500/healthz
curl http://127.0.0.1:39500/metrics
curl -X POST http://127.0.0.1:39500/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- 端口冲突：同服务会复用；其他服务占用会报错，修改 `cordis.patch.yml` 和 `dsh-suite.json` 的端口。
- 工具不出现：检查 `cordis.patch.yml` 的 MCP row 和 `/healthz`。
- 打包缺文件：检查 `package.json.files`；打包器会自检并报错。

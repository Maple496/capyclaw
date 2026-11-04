# @capyclaw/tool-host

DSH 公共工具面插件。把每个插件都会重复写的工具声明、注册表、参数校验、契约报告、MCP 协议壳和 instructions 模板收成一套。

## 使用

```js
export const inject = ['toolHost']

const echo = ctx.toolHost.defineTool({
  name: 'demo_echo',
  description: '回显文本',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: ({ text }) => ({ content: [{ type: 'text', text }] }),
})

const capabilities = [
  ctx.toolHost.defineCapability({ id: 'demo', title: 'Demo', tools: [echo] }),
]

const registry = ctx.toolHost.createRegistry(capabilities)
const mcp = ctx.toolHost.createMcpHandler({
  registry,
  instructions: ctx.toolHost.buildInstructions({ title: 'Demo', capabilities: registry.CAPABILITIES }),
})
```

## 原生 DSH 工具面

```js
export const inject = ['toolHost']

export function apply(ctx) {
  const registry = ctx.toolHost.createRegistry(capabilities)
  const dispose = ctx.toolHost.registerWithDsh(ctx, registry, { namespace: 'demo' })
  return dispose
}
```

注册后工具直接出现在 `ctx.tools`，不需要 loopback `/mcp` 和 `dsh-mcp-client` row。
MCP handler 仍保留给跨进程/外部客户端。

## 提供什么

- `defineTool` / `defineCapability`：声明式能力 DSL
- `createRegistry`：校验 id/工具名/依赖/服务唯一性，派生 `TOOLS / TOOL_IMPL / TOOL_META / FEATURES / CAPABILITIES`
- `createToolDispatcher`：统一参数校验后分派
- `createMcpHandler`：MCP Streamable HTTP（initialize / ping / tools/list / tools/call）
- `createCapabilityReport`：契约报告
- `buildInstructions`：MCP server instructions 模板

## 边界

- 不绑定具体插件；PPT 只是第一个消费者
- 不负责 HTTP 监听；和 `dsh-service-host` 组合使用
- 不负责契约快照文件；由构建脚本调用 `registry.ctx.contract.report()` 生成

/** dsh-mcp-gateway 插件：提供 ctx.mcpGateway，把多个插件 MCP 工具面聚合成一个端点。 */
import { createMcpGatewayHost } from '../src/index.mjs'

export const name = 'mcp-gateway'

function safeGet(ctx, name) {
  try { return ctx?.get ? ctx.get(name) : null } catch { return null }
}

export async function apply(ctx, config = {}) {
  const host = createMcpGatewayHost(config)
  const service = host.createGateway()
  const dispose = ctx.provide('mcpGateway', service)
  let info = null
  if (config.port) {
    info = await service.start({
      port: Number(config.port),
      hostDir: config.hostDir,
      strictPort: config.strictPort,
      lockFile: config.lockFile,
      serviceHost: safeGet(ctx, 'serviceHost'),
    })
    console.log(`[mcp-gateway] ${info.reused ? '复用' : '启动'}: ${info.url}/mcp`)
  }
  return async () => {
    await service.stop()
    if (typeof dispose === 'function') dispose()
  }
}

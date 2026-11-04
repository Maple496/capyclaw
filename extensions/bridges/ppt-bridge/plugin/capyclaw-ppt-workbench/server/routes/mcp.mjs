/** MCP 端点路由：协议细节由 server/mcp/handler 处理。 */
import { send } from '../http-utils.mjs'

export function createMcpRoutes({ mcpHandler, getMcpHandler } = {}) {
  return [
    async (req, res, u) => {
      if (u.pathname !== '/mcp') return false
      const handler = typeof getMcpHandler === 'function' ? getMcpHandler() : mcpHandler
      if (!handler) {
        send(req, res, 503, { ok: false, error: 'MCP tools not ready' })
        return true
      }
      await handler(req, res)
      return true
    },
  ]
}

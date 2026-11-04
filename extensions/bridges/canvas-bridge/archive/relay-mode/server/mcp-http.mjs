/**
 * MCP JSON-RPC 分发（零依赖）：覆盖 initialize / ping / tools/list / tools/call。
 * 传输层由 relay.mjs 提供（streamable-http，JSON 响应）；也可被 stdio 复用。
 */
import { TOOLS, TOOL_IMPL, serverInstructions } from './tools.mjs'

export const PROTOCOL_VERSION = '2024-11-05'

const reply = (id, result) => ({ jsonrpc: '2.0', id, result })
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

export function createMcpHandler() {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object') return error(null, -32600, 'invalid request')
    const { id, method, params } = msg

    /* 通知：无 id，不回包 */
    if (typeof method === 'string' && method.startsWith('notifications/')) return null

    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'canvas-bridge', version: '1.0.0' },
        instructions: serverInstructions(process.env.CANVAS_BRIDGE_URL || ''),
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') return reply(id, { tools: TOOLS })
    if (method === 'tools/call') {
      const name = params && params.name
      const impl = TOOL_IMPL[name]
      if (typeof impl !== 'function') return error(id, -32602, 'unknown tool: ' + name)
      try {
        return reply(id, await impl((params && params.arguments) || {}))
      } catch (e) {
        return reply(id, {
          content: [{ type: 'text', text: '工具执行失败: ' + ((e && e.message) || String(e)) }],
          isError: true,
        })
      }
    }
    return error(id, -32601, 'method not found: ' + method)
  }
}

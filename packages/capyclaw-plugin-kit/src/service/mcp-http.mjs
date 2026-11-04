/**
 * 通用 MCP Streamable HTTP 处理器。
 *
 * 只实现工具面所需的最小协议：initialize / ping / tools/list / tools/call。
 * 所有工具调用在进入业务实现前先经过 validateToolArguments。
 */
import { readBody, send } from './http.mjs'
import { validateToolArguments } from '../tools/validate.mjs'

const DEFAULT_PROTOCOL = '2024-11-05'

function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

function reply(id, result) {
  return { jsonrpc: '2.0', id, result }
}

export function createMcpHandler({
  tools = [], callTool, serverInfo, instructions,
  maxBodyBytes = 10 * 1024 * 1024, maxBatch = 100,
} = {}) {
  if (!Array.isArray(tools)) throw new Error('createMcpHandler: tools 必须是数组')
  if (typeof callTool !== 'function') throw new Error('createMcpHandler: callTool 必须是函数')

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))

  return async function handle(req, res) {
    /* 长工具调用（如截图）期间客户端可能超时断连；socket 的 'error' 事件
       无人监听会打崩进程。挂空处理器，配合 send() 的断连防护。 */
    res.on('error', () => {})
    if (req.method !== 'POST') {
      if (res.destroyed) return
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      return res.end('MCP endpoint: POST only')
    }

    let msg
    try {
      msg = await readBody(req, maxBodyBytes)
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        return send(req, res, 413, rpcError(null, -32600, 'Request body too large'))
      }
      return send(req, res, 400, rpcError(null, -32700, 'Parse error'))
    }

    if (!msg || typeof msg !== 'object') {
      return send(req, res, 400, rpcError(null, -32600, 'Invalid Request'))
    }

    const batch = Array.isArray(msg)
    if (batch && msg.length === 0) {
      return send(req, res, 400, rpcError(null, -32600, 'Invalid Request'))
    }
    if (batch && msg.length > maxBatch) {
      return send(req, res, 400, rpcError(null, -32600, `Batch too large (max ${maxBatch})`))
    }
    const messages = batch ? msg : [msg]
    const replies = []
    for (const message of messages) {
      const result = await handleOne(message, req)
      if (result !== null) replies.push(result)
    }
    if (!replies.length) {
      if (res.destroyed) return
      res.writeHead(202, { 'content-length': 0 })
      return res.end()
    }
    return send(req, res, 200, batch ? replies : replies[0])
  }

  async function handleOne(message, req) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request')
    }

    const { id, method, params } = message
    const isNotification = id === undefined || id === null

    if (typeof method !== 'string' || !method) {
      return isNotification ? null : rpcError(id, -32600, 'Invalid Request')
    }

    if (method === 'initialize') {
      const result = {
        protocolVersion: String(params?.protocolVersion || DEFAULT_PROTOCOL),
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo || { name: 'dsh-plugin', version: '0.0.0' },
      }
      if (typeof instructions === 'string' && instructions) result.instructions = instructions
      return isNotification ? null : reply(id, result)
    }

    if (method === 'notifications/initialized' || method === 'initialized') return null
    if (method === 'notifications/cancelled' || method === 'notifications/cancel') return null
    if (method === 'ping') return isNotification ? null : reply(id, {})

    if (method === 'tools/list') {
      return isNotification ? null : reply(id, { tools })
    }

    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      const tool = toolMap.get(name)
      if (!tool) {
        if (isNotification) return null
        return reply(id, {
          content: [{ type: 'text', text: `未知工具: ${String(name)}` }],
          isError: true,
        })
      }

      const check = validateToolArguments(tool, args)
      if (!check.ok) {
        if (isNotification) return null
        return reply(id, {
          content: [{ type: 'text', text: '参数不合法：' + check.errors.join('；') }],
          isError: true,
        })
      }

      try {
        const out = await callTool(name, args, { req })
        if (out && Array.isArray(out.content)) return reply(id, out)
        return reply(id, { content: [{ type: 'text', text: out?.text || 'ok' }] })
      } catch (error) {
        if (isNotification) return null
        return reply(id, {
          content: [{ type: 'text', text: '工具失败：' + String((error && error.message) || error) }],
          isError: true,
        })
      }
    }

    return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`)
  }
}

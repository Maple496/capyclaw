/**
 * dsh-mcp-gateway —— 多插件 MCP 工具聚合网关。
 *
 * 外部 MCP 客户端只连一个端点；网关向上游多个插件的 /mcp 拉取 tools/list，
 * 按工具名路由 tools/call。适合 DSH 外部客户端、IDE、桌面自动化统一接入。
 *
 * 不做的事：不执行插件业务、不持久化状态、不替代 dsh-tool-host。
 */
import { createServiceApi } from '@capyclaw/plugin-kit/service/api'
import { createMcpHandler } from '@capyclaw/tool-host/src'
import { createServiceApp } from '@capyclaw/service-host/src'
import { send } from '@capyclaw/plugin-kit/service/http'

let rpcId = 0

/* 上游 RPC 默认超时 30s：慢工具（如 ppt 截图链 ~21s）经网关调用时，
 * 15s 会在工具仍正常执行时误杀；30s 覆盖最慢真实工具 + 43% 余量
 * （进化评估确认超时只影响挂死上游的中止速度，不影响健康路径）。 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000

async function rpc(url, method, params, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS, headers = {}) {
  const body = { jsonrpc: '2.0', id: ++rpcId, method, params }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(`${url} ${method}: ${json.error.message || JSON.stringify(json.error)}`)
  return json.result
}

/**
 * @param {{ servers?: Array<{name:string,url:string,headers?:object}>, timeoutMs?:number }} config
 */
export function createMcpGateway(config = {}) {
  const servers = (config.servers || []).map((server, index) => {
    if (!server?.url) throw new Error(`mcp-gateway: servers[${index}] 缺少 url`)
    return {
      name: server.name || `server-${index + 1}`,
      url: server.url,
      headers: server.headers || {},
    }
  })
  let routes = new Map()
  let exposed = []
  let lastError = ''

  async function initialize(server) {
    try {
      await rpc(server.url, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-gateway', version: '0.1.0' },
      }, config.timeoutMs, server.headers)
      await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...server.headers },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(config.timeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS),
      }).catch(() => {})
    } catch { /* 无状态 MCP 允许直接 tools/list */ }
  }

  async function refresh() {
    const nextRoutes = new Map()
    const nextExposed = []
    const errors = []
    const nameCount = new Map()
    const lists = []
    for (const server of servers) {
      try {
        await initialize(server)
        const result = await rpc(server.url, 'tools/list', {}, config.timeoutMs, server.headers)
        const tools = Array.isArray(result?.tools) ? result.tools : []
        for (const tool of tools) nameCount.set(tool.name, (nameCount.get(tool.name) || 0) + 1)
        lists.push({ server, tools })
      } catch (error) {
        errors.push(`${server.name}: ${String(error.message || error)}`)
      }
    }
    for (const { server, tools } of lists) {
      for (const tool of tools) {
        const name = nameCount.get(tool.name) > 1 ? `${server.name}_${tool.name}` : tool.name
        nextExposed.push({ ...tool, name })
        nextRoutes.set(name, { server, tool: tool.name })
      }
    }
    routes = nextRoutes
    exposed = nextExposed
    lastError = errors.join('; ')
    return { tools: exposed, errors, ok: errors.length === 0 }
  }

  async function callTool(name, args = {}) {
    const route = routes.get(name)
    if (!route) throw new Error(`mcp-gateway: 未知工具 ${name}`)
    const result = await rpc(route.server.url, 'tools/call', { name: route.tool, arguments: args }, config.timeoutMs, route.server.headers)
    return result
  }

  const service = {
    api: createServiceApi('mcpGateway', '1.0.0', ['aggregate', 'mcp', 'routing']),
    version: '0.1.0',
    servers,
    async refresh() { return refresh() },
    tools() { return exposed.slice() },
    lastError() { return lastError },
    handler() {
      return createMcpHandler({
        tools: exposed,
        callTool: (name, args) => callTool(name, args),
        serverInfo: { name: config.name || 'dsh-mcp-gateway', version: '0.1.0' },
        instructions: config.instructions || '多插件 MCP 工具聚合网关。先调用 tools/list 查看可用工具。',
      })
    },
    routes() {
      return async (req, res, u) => {
        if (u.pathname !== '/mcp') return false
        if (!exposed.length) {
          send(req, res, 503, { ok: false, error: 'mcp-gateway: 尚未刷新上游工具' })
          return true
        }
        await service.handler()(req, res)
        return true
      }
    },
    async start({ port = 0, hostDir, strictPort, lockFile, serviceHost = null } = {}) {
      await refresh()
      const factory = serviceHost?.createApp ? (options) => serviceHost.createApp(options) : createServiceApp
      const app = factory({
        id: config.id || 'mcp-gateway',
        title: 'MCP Gateway',
        version: '0.1.0',
        contractVersion: '1.0.0',
        health: () => ({ upstreams: servers.length, tools: exposed.length, lastError }),
      })
      app.use(service.routes())
      const info = await app.listen({ port, hostDir, strictPort, lockFile })
      service.app = app
      return info
    },
    async stop() {
      if (service.app) await service.app.close()
      service.app = null
    },
  }
  return service
}

export function createMcpGatewayHost(config = {}) {
  return {
    api: createServiceApi('mcpGateway', '1.0.0', ['aggregate', 'mcp', 'routing']),
    version: '0.1.0',
    createGateway(options = {}) {
      return createMcpGateway({ ...config, ...options })
    },
  }
}

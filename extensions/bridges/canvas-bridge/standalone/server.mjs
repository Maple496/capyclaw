/**
 * standalone/server.mjs
 * 
 * 独立 MCP 服务器：HTTP + stdio 双模式，不依赖桌面系统。
 * 
 * 用法：
 *   node standalone/server.mjs              # stdio 模式（DSH 默认）
 *   node standalone/server.mjs --http 39313 # HTTP 模式（调试）
 */
import http from 'node:http'
import { TOOLS, TOOL_IMPL } from './tools.mjs'
import * as headless from './headless-canvas.mjs'

const isHttp = process.argv.includes('--http')
const port = isHttp ? (process.argv[process.argv.indexOf('--http') + 1] || 39313) : null

/** MCP JSON-RPC 处理 */
async function handleRpc(req) {
  const { id, method, params } = req
  
  try {
    if (method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'canvas-standalone', version: '0.1.0' },
      }
    }
    
    if (method === 'tools/list') {
      return { tools: TOOLS }
    }
    
    if (method === 'tools/call') {
      const { name, arguments: args } = params
      const fn = TOOL_IMPL[name]
      if (!fn) {
        return { isError: true, content: [{ type: 'text', text: `未知工具: ${name}` }] }
      }
      return await fn(args || {})
    }
    
    if (method === 'ping') {
      return {}
    }
    
    throw new Error(`未知方法: ${method}`)
  } catch (e) {
    return { error: { code: -32603, message: String(e.message || e) } }
  }
}

/** HTTP 模式 */
if (isHttp) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404)
      res.end()
      return
    }
    
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const rpcReq = JSON.parse(body)
        const result = await handleRpc(rpcReq)
        const rpcRes = result.error
          ? { jsonrpc: '2.0', id: rpcReq.id, error: result.error }
          : { jsonrpc: '2.0', id: rpcReq.id, result }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rpcRes))
      } catch (e) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
  })
  
  server.listen(port, () => {
    console.log(`[canvas-standalone] HTTP MCP 服务器: http://127.0.0.1:${port}/mcp`)
  })
  
  process.on('SIGINT', async () => {
    await headless.close()
    server.close()
    process.exit(0)
  })
}

/** stdio 模式 */
else {
  const readline = (await import('node:readline')).createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })
  
  readline.on('line', async (line) => {
    try {
      const rpcReq = JSON.parse(line)
      const result = await handleRpc(rpcReq)
      const rpcRes = { jsonrpc: '2.0', id: rpcReq.id, ...result }
      console.log(JSON.stringify(rpcRes))
    } catch (e) {
      console.error('[canvas-standalone] 解析错误:', e.message)
    }
  })
  
  process.on('SIGINT', async () => {
    await headless.close()
    process.exit(0)
  })
  
  process.stderr.write('[canvas-standalone] stdio MCP 服务器已就绪\n')
}

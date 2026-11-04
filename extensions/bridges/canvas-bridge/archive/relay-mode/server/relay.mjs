/**
 * Canvas MCP relay：本机 HTTP 端点，只做 MCP streamable-http（工具实现复用
 * server/tools.mjs，经 bridge-client 连桌面网关的 canvas-bridge）。
 *
 * 与 PPT 工作台 relay 的差异：编辑器与桥都由桌面网关承载（canvas.works
 * 应用内），这里不重复托管编辑器，也不内置 store——单一真源。
 *
 * 独立运行：node server/relay.mjs [--port 39312]
 */
import http from 'node:http'
import { createMcpHandler } from './mcp-http.mjs'
import { BASE } from './bridge-client.mjs'

export const DEFAULT_PORT = 39312
const MAX_BODY = 8 * 1024 * 1024

export function startRelay({ port = DEFAULT_PORT } = {}) {
  const handleMcp = createMcpHandler()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    if (url.pathname === '/health') {
      return json(200, { ok: true, bridge: BASE, mcp: '/mcp' })
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not found' })
    if (req.method === 'GET' || req.method === 'DELETE') {
      return json(405, { error: 'method not allowed' })
    }
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', async () => {
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      } catch (e) {
        return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      }
      try {
        const out = await handleMcp(msg)
        if (!out) { res.writeHead(202); return res.end() }
        return json(200, out)
      } catch (e) {
        return json(500, { jsonrpc: '2.0', id: msg && msg.id,
          error: { code: -32603, message: (e && e.message) || String(e) } })
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      const url = `http://127.0.0.1:${actual}`
      console.log(`[canvas-bridge] MCP relay: ${url}/mcp  (bridge: ${BASE})`)
      resolve({
        url,
        port: actual,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

/* 直接运行：node server/relay.mjs [--port 39312] */
import { pathToFileURL } from 'node:url'
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const i = process.argv.indexOf('--port')
  const port = i >= 0 ? Number(process.argv[i + 1]) : DEFAULT_PORT
  startRelay({ port }).catch((e) => {
    console.error('[canvas-bridge] 启动失败:', e.message)
    process.exit(1)
  })
}

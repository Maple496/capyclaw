import test from 'node:test'
import assert from 'node:assert/strict'
import { listen } from '../src/service/http.mjs'
import { createMcpHandler } from '../src/service/mcp-http.mjs'

const tools = [
  {
    name: 'echo',
    description: 'echo text',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', maxLength: 20 } },
      required: ['text'],
    },
  },
  {
    name: 'capabilities',
    description: 'contract probe',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
]

async function startServer() {
  const handler = createMcpHandler({
    tools,
    serverInfo: { name: 'test-plugin', version: '1.2.3' },
    instructions: 'test instructions',
    callTool: async (name, args) => {
      if (name === 'echo') return { content: [{ type: 'text', text: `echo:${args.text}` }] }
      return { content: [{ type: 'text', text: JSON.stringify({ contractVersion: '1.0.0', tools: tools.map((t) => t.name) }) }] }
    },
  })
  const server = await listen(0, { handler })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function post(base, body, raw = false) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { res, text, json: text ? JSON.parse(text) : null }
}

test('MCP initialize 返回 serverInfo/instructions', async () => {
  const { server, base } = await startServer()
  try {
    const { res, json } = await post(base, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    assert.equal(res.status, 200)
    assert.equal(json.result.protocolVersion, '2025-03-26')
    assert.equal(json.result.serverInfo.name, 'test-plugin')
    assert.equal(json.result.instructions, 'test instructions')
    assert.equal(json.result.capabilities.tools.listChanged, false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('MCP tools/list 返回工具清单', async () => {
  const { server, base } = await startServer()
  try {
    const { json } = await post(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(json.result.tools.map((tool) => tool.name), ['echo', 'capabilities'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('MCP tools/call 正常、参数错误、未知工具', async () => {
  const { server, base } = await startServer()
  try {
    const ok = await post(base, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    })
    assert.equal(ok.json.result.content[0].text, 'echo:hi')

    const badArgs = await post(base, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x'.repeat(30) } },
    })
    assert.equal(badArgs.json.result.isError, true)
    assert.match(badArgs.json.result.content[0].text, /参数不合法/)

    const unknown = await post(base, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'missing', arguments: {} },
    })
    assert.equal(unknown.json.result.isError, true)
    assert.match(unknown.json.result.content[0].text, /未知工具/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('MCP 批量请求与通知', async () => {
  const { server, base } = await startServer()
  try {
    const batch = await post(base, [
      { jsonrpc: '2.0', id: 6, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ])
    assert.equal(batch.res.status, 200)
    assert.equal(batch.json.length, 1)
    assert.deepEqual(batch.json[0].result, {})

    const notification = await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notification.res.status, 202)
    assert.equal(notification.text, '')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('MCP 非法 JSON、空批量和 GET 的处理', async () => {
  const { server, base } = await startServer()
  try {
    const bad = await post(base, '{', true)
    assert.equal(bad.res.status, 400)
    assert.equal(bad.json.error.code, -32700)

    const empty = await post(base, [])
    assert.equal(empty.res.status, 400)
    assert.equal(empty.json.error.code, -32600)

    const get = await fetch(`${base}/mcp`)
    assert.equal(get.status, 405)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('客户端断连：慢工具期间客户端 abort，不崩进程、后续请求可用', async () => {
  let releaseSlow
  const slowGate = new Promise((resolve) => { releaseSlow = resolve })
  const handler = createMcpHandler({
    tools: [
      { name: 'slow', description: 'slow tool', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } },
    ],
    serverInfo: { name: 'test-plugin', version: '1.0.0' },
    callTool: async (name) => {
      if (name === 'slow') { await slowGate; return { content: [{ type: 'text', text: 'slow done' }] } }
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  const server = await listen(0, { handler })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    /* 客户端 80ms 后 abort；工具 300ms 后才完成 → 服务端在已销毁 socket 上写响应 */
    const aborter = new AbortController()
    const abandoned = fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
      signal: aborter.signal,
    }).then(() => 'completed').catch((e) => `aborted:${e.name}`)
    setTimeout(() => aborter.abort(), 80)
    setTimeout(() => releaseSlow(), 300)
    const fate = await abandoned
    assert.match(fate, /aborted|completed/)

    /* 进程没被打崩（走到这里即证明），且后续请求正常 */
    const next = await post(base, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    assert.equal(next.res.status, 200)
    assert.equal(next.json.result.content[0].text, 'ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('readBody：客户端中途断连 reject CLIENT_ABORTED 而不是永久挂起', async () => {
  const { readBody } = await import('../src/service/http.mjs')
  const { EventEmitter } = await import('node:events')
  const req = new EventEmitter()
  req.readableEnded = false
  const p = readBody(req, 1024)
  const assertion = p.then(
    () => 'resolved',
    (e) => `rejected:${e.code}`,
  )
  req.emit('close')
  assert.equal(await assertion, 'rejected:CLIENT_ABORTED')
})

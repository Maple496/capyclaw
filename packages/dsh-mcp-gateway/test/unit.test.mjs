import test from 'node:test'
import assert from 'node:assert/strict'
import { createServiceApp } from '@capyclaw/service-host/src'
import { createMcpHandler } from '@capyclaw/tool-host/src'
import { createMcpGateway } from '../src/index.mjs'

async function upstream(name, tools) {
  const app = createServiceApp({ id: name })
  const handler = createMcpHandler({ tools, callTool: (tool, args) => ({ content: [{ type: 'text', text: `${name}:${tool}:${args.text || ''}` }] }) })
  app.use((req, res, u) => {
    if (u.pathname !== '/mcp') return false
    return handler(req, res).then(() => true)
  })
  const info = await app.listen({ port: 0 })
  return { app, url: `${info.url}/mcp` }
}

async function rpc(url, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json()
}

const echo = (name) => ({
  name,
  description: `${name} echo`,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
})

test('mcp-gateway: 聚合两个上游并路由 tools/call', async () => {
  const a = await upstream('alpha', [echo('alpha_echo')])
  const b = await upstream('beta', [echo('beta_echo')])
  const gateway = createMcpGateway({
    servers: [{ name: 'alpha', url: a.url }, { name: 'beta', url: b.url }],
  })
  try {
    const refreshed = await gateway.refresh()
    assert.equal(refreshed.ok, true)
    const names = gateway.tools().map((tool) => tool.name).sort()
    assert.deepEqual(names, ['alpha_echo', 'beta_echo'])

    const app = createServiceApp({ id: 'gateway-test' })
    app.use(gateway.routes())
    const info = await app.listen({ port: 0 })
    try {
      const list = await rpc(`${info.url}/mcp`, 'tools/list')
      assert.equal(list.result.tools.length, 2)
      const call = await rpc(`${info.url}/mcp`, 'tools/call', { name: 'beta_echo', arguments: { text: 'hi' } })
      assert.equal(call.result.content[0].text, 'beta:beta_echo:hi')
    } finally {
      await app.close()
    }
  } finally {
    await a.app.close()
    await b.app.close()
  }
})

test('mcp-gateway: 同名工具自动加服务器前缀', async () => {
  const a = await upstream('alpha', [echo('same')])
  const b = await upstream('beta', [echo('same')])
  const gateway = createMcpGateway({
    servers: [{ name: 'alpha', url: a.url }, { name: 'beta', url: b.url }],
  })
  try {
    await gateway.refresh()
    assert.deepEqual(gateway.tools().map((tool) => tool.name).sort(), ['alpha_same', 'beta_same'])
  } finally {
    await a.app.close()
    await b.app.close()
  }
})

test('mcp-gateway: 上游失败不影响其他工具', async () => {
  const a = await upstream('alpha', [echo('alpha_echo')])
  const gateway = createMcpGateway({
    servers: [{ name: 'alpha', url: a.url }, { name: 'down', url: 'http://127.0.0.1:1/mcp' }],
    timeoutMs: 500,
  })
  try {
    const result = await gateway.refresh()
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.startsWith('down:')))
    assert.deepEqual(gateway.tools().map((tool) => tool.name), ['alpha_echo'])
  } finally {
    await a.app.close()
  }
})

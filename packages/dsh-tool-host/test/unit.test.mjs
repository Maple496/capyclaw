import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defineTool, defineCapability, createRegistry, createMcpHandler,
  createCapabilityReport, buildInstructions, createToolHost, registerWithDsh,
} from '../src/index.mjs'
import { createServiceApp } from '../../dsh-service-host/src/index.mjs'

function demoCapabilities() {
  const echo = defineTool({
    name: 'demo_echo',
    description: '回显文本',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', maxLength: 100 } },
      required: ['text'],
    },
    handler: ({ text }) => ({ content: [{ type: 'text', text }] }),
  })
  const cap = {
    id: 'demo',
    title: 'Demo',
    description: '演示能力',
    tags: ['demo'],
    requires: [],
    dependsOn: [],
    provides: {},
    features: ['echo'],
    tools: [echo],
  }
  return [defineCapability(cap)]
}

test('tool-host: registry derives tools / impl / capabilities', () => {
  const registry = createRegistry(demoCapabilities(), {
    report: (args) => createCapabilityReport({ ...args, contractVersion: '9.9.9', packageVersion: '1.0.0' }),
  })
  assert.equal(registry.TOOLS.length, 1)
  assert.equal(registry.TOOLS[0].name, 'demo_echo')
  assert.equal(registry.CAPABILITIES[0].id, 'demo')
  const report = registry.ctx.contract.report('http://localhost/editor')
  assert.equal(report.contractVersion, '9.9.9')
  assert.equal(report.toolCount, 1)
})

test('tool-host: duplicate tool names rejected', () => {
  const tool = defineTool({ name: 'x', handler: () => ({}) })
  const caps = [
    defineCapability({ id: 'a', tools: [tool] }),
    defineCapability({ id: 'b', tools: [tool] }),
  ]
  assert.throws(() => createRegistry(caps), /重复的工具名/)
})

test('tool-host: MCP initialize / tools/list / tools/call / bad args', async () => {
  const registry = createRegistry(demoCapabilities())
  const mcp = createMcpHandler({
    registry,
    serverInfo: { name: 'demo', version: '1.0.0' },
    instructions: buildInstructions({ title: 'Demo', capabilities: registry.CAPABILITIES }),
  })
  const app = createServiceApp({ id: 'tool-host-test' })
  app.use((req, res, u) => {
    if (u.pathname !== '/mcp') return false
    return mcp(req, res).then(() => true)
  })
  const info = await app.listen({ port: 0 })
  const rpc = async (body) => {
    const res = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json()
  }
  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    assert.equal(init.result.serverInfo.name, 'demo')

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.equal(list.result.tools[0].name, 'demo_echo')

    const ok = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo_echo', arguments: { text: 'hi' } } })
    assert.equal(ok.result.content[0].text, 'hi')

    const bad = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } })
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /必填/)
  } finally {
    await app.close()
  }
})

test('tool-host: instructions template', () => {
  const text = buildInstructions({
    title: 'Demo',
    intro: 'Intro.',
    startup: ['先调用 demo_capabilities'],
    capabilities: [{ title: 'Demo', description: 'desc', tools: ['demo_echo'] }],
    rules: ['不要编造'],
    output: ['简短回复'],
  })
  assert.match(text, /# Demo/)
  assert.match(text, /先调用 demo_capabilities/)
  assert.match(text, /\| Demo \| `demo_echo` \| desc \|/)
  assert.match(text, /不要编造/)
})

test('tool-host: factory shape', () => {
  const host = createToolHost()
  assert.equal(typeof host.defineTool, 'function')
  assert.equal(typeof host.createRegistry, 'function')
  assert.equal(typeof host.buildInstructions, 'function')
  assert.equal(host.api.name, 'toolHost')
  assert.equal(host.api.version, '1.0.0')
})

test('tool-host: native ctx.tools.register adapter', async () => {
  const registry = createRegistry(demoCapabilities())
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => { definition.disposed = true }
      },
    },
  }
  const dispose = registerWithDsh(ctx, registry, { namespace: 'demo' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'demo_demo_echo')
  assert.equal(typeof registered[0].parameters, 'object')
  const value = await registered[0].execute({ text: 'native' })
  assert.equal(value.content[0].text, 'native')
  assert.deepEqual(registered[0].output.render({}, value), [{ type: 'text', text: 'native' }])
  dispose()
  assert.equal(registered[0].disposed, true)
})

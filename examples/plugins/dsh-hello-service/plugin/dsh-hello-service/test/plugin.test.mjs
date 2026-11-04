import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startService } from '../server/relay.mjs'

async function rpc(url, body) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

test('dsh-hello-service: healthz / metrics / MCP 契约', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-service-test-'))
  const service = await startService({ port: 0, hostDir })
  try {
    const health = await fetch(`${service.url}/healthz`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.name, 'dsh-hello-service')
    assert.equal(health.contractVersion, '1.0.0')

    const metrics = await fetch(`${service.url}/metrics`).then((res) => res.text())
    assert.match(metrics, /hello_service_up 1/)

    const init = await rpc(service.url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    assert.equal(init.result.serverInfo.name, 'dsh-hello-service')

    const list = await rpc(service.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.ok(list.result.tools.some((tool) => tool.name === 'hello_service_capabilities'))

    const call = await rpc(service.url, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'hello_service_capabilities', arguments: {} },
    })
    const payload = JSON.parse(call.result.content[0].text)
    assert.equal(payload.contractVersion, '1.0.0')
  } finally {
    await service.stop()
  }
})

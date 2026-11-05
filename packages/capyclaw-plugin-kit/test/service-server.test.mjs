import test from 'node:test'
import assert from 'node:assert/strict'

import { startStandaloneService } from '../src/service/server.mjs'

test('startStandaloneService exposes canonical health and closes cleanly', async () => {
  const instance = await startStandaloneService({
    service: 'kit-test',
    port: 0,
    health: () => ({ version: '1.0.0', ok: false, pid: -1, port: -1 }),
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('business')
    },
  })

  try {
    const health = await fetch(`${instance.url}/healthz`).then((r) => r.json())
    assert.deepEqual(health, {
      version: '1.0.0',
      ok: true,
      service: 'kit-test',
      pid: process.pid,
      port: instance.port,
    })
    assert.equal(typeof health.port, 'number')
    assert.ok(health.port > 0)

    const business = await fetch(`${instance.url}/work`).then((r) => r.text())
    assert.equal(business, 'business')
  } finally {
    await instance.close()
    await instance.close()
  }

  await assert.rejects(() => fetch(`${instance.url}/healthz`))
})

test('startStandaloneService rejects non-loopback binds and invalid handlers', async () => {
  await assert.rejects(
    () => startStandaloneService({ service: 'bad', host: '0.0.0.0', handler() {} }),
    /loopback/,
  )
  await assert.rejects(
    () => startStandaloneService({ service: 'bad', host: '127.0.0.1' }),
    /handler/,
  )
})

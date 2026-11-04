import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServiceApp, createServiceHost, createSharedHost } from '../src/index.mjs'

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return dir
}

test('service-host: health / metrics / routes / static / 404', async () => {
  const dir = tempDir('dsh-service-host-')
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>')
  const app = createServiceApp({
    id: 'demo-service',
    title: 'Demo Service',
    version: '1.2.3',
    contractVersion: '2.0.0',
    health: () => ({ ready: true }),
    metrics: () => [['demo_items', 7]],
  })
  app.use((req, res, u) => {
    if (u.pathname !== '/api/echo') return false
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return true
  })
  app.static('/ui', dir)
  const info = await app.listen({ port: 0, hostDir: dir, discoveryFile: path.join(dir, 'discovery.json') })
  try {
    assert.equal(info.mode, 'standalone')
    const health = await (await fetch(`${info.url}/healthz`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.service, 'demo-service')
    assert.equal(health.ready, true)

    const metrics = await (await fetch(`${info.url}/metrics`)).text()
    assert.match(metrics, /demo_service_up 1/)
    assert.match(metrics, /demo_items 7/)

    const echo = await (await fetch(`${info.url}/api/echo`)).json()
    assert.deepEqual(echo, { ok: true })

    const page = await (await fetch(`${info.url}/ui/`)).text()
    assert.match(page, /hello/)

    const missing = await fetch(`${info.url}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await app.close()
  }
})

test('service-host: reuse detection and strictPort conflict', async () => {
  const dir = tempDir('dsh-service-host-reuse-')
  const app1 = createServiceApp({ id: 'reuse-demo' })
  const info1 = await app1.listen({ port: 0, hostDir: dir })
  try {
    const app2 = createServiceApp({ id: 'reuse-demo' })
    const info2 = await app2.listen({ port: info1.port, hostDir: dir, allowReuse: true })
    assert.equal(info2.reused, true)
    assert.equal(info2.port, info1.port)
    await info2.stop()

    const app3 = createServiceApp({ id: 'reuse-demo' })
    await assert.rejects(
      () => app3.listen({ port: info1.port, hostDir: path.join(dir, 'other'), allowReuse: false, strictPort: true }),
      /不可用/,
    )
  } finally {
    await app1.close()
  }
})

test('service-host: embedded mode registers prefixed route on webServer', async () => {
  const calls = []
  const webServer = {
    port: 45678,
    register(route) {
      calls.push(route)
      return () => { calls.push({ disposed: route.path }) }
    },
  }
  const app = createServiceApp({ id: 'embedded-demo' })
  app.get('/ping', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('pong')
  })
  const info = await app.listen({ webServer, basePath: '/plugins/embedded-demo' })
  assert.equal(info.mode, 'embedded')
  assert.equal(info.url, 'http://127.0.0.1:45678/plugins/embedded-demo')
  assert.equal(calls[0].kind, 'prefix')
  assert.equal(calls[0].path, '/plugins/embedded-demo')
  await app.close()
  assert.equal(calls[1].disposed, '/plugins/embedded-demo')
})

test('service-host: factory shape', () => {
  const host = createServiceHost({ title: 'x' })
  const app = host.createApp({ id: 'x' })
  assert.equal(app.id, 'x')
  assert.equal(app.title, 'x')
  assert.equal(host.api.name, 'serviceHost')
  assert.equal(host.api.version, '1.0.0')
  assert.equal(typeof host.readBody, 'function')
})

test('service-host: shared host serves multiple child apps on one port', async () => {
  const host = createSharedHost({ id: 'shared-demo' })
  const a = createServiceApp({ id: 'a' })
  const b = createServiceApp({ id: 'b' })
  a.get('/ping', (req, res) => { res.end('a') })
  b.get('/ping', (req, res) => { res.end('b') })
  host.mount('/plugins/a', a)
  host.mount('/plugins/b', b)
  assert.deepEqual(host.children(), ['/plugins/a', '/plugins/b'])
  assert.throws(() => host.mount('/plugins/a', a), /已挂载/)
  const info = await host.listen({ port: 0 })
  try {
    assert.equal(await (await fetch(`${info.url}/plugins/a/ping`)).text(), 'a')
    assert.equal(await (await fetch(`${info.url}/plugins/b/ping`)).text(), 'b')
    const health = await (await fetch(`${info.url}/healthz`)).json()
    assert.deepEqual(health.children, ['/plugins/a', '/plugins/b'])
  } finally {
    await host.close()
  }
})

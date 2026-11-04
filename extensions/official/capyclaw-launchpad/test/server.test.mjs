import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'

import { startServer } from '../lib/serve.mjs'
import {
  FIXTURE,
  FIXTURE_DISCOVERY,
  FIXTURE_DSH_HOME,
  startMockBroker,
} from './helpers.mjs'

const TOKEN = 'test-token'

async function boot() {
  const broker = await startMockBroker()
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    roots: [FIXTURE],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
    discovery: FIXTURE_DISCOVERY,
    brokerUrl: broker.url,
    token: TOKEN,
    env: {},
  })
  const base = instance.url.replace(/\/$/, '')
  const call = async (endpoint, init = {}, withToken = true) => {
    const headers = {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(withToken ? { 'x-launchpad-token': TOKEN } : {}),
      ...(init.headers || {}),
    }
    const res = await fetch(`${base}${endpoint}`, { ...init, headers })
    const text = await res.text()
    let body = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    return { res, body }
  }
  return { broker, instance, base, call }
}

test('archive install requires explicit token and same origin and calls runtime contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launchpad-install-'))
  await mkdir(path.join(root, 'app', 'runtime'), { recursive: true })
  await writeFile(path.join(root, 'app', 'runtime', 'launcher-registry.mjs'), `export async function installArchive({root,buffer,filename}) { return {root, filename, bytes: buffer.toString(), hasToken: process.env.DSH_LAUNCHER_INSTALL_TOKEN === 'install-secret', envRoot: process.env.DSH_PRODUCT_ROOT || null} }`)
  const old = process.env.DSH_LAUNCHER_INSTALL_TOKEN
  const oldRoot = process.env.DSH_PRODUCT_ROOT
  process.env.DSH_LAUNCHER_INSTALL_TOKEN = 'install-secret'
  process.env.DSH_PRODUCT_ROOT = root
  const server = await startServer({ port: 0, host: '127.0.0.1', repoRoot: FIXTURE, installerRootForTests: FIXTURE, token: TOKEN })
  t.after(async () => {
    await server.close()
    if (old === undefined) delete process.env.DSH_LAUNCHER_INSTALL_TOKEN
    else process.env.DSH_LAUNCHER_INSTALL_TOKEN = old
    if (oldRoot === undefined) delete process.env.DSH_PRODUCT_ROOT
    else process.env.DSH_PRODUCT_ROOT = oldRoot
    await rm(root, { recursive: true, force: true })
  })
  const url = `${server.url.replace(/\/$/, '')}/api/launcher/install`
  const headers = { 'x-launchpad-token': TOKEN, 'x-launcher-install-token': 'install-secret', 'content-type': 'application/octet-stream', 'x-archive-filename': 'test.zip' }
  const call = (overrides = {}, body = 'data') => fetch(url, { method: 'POST', headers: { ...headers, ...overrides }, body })
  let res = await call({ 'x-launcher-install-token': 'wrong' })
  assert.equal(res.status, 401)
  res = await call({ origin: 'http://127.0.0.1:9999' })
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  res = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:9999' } })
  assert.equal(res.status, 403)
  res = await call({ 'x-archive-filename': '../bad.zip' })
  assert.equal(res.status, 400)
  res = await call({ 'content-type': 'text/plain' })
  assert.equal(res.status, 415)
  res = await call({}, '')
  assert.equal(res.status, 400)
  res = await call({ origin: server.url.replace(/\/$/, '') })
  const installed = await res.json()
  assert.equal(res.status, 200, JSON.stringify(installed))
  assert.deepEqual(installed.result, { root, filename: 'test.zip', bytes: 'data', hasToken: true, envRoot: root })
  delete process.env.DSH_PRODUCT_ROOT
  res = await call()
  assert.equal(res.status, 503) // explicit fallback points elsewhere, never repoRoot implicitly
  const fallbackServer = await startServer({ port: 0, host: '127.0.0.1', repoRoot: FIXTURE, installerRootForTests: root, token: TOKEN })
  try {
    res = await fetch(`${fallbackServer.url}api/launcher/install`, { method: 'POST', headers, body: 'data' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).result.root, root)
  } finally { await fallbackServer.close() }
  const noRootServer = await startServer({ port: 0, host: '127.0.0.1', repoRoot: root, token: TOKEN })
  try {
    res = await fetch(`${noRootServer.url}api/launcher/install`, { method: 'POST', headers, body: 'data' })
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error.code, 'PRODUCT_ROOT_UNAVAILABLE')
  } finally { await noRootServer.close() }
  delete process.env.DSH_LAUNCHER_INSTALL_TOKEN
  res = await call()
  assert.equal(res.status, 503)
})

test('HTTP API 覆盖 health/inventory/validate/status/actions', async (t) => {
  const { broker, instance, base, call } = await boot()
  t.after(async () => {
    await instance.close()
    await broker.close()
  })

  {
    const { res, body } = await call('/healthz', {}, false)
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.service, 'dsh-launchpad')
    assert.equal(body.pid, process.pid)
    assert.equal(body.port, instance.port)
    assert.equal(typeof body.uptimeSec, 'number')
  }

  {
    const { res } = await call('/api/inventory', {}, false)
    assert.equal(res.status, 401)
  }

  let inventory
  {
    const { res, body } = await call('/api/inventory')
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.summary.manifests, 8)
    assert.equal(body.services.length, 7)
    assert.equal(JSON.stringify(body).includes('_actionSpec'), false)
    inventory = body
  }

  {
    const { res, body } = await call('/api/validate')
    assert.equal(res.status, 200)
    assert.equal(body.ok, false)
    assert.ok(body.issues.some((issue) => issue.code === 'domain-row-missing'))
  }

  {
    const { res, body } = await call('/api/status')
    assert.equal(res.status, 200)
    assert.equal(body.discovery.source, 'flag')
    assert.equal(body.broker.reachable, true)
    const alpha = body.services.find((service) => service.serviceId === 'alpha')
    assert.equal(alpha.state, 'stale')
  }

  {
    const { res, body } = await call('/api/manifests')
    assert.equal(res.status, 200)
    assert.equal(body.manifests.length, 8)
  }

  const local = inventory.manifests.find((manifest) => manifest.relativePath.endsWith('tools/launcher/local-services.json'))
  const self = inventory.manifests.find((manifest) => manifest.relativePath.endsWith('tools/launcher/self-services.json'))
  assert.ok(local)
  assert.ok(self)

  {
    const { res, body } = await call(`/api/manifests/${encodeURIComponent(local.id)}`)
    assert.equal(res.status, 200)
    assert.equal(body.manifest.type, 'broker')
    assert.equal(body.manifest.services.length, 4)
  }

  {
    const { res, body } = await call('/api/services/alpha/start', {
      method: 'POST',
      body: JSON.stringify({ manifestId: local.id, dryRun: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.dryRun, true)
    assert.equal(body.command.op, 'up')
    assert.equal(body.command.service.id, 'alpha')
    assert.equal(body.command.service.cmd[3], '${PORT}')
    assert.ok(body.command.service.cmd[1].includes(path.join('test', 'fixtures', 'repo', 'tools', 'launcher', 'server.mjs')))
  }

  {
    const { res, body } = await call('/api/services/dirsvc/start', {
      method: 'POST',
      body: JSON.stringify({ manifestId: local.id, dryRun: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(body.command.service.env.API_KEY, '***')
  }

  {
    const { res, body } = await call('/api/services/dirsvc/start', {
      method: 'POST',
      body: JSON.stringify({ manifestId: local.id }),
    })
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.command.service.env.API_KEY, '***')
    const request = broker.requests.filter((item) => item.url === '/control/apply').at(-1)
    assert.equal(request.body.commands[0].service.env.API_KEY, 's3cr3t')
  }

  {
    const { res, body } = await call('/api/services/launchpad/stop', {
      method: 'POST',
      body: JSON.stringify({ manifestId: self.id }),
    })
    assert.equal(res.status, 409)
    assert.equal(body.error.code, 'SELF_STOP_REFUSED')
  }

  {
    const { res, body } = await call('/api/services/launchpad/stop', {
      method: 'POST',
      body: JSON.stringify({ manifestId: self.id, dryRun: true, allowSelfStop: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(body.dryRun, true)
  }

  {
    const { res, body } = await call(`/api/manifests/${encodeURIComponent(local.id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ dryRun: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(body.dryRun, true)
    assert.equal(body.commands.length, 4)
  }

  {
    const { res, body } = await call('/api/doctor')
    assert.equal(res.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.actionsAvailable, true)
    assert.ok(Array.isArray(body.checks))
  }

  {
    const { res } = await call('/api/nope')
    assert.equal(res.status, 404)
  }

  {
    const { res, body } = await call('/api/services/alpha/start', {
      method: 'POST',
      body: '{"broken"',
    })
    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'BAD_JSON')
  }

  {
    const res = await fetch(`${base}/api/inventory`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
  }
})

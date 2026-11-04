import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as host from '../lib/host.mjs'
import { HERE, FIXTURE, FIXTURE_DSH_HOME, startMockHealth } from './helpers.mjs'

const PKG = path.join(HERE, '..', 'package.json')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('package.json 满足官方插件规范', () => {
  const pkg = readJson(PKG)
  assert.equal(pkg.name, '@capyclaw/launchpad')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.main)
  assert.ok(existsSync(path.join(HERE, '..', pkg.main)))
  assert.ok(pkg.bin.launchpad)
  assert.ok(existsSync(path.join(HERE, '..', pkg.bin.launchpad)))
  assert.equal(pkg.dsh.category, 'tool')
  assert.equal(pkg.dsh.platform, 'both')
  assert.ok(pkg.dsh.bundle.patch)
  assert.ok(existsSync(path.join(HERE, '..', pkg.dsh.bundle.patch)))
  assert.ok(pkg.dsh.client)
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.equal(pkg.exports['./client'], './client/client.js')
  assert.ok(pkg.dependencies['@capyclaw/plugin-kit'])
  assert.ok(pkg.scripts.test)
  assert.ok(pkg.meta.title)
  assert.ok(pkg.meta.description.length > 10)
  for (const file of ['ui/index.html', 'ui/app.js', 'ui/style.css', 'client/client.js']) {
    assert.ok(existsSync(path.join(HERE, '..', file)), `缺少 ${file}`)
  }
})

test('services.example.json 是合法 broker 服务片段', () => {
  const example = readJson(path.join(HERE, '..', 'services.example.json'))
  assert.ok(Array.isArray(example.services))
  const service = example.services.find((item) => item.id === 'launchpad')
  assert.ok(service)
  assert.equal(service.healthPath, '/healthz')
  assert.ok(service.cmd.some((item) => item.includes('server.mjs')))
  assert.equal(service.ports.main, 39700)
})

test('cordis.patch.yml 只挂一个只读体检 host + UI service 指向', () => {
  const text = readFileSync(path.join(HERE, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(text, /launchpad-host/)
  assert.match(text, /name: "?@capyclaw\/launchpad"?/)
  assert.match(text, /service: launchpad/)
  assert.doesNotMatch(text, /createServer/i)
})

test('client bundle 注册 main + sidebar.panellist，不直接拉服务', () => {
  const text = readFileSync(path.join(HERE, '..', 'client', 'client.js'), 'utf8')
  assert.match(text, /__ModuleLoader__/)
  assert.match(text, /name: 'main'/)
  assert.match(text, /sidebar\.panellist/)
  assert.match(text, /iframe/)
  assert.doesNotMatch(text, /createServer|spawn\(/)
})

test('host 从 discovery 注入 __DSH_LAUNCHPAD__ URL', async () => {
  const health = await startMockHealth({ body: { ok: true, service: 'launchpad', pid: process.pid } })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lp-host-'))
  const oldDiscovery = process.env.DSH_DISCOVERY_FILE
  const originalLog = console.log
  const originalError = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    const discoveryFile = path.join(dir, 'services.json')
    writeFileSync(discoveryFile, JSON.stringify({
      version: 1,
      services: {
        launchpad: { id: 'launchpad', state: 'running', url: health.url, healthPath: '/healthz', pid: process.pid },
      },
    }))
    process.env.DSH_DISCOVERY_FILE = discoveryFile
    let injected = null
    const ctx = {
      on(event, fn) {
        if (event === 'webserver/index-inject') {
          const table = []
          fn(table)
          injected = table
        }
      },
    }
    const dispose = await host.apply(ctx, {
      roots: [FIXTURE],
      dshHome: FIXTURE_DSH_HOME,
      strict: false,
    })
    assert.equal(typeof dispose, 'function')
    assert.ok(injected)
    const row = injected.find((item) => item.name === '__DSH_LAUNCHPAD__')
    assert.ok(row)
    assert.equal(row.kind, 'global')
    assert.equal(row.value.url, `${health.url}/`)
  } finally {
    if (oldDiscovery === undefined) delete process.env.DSH_DISCOVERY_FILE
    else process.env.DSH_DISCOVERY_FILE = oldDiscovery
    console.log = originalLog
    console.error = originalError
    await health.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('host.apply 非 strict 返回 disposer，strict 拒绝启动', async () => {
  const originalLog = console.log
  const originalError = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    const dispose = await host.apply({}, {
      roots: [FIXTURE],
      dshHome: FIXTURE_DSH_HOME,
      strict: false,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()

    await assert.rejects(
      () => host.apply({}, {
        roots: [FIXTURE],
        dshHome: FIXTURE_DSH_HOME,
        strict: true,
      }),
      (error) => error.code === 'LAUNCHPAD_STRICT',
    )
  } finally {
    console.log = originalLog
    console.error = originalError
  }
})

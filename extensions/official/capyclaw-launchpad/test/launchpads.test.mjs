import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createLaunchpadManager, runProcess } from '../lib/launchpads.mjs'
import { startServer } from '../lib/serve.mjs'
import { FIXTURE, FIXTURE_DSH_HOME, HERE } from './helpers.mjs'

const PLUGIN_DIR = path.join(HERE, '..')

function validDsl(name) {
  return [
    `stack "${name}" {`,
    '  kind "profile"',
    '  home "./home"',
    '  profile "web"',
    '  workspace "./workspace"',
    '  stateDir "./state"',
    '  ports { broker "auto" proxy "auto" upstream "auto" }',
    '  plugins {',
    '    bundle "@deepseek-ai/dsh-base"',
    '    bundle "@deepseek-ai/dsh-web-app"',
    '  }',
    '}',
    '',
  ].join('\n')
}

test('启动超时不终止持锁子进程，允许其释放锁', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lp-timeout-'))
  const lock = path.join(dir, 'lock')
  const done = path.join(dir, 'done')
  try {
    const script = `const fs = require('node:fs'); fs.mkdirSync(process.argv[1]); setTimeout(() => { fs.rmSync(process.argv[1], {recursive:true}); fs.writeFileSync(process.argv[2], 'done') }, 600)`
    const result = await runProcess(process.execPath, ['-e', script, lock, done], { timeoutMs: 300, killOnTimeout: false })
    assert.equal(result.timedOut, true)
    const deadline = Date.now() + 5000
    while (!existsSync(done) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(existsSync(done))
    assert.equal(existsSync(lock), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('管理器：create/list/get/save/validate/remove', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lp-'))
  try {
    const manager = createLaunchpadManager({
      launchpadsDir: dir,
      dshd: '',
      hostStateDir: '',
    })
    const created = await manager.create('Demo Mode')
    assert.equal(created.id, 'demo-mode')
    assert.ok(existsSync(path.join(dir, 'demo-mode.stack')))
    assert.match(created.text, /stack "demo-mode"/)

    let list = await manager.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'demo-mode')
    assert.equal(list[0].state, 'stopped')
    assert.equal(list[0].errors.length, 0)

    await manager.save('demo-mode', validDsl('demo-mode'))
    const got = await manager.get('demo-mode')
    assert.match(got.text, /stack "demo-mode"/)
    assert.equal(got.stack.home, path.join(dir, 'home'))
    const validation = await manager.validate('demo-mode')
    assert.equal(validation.ok, true)

    await manager.save('demo-mode', 'stack "demo-mode" {\n  kind "profile"\n')
    const broken = await manager.get('demo-mode')
    assert.equal(broken.state, 'invalid')
    assert.ok(broken.errors.length > 0)

    await manager.save('demo-mode', validDsl('demo-mode'))
    const catalog = manager.catalog()
    assert.ok(catalog.some((plugin) => plugin.name === '@capyclaw/launchpad'))
    assert.ok(catalog.some((plugin) => plugin.name === '@capyclaw/port-sidebar'))
    const withPlugin = await manager.savePlugins('demo-mode', [
      '@deepseek-ai/dsh-base',
      { name: 'dsh-launchpad', path: PLUGIN_DIR },
    ])
    assert.match(withPlugin.text, /plugin "dsh-launchpad"/)
    assert.match(withPlugin.text, /dependency "@capyclaw\/plugin-kit"/)
    assert.equal(withPlugin.profileState.exists, false)
    const pluginView = await manager.get('demo-mode')
    assert.equal(pluginView.stack.plugins.bundles.length, 2)
    assert.ok(pluginView.profileState)
    await assert.rejects(
      () => manager.savePlugins('demo-mode', ['a', 'a']),
      (error) => error.code === 'DUPLICATE_BUNDLE',
    )

    await assert.rejects(() => manager.create('demo-mode'), (error) => error.code === 'LAUNCHPAD_EXISTS')
    await manager.remove('demo-mode')
    list = await manager.list()
    assert.equal(list.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HTTP：管理界面静态页 + launchpads CRUD', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lp-http-'))
  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    roots: [FIXTURE],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
    launchpadsDir: dir,
    dshd: '',
    env: {},
  })
  const base = instance.url.replace(/\/$/, '')
  const call = async (endpoint, init = {}) => {
    const headers = init.body ? { 'content-type': 'application/json' } : {}
    const res = await fetch(`${base}${endpoint}`, { ...init, headers })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { res, body }
  }
  try {
    {
      const { res, body } = await call('/')
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') || '', /text\/html/)
      assert.match(body, /启动清单/)
      assert.match(body, /插件 bundles/)
    }
    {
      const { res, body } = await call('/ui/app.js')
      assert.equal(res.status, 200)
      /* 轮询不重建未变化的列表，服务重启后自动刷新。 */
      assert.match(body, /listSignature/)
      assert.match(body, /checkServer/)
    }
    {
      const { res, body } = await call('/ui/style.css')
      assert.equal(res.status, 200)
      /* [hidden] 必须压过 .empty/.workspace 的 display:flex。 */
      assert.match(body, /\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    }
    {
      const { res, body } = await call('/api/launchpads')
      assert.equal(res.status, 200)
      assert.deepEqual(body.launchpads, [])
      assert.equal(body.dir, dir)
    }
    {
      const { res, body } = await call('/api/launchpads', {
        method: 'POST',
        body: JSON.stringify({ name: 'ui-mode' }),
      })
      assert.equal(res.status, 201)
      assert.equal(body.launchpad.id, 'ui-mode')
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode')
      assert.equal(res.status, 200)
      assert.match(body.launchpad.text, /stack "ui-mode"/)
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode', {
        method: 'PUT',
        body: JSON.stringify({ text: validDsl('ui-mode') }),
      })
      assert.equal(res.status, 200)
      assert.equal(body.launchpad.errors.length, 0)
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode/validate', { method: 'POST' })
      assert.equal(res.status, 200)
      assert.equal(body.ok, true)
    }
    {
      const { res, body } = await call('/api/plugins/catalog')
      assert.equal(res.status, 200)
      assert.ok(body.plugins.some((plugin) => plugin.name === '@capyclaw/launchpad'))
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode/plugins', {
        method: 'PUT',
        body: JSON.stringify({
          bundles: ['@deepseek-ai/dsh-base', { name: 'dsh-launchpad', path: PLUGIN_DIR }],
        }),
      })
      assert.equal(res.status, 200)
      assert.equal(body.launchpad.stack.plugins.bundles.length, 2)
      assert.match(body.launchpad.text, /dependency "@capyclaw\/plugin-kit"/)
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode/plugins')
      assert.equal(res.status, 200)
      assert.equal(body.desired.length, 2)
      assert.ok(body.actual)
      assert.ok(Array.isArray(body.catalog))
    }
    {
      const { res, body } = await call('/api/launchpads/ui-mode', { method: 'DELETE' })
      assert.equal(res.status, 200)
      assert.equal(body.ok, true)
    }
  } finally {
    await instance.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('管理器：domain 型 launchpad 从 runtime.json/discovery 读取运行态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lp-domain-'))
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  try {
    await mkdir(path.join(dir, 'domain'), { recursive: true })
    await writeFile(path.join(dir, 'domain', 'dsh-domain.json'), JSON.stringify({ name: 'probe', version: '1.0.0', components: ['./suite'] }))
    await mkdir(path.join(dir, 'launchpads'), { recursive: true })
    await writeFile(path.join(dir, 'launchpads', 'ppt.stack'), [
      'stack "ppt" {',
      '  kind "domain"',
      '  stateDir "../state"',
      '  ports { broker "auto" proxy "auto" upstream "auto" content 39311 }',
      '  domain { source "../domain" runtimeId "rt-ppt" }',
      '}',
      '',
    ].join('\n'))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const harnessPort = server.address().port
    const stateDir = path.join(dir, 'state')
    const runtimeDir = path.join(stateDir, 'store', 'runtimes', 'rt-ppt')
    await mkdir(runtimeDir, { recursive: true })
    const discoveryFile = path.join(stateDir, 'discovery.json')
    await writeFile(discoveryFile, JSON.stringify({
      version: 1,
      services: { probe: { id: 'probe', state: 'running', pid: process.pid, url: 'http://127.0.0.1:41237', ports: { main: 41237 } } },
    }))
    await writeFile(path.join(runtimeDir, 'runtime.json'), JSON.stringify({
      runtimeId: 'rt-ppt',
      status: 'running',
      ports: { harness: harnessPort, dsh: 0, content: 39311, services: { probe: 41237 } },
      pids: { proxy: process.pid, broker: process.pid },
      services: { ids: ['probe'], discovery: discoveryFile, brokerPort: 0 },
      updatedAt: new Date().toISOString(),
    }))

    const manager = createLaunchpadManager({ launchpadsDir: path.join(dir, 'launchpads'), dshd: '', hostStateDir: '' })
    const item = await manager.get('ppt')
    assert.equal(item.kind, 'domain')
    assert.equal(item.state, 'running')
    assert.equal(item.domain.runtimeId, 'rt-ppt')
    assert.deepEqual(item.services, ['probe'])
    assert.equal(item.status.kind, 'domain')
    assert.equal(item.status.runtimeId, 'rt-ppt')
    assert.equal(item.status.services[0].id, 'probe')
    assert.equal(item.profileState.notApplicable, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

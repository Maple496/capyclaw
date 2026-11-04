import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRuntimeRowOverrides, checkRuntimeRequirements, createRuntime, listRuntimes, readRuntime,
  removeRuntime, resolveDomain, runtimePublicInfo,
} from '../src/index.mjs'
import { WorkspaceManager, WorkspaceClient } from '../../dsh-plugin-kit/src/workspace/manager.mjs'
import { allocateRuntimePorts, readRegistry, startRuntime } from '../src/runtime.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'suite-runtime-'))
  const pluginDir = join(root, 'plugin')
  mkdirSync(pluginDir)
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'dsh-ppt-workbench', version: '1.0.0' }))
  writeFileSync(join(pluginDir, 'index.mjs'), 'export function apply() {}\n')

  const suiteDir = join(root, 'demo-suite')
  mkdirSync(suiteDir)
  writeFileSync(join(suiteDir, 'package.json'), JSON.stringify({
    name: 'demo-suite', version: '1.0.0', type: 'module', main: './index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, suite: './dsh-suite.json' },
  }))
  writeFileSync(join(suiteDir, 'index.mjs'), 'export function apply() {}\n')
  writeFileSync(join(suiteDir, 'cordis.patch.yml'), '- insert:\n    - id: ppt-workbench-host\n      name: "dsh-ppt-workbench"\n')
  writeFileSync(join(suiteDir, 'dsh-suite.json'), JSON.stringify({
    name: 'demo-suite', version: '1.0.0',
    packages: {
      'dsh-ppt-workbench': {
        role: 'runtime', version: '^1.0.0', path: '../plugin',
        provides: { ports: [39311], tools: ['ppt_*'], capabilities: { 'ppt.runtime': '1.0.0' } },
      },
    },
    rows: [
      { id: 'ppt-workbench-host', name: 'dsh-ppt-workbench' },
      {
        id: 'mcp-ppt', name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'ppt', transport: 'streamable-http',
          url: 'http://127.0.0.1:39311/mcp', failOnStartupError: false,
        },
      },
    ],
    checks: [
      { id: 'ppt-health', type: 'http', url: 'http://127.0.0.1:39311/healthz', expectStatus: 200 },
    ],
  }))

  const domainDir = join(root, 'demo-domain')
  mkdirSync(domainDir)
  writeFileSync(join(domainDir, 'dsh-domain.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', title: 'Demo',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: ['../demo-suite'],
    profile: { name: 'domain-demo', port: 3099 },
    runtime: {
      driver: 'node', ttlSec: 3600,
      bindings: [
        {
          row: 'ppt-workbench-host',
          config: {
            port: '${ports.content}',
            hostDir: '${paths.contentState}',
            strictPort: true,
            workId: '${workId}',
          },
        },
      ],
      requires: { tools: ['ppt_*'], capabilities: ['ppt.runtime@^1.0.0'] },
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'ppt', kind: 'content', path: 'content/ppt', patterns: ['state.json', 'checkpoints/**'] },
        ],
        workspace: { workId: 'main', files: ['state.json', 'checkpoints/**'], allowNew: false },
        network: { bind: ['127.0.0.1'] },
      },
      ports: { harness: 0, content: 0, services: { aux: 0 } },
    },
  }))
  return { root, domainDir, suiteDir }
}

test('runtime：两个 runtime 端口/目录/namespace 完全隔离', async () => {
  const f = fixture()
  const storeRoot = join(f.root, 'store')
  const a = await createRuntime({
    name: 'a', domainInput: f.domainDir, storeRoot,
    harnessPort: 0, dshPort: 0, contentPort: 0, runPnpm: false,
  })
  const b = await createRuntime({
    name: 'b', domainInput: f.domainDir, storeRoot,
    harnessPort: 0, dshPort: 0, contentPort: 0, runPnpm: false,
  })
  for (const key of ['harness', 'dsh', 'content']) {
    assert.ok(a.ports[key] > 0)
    assert.notEqual(a.ports[key], b.ports[key])
  }
  assert.ok(a.ports.services.aux > 0)
  assert.notEqual(a.ports.services.aux, b.ports.services.aux)
  assert.notEqual(a.profile, b.profile)
  assert.notEqual(a.store.token, b.store.token)
  assert.ok(a.paths.root.startsWith(storeRoot))
  assert.ok(a.paths.dshHome.startsWith(storeRoot))
  assert.ok(a.paths.sessions.startsWith(a.paths.root))
  assert.equal(a.storage.sessions.path, a.paths.sessions)
  assert.deepEqual(a.storage.files.map((f) => f.id), ['workspace', 'ppt'])
  assert.ok(a.storage.files.every((f) => f.path.startsWith(a.paths.root)))
  assert.deepEqual(listRuntimes(storeRoot).map((r) => r.runtimeId).sort(), [a.runtimeId, b.runtimeId].sort())

  const runtimeA = readRuntime(storeRoot, a.runtimeId)
  assert.equal(runtimeA.rowOverrides['ppt-workbench-host'].config.port, a.ports.content)
  assert.equal(runtimeA.rowOverrides['ppt-workbench-host'].config.strictPort, true)
  assert.equal(runtimeA.rowOverrides['mcp-ppt'].config.url, `http://127.0.0.1:${a.ports.content}/mcp`)
  assert.equal(runtimeA.checks[0].url, `http://127.0.0.1:${a.ports.content}/healthz`)
  assert.deepEqual(runtimeA.requires.tools, ['ppt_*'])
  assert.deepEqual(runtimeA.declaration.files, ['state.json', 'checkpoints/**'])
  assert.equal(runtimeA.declaration.allowNew, false)

  const patch = fs.readFileSync(join(a.paths.dshHome, 'profiles', a.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`"port":${a.ports.content}`))
  assert.match(patch, new RegExp(`127\\.0\\.0\\.1:${a.ports.content}/mcp`))
})

test('runtime：共享 store 下 namespace token 不能跨 runtime 访问', async () => {
  const f = fixture()
  const storeRoot = join(f.root, 'store')
  const a = await createRuntime({ name: 'a', domainInput: f.domainDir, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  const b = await createRuntime({ name: 'b', domainInput: f.domainDir, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  const store = new WorkspaceManager({ storeRoot })
  const ca = new WorkspaceClient({ manager: store, runtimeId: a.runtimeId, token: a.store.token })
  const cb = new WorkspaceClient({ manager: store, runtimeId: b.runtimeId, token: b.store.token })
  ca.putJson('main', 'state.json', { title: 'A' })
  cb.putJson('main', 'state.json', { title: 'B' })

  assert.deepEqual(ca.getJson('main', 'state.json'), { title: 'A' })
  assert.deepEqual(cb.getJson('main', 'state.json'), { title: 'B' })
  assert.throws(() => new WorkspaceClient({ manager: store, runtimeId: a.runtimeId, token: b.store.token }), /权限/)
  assert.throws(() => new WorkspaceClient({ manager: store, runtimeId: b.runtimeId, token: a.store.token }), /权限/)

  const works = store.listWorks()
  assert.equal(works.length, 2)
  assert.deepEqual(works.map((w) => w.runtimeId).sort(), [a.runtimeId, b.runtimeId].sort())

  const manifests = ca.manifest('main')
  const blob = manifests.files['state.json'].blob
  assert.match(blob, /^[a-f0-9]{64}$/)
  assert.ok(fs.existsSync(join(storeRoot, 'objects', blob.slice(0, 2), blob)))

  // CAS：同一版本只能提交一次
  ca.putJson('main', 'state.json', { title: 'A2' }, { expectedVersion: 1 })
  assert.throws(
    () => ca.putJson('main', 'state.json', { title: 'A3' }, { expectedVersion: 1 }),
    /版本冲突/,
  )
  assert.equal(ca.getJson('main', 'state.json').title, 'A2')
})

test('runtime：rowOverrides 保留 domain 覆盖并解析 MCP 端口', () => {
  const f = fixture()
  const resolved = resolveDomain(f.domainDir)
  const overrides = buildRuntimeRowOverrides(resolved, {
    runtimeId: 'rt-x', workId: 'main',
    ports: { content: 40001 },
    paths: { contentState: 'C:/store/rt-x/content' },
  })
  assert.equal(overrides['ppt-workbench-host'].config.port, 40001)
  assert.equal(overrides['ppt-workbench-host'].config.hostDir, 'C:/store/rt-x/content')
  assert.equal(overrides['mcp-ppt'].config.url, 'http://127.0.0.1:40001/mcp')
})


test('runtime：并发创建同一组首选端口也不会重叠', async () => {
  const f = fixture()
  const storeRoot = join(f.root, 'store')
  const [a, b] = await Promise.all([
    createRuntime({ name: 'a', domainInput: f.domainDir, storeRoot, harnessPort: 42780, dshPort: 42781, contentPort: 42782 }),
    createRuntime({ name: 'b', domainInput: f.domainDir, storeRoot, harnessPort: 42780, dshPort: 42781, contentPort: 42782 }),
  ])
  for (const key of ['harness', 'dsh', 'content']) assert.notEqual(a.ports[key], b.ports[key])
  assert.equal(new Set([a.ports.harness, a.ports.dsh, a.ports.content]).size, 3)
  assert.equal(new Set([b.ports.harness, b.ports.dsh, b.ports.content]).size, 3)
})

test('runtime：重启不得覆盖其他 runtime 的空闲端口预留或留下部分预留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-restart-reservation-'))
  try {
    const storeRoot = join(root, 'store')
    const ports = await allocateRuntimePorts({ storeRoot, runtimeId: 'owner', preferences: { first: 0, second: 0 } })
    const runtimeDir = join(storeRoot, 'runtimes', 'restart')
    const harnessDir = join(root, 'harness')
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(harnessDir)
    writeFileSync(join(harnessDir, 'auth-proxy.mjs'), '')
    const registryPath = join(storeRoot, 'registry.json')
    const registry = readRegistry(storeRoot)
    delete registry.ports[String(ports.first)]
    writeFileSync(registryPath, JSON.stringify(registry))
    writeFileSync(join(runtimeDir, 'runtime.json'), JSON.stringify({
      runtimeId: 'restart', storeRoot, ports: { harness: ports.first, dsh: ports.second }, pids: {}, status: 'stopped',
    }))
    const before = fs.readFileSync(registryPath, 'utf8')
    await assert.rejects(startRuntime({ storeRoot, runtimeId: 'restart', harnessDir }), /dsh=.*owner.*预留/)
    assert.equal(fs.readFileSync(registryPath, 'utf8'), before)
    assert.equal(readRegistry(storeRoot).ports[String(ports.second)], 'owner')
    // The existing owner's reservation is idempotent. A deliberately incomplete
    // runtime stops immediately after reservation, before any process is spawned.
    const ownerDir = join(storeRoot, 'runtimes', 'owner')
    mkdirSync(ownerDir, { recursive: true })
    writeFileSync(join(ownerDir, 'runtime.json'), JSON.stringify({
      runtimeId: 'owner', storeRoot, ports: { harness: ports.second }, pids: {}, status: 'stopped',
    }))
    await assert.rejects(startRuntime({ storeRoot, runtimeId: 'owner', harnessDir }), TypeError)
    assert.equal(readRegistry(storeRoot).ports[String(ports.second)], 'owner')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('runtime：启动声明缺少工具/能力时在分配端口前失败', () => {
  const f = fixture()
  const resolved = resolveDomain(f.domainDir)
  assert.throws(() => checkRuntimeRequirements(resolved, { tools: ['missing_*'] }), /缺少工具能力/)
  assert.throws(() => checkRuntimeRequirements(resolved, { capabilities: ['nope.runtime'] }), /缺少能力/)
  assert.equal(checkRuntimeRequirements(resolved, { tools: ['ppt_*'], capabilities: ['ppt.runtime'] }).ok, true)
  assert.equal(checkRuntimeRequirements(resolved, { tools: ['ppt_get_deck'] }).ok, true)
})


test('runtime：通用绑定不依赖具体插件名', () => {
  const resolved = {
    manifest: {
      runtime: {
        bindings: [{
          row: 'generic-host',
          config: {
            port: '${ports.content}',
            hostDir: '${paths.contentState}',
            workId: '${workId}',
          },
        }],
      },
      rowOverrides: {},
    },
    composed: {
      rows: [{ id: 'generic-host', name: 'any-other-plugin', config: {} }],
    },
  }
  const overrides = buildRuntimeRowOverrides(resolved, {
    runtimeId: 'rt-generic',
    workId: 'main',
    ports: { content: 45123 },
    paths: { contentState: 'C:/store/generic/content' },
  })
  assert.deepEqual(overrides['generic-host'].config, {
    port: 45123,
    hostDir: 'C:/store/generic/content',
    workId: 'main',
  })
})

test('runtime：removeRuntime 清理目录与 registry', async () => {
  const f = fixture()
  const storeRoot = join(f.root, 'store')
  const a = await createRuntime({ name: 'a', domainInput: f.domainDir, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  const info = runtimePublicInfo(a)
  assert.ok(info.contentUrl.includes(String(a.ports.content)))
  removeRuntime({ storeRoot, runtimeId: a.runtimeId })
  assert.equal(listRuntimes(storeRoot).length, 0)
  assert.equal(fs.existsSync(a.paths.root), false)
})

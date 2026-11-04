import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRuntime, doctorRuntime, listRuntimes, readRuntime,
  removeRuntime, startRuntime, stopRuntime,
} from '../../dsh-suite-kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const REPO = path.resolve(PKG, '..', '..')
const PPT_DOMAIN = path.join(REPO, 'extensions', 'bridges', 'ppt-bridge', 'domains', 'ppt', 'dsh-domain.json')
const PPT_SUITE = path.join(REPO, 'extensions', 'bridges', 'ppt-bridge', 'plugin', 'capyclaw-ppt-suite')

function workspaceDomain(root, { includePpt = false } = {}) {
  const probeSuite = path.join(PKG, 'test', 'probe-suite')
  const components = includePpt ? [PKG, PPT_SUITE] : [PKG, probeSuite]
  const domain = {
    name: includePpt ? 'ws-ppt-e2e' : 'ws-e2e',
    version: '1.0.0',
    title: 'Workspace E2E',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components,
    profile: { name: includePpt ? 'ws-ppt-e2e' : 'ws-e2e', port: 3080 },
    runtime: {
      driver: 'node',
      workId: 'main',
      requires: {
        services: includePpt ? ['workspace', 'ppt-workbench'] : ['workspace', 'workspace-probe'],
        capabilities: includePpt
          ? ['workspace.runtime@^1.0.0', 'ppt.runtime@^2.2.0', 'ppt.tools@^2.2.0', 'ppt.workflows@^2.2.0']
          : ['workspace.runtime@^1.0.0'],
      },
      bindings: includePpt
        ? []
        : [
            { row: 'workspace-probe', config: { port: '${ports.content}', workId: '${workId}' } },
          ],
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'probe', kind: 'content', path: 'content/probe', patterns: ['probe/**'] },
          ...(includePpt ? [{ id: 'ppt-content', kind: 'content', path: 'content/ppt', patterns: ['state.json', 'journal.jsonl', 'checkpoints/**'] }] : []),
        ],
        workspace: {
          workId: 'main',
          files: includePpt ? ['state.json', 'journal.jsonl', 'checkpoints/**'] : ['probe/**'],
          allowNew: false,
        },
        network: { bind: ['127.0.0.1'] },
        processes: { killTree: true },
      },
      ports: { harness: 0, dsh: 0, content: 0 },
      model: {
        id: 'llm-deepseek',
        plugin: '@deepseek-ai/dsh-llm-deepseek-api-key',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrlEnv: 'DEEPSEEK_BASE_URL',
        baseURL: 'https://api.deepseek.com/anthropic',
      },
    },
  }
  const file = path.join(root, `${domain.name}.json`)
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

async function waitFetch(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`fetch timeout: ${url}`)
}

test('E2E：workspace-service 插件挂载、ctx.workspace 注入、对象仓库 roundtrip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-service-e2e-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root)
  const runtime = await createRuntime({ name: 'ws-e2e', domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  try {
    const started = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
    assert.equal(started.ready, true, 'runtime should be ready')
    const content = `http://127.0.0.1:${runtime.ports.content}`
    const health = await waitFetch(`${content}/healthz`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.workspace, true)
    assert.equal(health.runtimeId, runtime.runtimeId)
    assert.equal(health.workId, 'main')

    const roundtrip = await fetch(`${content}/roundtrip?value=hello`).then((res) => res.json())
    assert.deepEqual(roundtrip, { ok: true, value: 'hello' })

    const forbidden = await fetch(`${content}/forbidden`).then((res) => res.json())
    assert.equal(forbidden.ok, true)
    assert.match(forbidden.rejected, /声明范围/)

    const manifestFile = path.join(storeRoot, 'workspaces', runtime.runtimeId, 'main', 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    assert.ok(manifest.files['probe/roundtrip.json'])
    assert.equal(manifest.files['not-declared.json'], undefined)
    assert.deepEqual(manifest.declaration.files, ['probe/**'])
    assert.equal(manifest.declaration.allowNew, false)

    const doctor = await doctorRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    assert.equal(doctor.ok, true)
    assert.equal(doctor.checks.find((check) => check.id === 'probe-health')?.ok, true)
    assert.equal(doctor.checks.find((check) => check.id === 'sessions')?.ok, true)
  } finally {
    await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E2E：两个 workspace runtime 同时运行，内容不串', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-service-dual-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root)
  const a = await createRuntime({ name: 'ws-a', domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  const b = await createRuntime({ name: 'ws-b', domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  try {
    const ra = await startRuntime({ storeRoot, runtimeId: a.runtimeId, waitMs: 30000 })
    const rb = await startRuntime({ storeRoot, runtimeId: b.runtimeId, waitMs: 30000 })
    assert.equal(ra.ready, true)
    assert.equal(rb.ready, true)
    assert.notEqual(a.ports.harness, b.ports.harness)
    assert.notEqual(a.ports.content, b.ports.content)
    assert.notEqual(a.paths.sessions, b.paths.sessions)
    assert.notEqual(a.paths.workspace, b.paths.workspace)

    await fetch(`http://127.0.0.1:${a.ports.content}/roundtrip?value=A`).then((res) => res.json())
    await fetch(`http://127.0.0.1:${b.ports.content}/roundtrip?value=B`).then((res) => res.json())

    const ma = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', a.runtimeId, 'main', 'manifest.json'), 'utf8'))
    const mb = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', b.runtimeId, 'main', 'manifest.json'), 'utf8'))
    assert.equal(ma.files['probe/roundtrip.json'].blob === mb.files['probe/roundtrip.json'].blob, false)
    assert.equal(ma.runtimeId, a.runtimeId)
    assert.equal(mb.runtimeId, b.runtimeId)

    const ca = await fetch(`http://127.0.0.1:${a.ports.content}/roundtrip?value=A2`).then((res) => res.json())
    const cb = await fetch(`http://127.0.0.1:${b.ports.content}/roundtrip?value=B2`).then((res) => res.json())
    assert.equal(ca.value, 'A2')
    assert.equal(cb.value, 'B2')

    // 相同内容在两个 runtime 中应命中同一个对象（共享对象池去重）
    await fetch(`http://127.0.0.1:${a.ports.content}/roundtrip?value=same`).then((res) => res.json())
    await fetch(`http://127.0.0.1:${b.ports.content}/roundtrip?value=same`).then((res) => res.json())
    const ma2 = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', a.runtimeId, 'main', 'manifest.json'), 'utf8'))
    const mb2 = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', b.runtimeId, 'main', 'manifest.json'), 'utf8'))
    assert.equal(ma2.files['probe/roundtrip.json'].blob, mb2.files['probe/roundtrip.json'].blob)

    const list = listRuntimes(storeRoot)
    assert.equal(list.filter((item) => item.status === 'running').length, 2)
  } finally {
    await Promise.all([
      stopRuntime({ storeRoot, runtimeId: a.runtimeId }),
      stopRuntime({ storeRoot, runtimeId: b.runtimeId }),
    ])
    removeRuntime({ storeRoot, runtimeId: a.runtimeId })
    removeRuntime({ storeRoot, runtimeId: b.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E2E：PPT + workspace-service 同一 runtime 正常启动并落库', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ppt-e2e-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root, { includePpt: true })
  const runtime = await createRuntime({ name: 'ws-ppt', domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  try {
    const started = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
    assert.equal(started.ready, true)
    const content = `http://127.0.0.1:${runtime.ports.content}`
    const health = await waitFetch(`${content}/healthz`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.bridge, 'ppt-workbench')
    /* 服务解耦后 relay 是独立进程：能力经 HTTP 服务提供，不再有进程内 ctx 对象。
     * assets 仍由 relay 自己建文件对象仓库（hostDir = runtime contentState）。 */
    assert.equal(health.injected.serviceHost, false, 'standalone relay 不再有进程内 serviceHost')
    assert.equal(health.injected.toolHost, false, 'standalone relay 不再有进程内 toolHost')
    assert.equal(health.injected.state, undefined, 'PPT 不再依赖 ctx.state')
    assert.equal(health.injected.editorHost, false, 'standalone relay 不再有进程内 editorHost')
    assert.equal(health.injected.assets, true, 'standalone relay 自建文件对象仓库')

    const checkpoint = await fetch(`${content}/api/desktop/works/ppt-bridge/task/checkpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-cp' }),
    }).then((res) => res.json())
    assert.equal(checkpoint.name, 'e2e-cp')
    const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', runtime.runtimeId, 'main', 'manifest.json'), 'utf8'))
    assert.ok(manifest.files['checkpoints/e2e-cp.json'])

    const doctor = await doctorRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    assert.equal(doctor.ok, true)
  } finally {
    await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('E2E：runtime stop/start 复用同一端口、session 和 workspace 保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-service-restart-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root)
  const runtime = await createRuntime({ name: 'ws-restart', domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  const ports = { ...runtime.ports }
  try {
    const first = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
    assert.equal(first.ready, true)
    await fetch(`http://127.0.0.1:${runtime.ports.content}/roundtrip?value=persist`).then((res) => res.json())
    const manifestBefore = path.join(storeRoot, 'workspaces', runtime.runtimeId, 'main', 'manifest.json')
    assert.ok(fs.existsSync(manifestBefore))

    await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    const stopped = readRuntime(storeRoot, runtime.runtimeId)
    assert.equal(stopped.status, 'stopped')
    assert.ok(fs.existsSync(stopped.paths.sessions), 'sessions must survive stop')
    assert.ok(fs.existsSync(stopped.paths.workspace), 'workspace must survive stop')

    const second = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
    assert.equal(second.ready, true)
    const restarted = readRuntime(storeRoot, runtime.runtimeId)
    assert.deepEqual(restarted.ports, ports)
    assert.ok(fs.existsSync(manifestBefore))
    const doctor = await doctorRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    assert.equal(doctor.ok, true)
  } finally {
    await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('E2E：三 runtime 并发写入，端口/目录/manifest 全部隔离', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-service-three-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root)
  const runtimes = []
  try {
    for (const name of ['ws-1', 'ws-2', 'ws-3']) {
      runtimes.push(await createRuntime({ name, domainInput: domainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 }))
    }
    const ids = runtimes.map((runtime) => runtime.runtimeId)
    assert.equal(new Set(runtimes.flatMap((runtime) => [runtime.ports.harness, runtime.ports.content])).size, 6)

    for (const runtime of runtimes) {
      const started = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
      assert.equal(started.ready, true)
    }
    await Promise.all(runtimes.map(async (runtime, index) => {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://127.0.0.1:${runtime.ports.content}/roundtrip?value=r${index}-${i}`)
        assert.equal(res.ok, true)
      }
    }))
    for (const runtime of runtimes) {
      const manifest = JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', runtime.runtimeId, 'main', 'manifest.json'), 'utf8'))
      assert.equal(manifest.runtimeId, runtime.runtimeId)
      assert.ok(manifest.files['probe/roundtrip.json'])
    }
    const manifests = runtimes.map((runtime) => JSON.parse(fs.readFileSync(path.join(storeRoot, 'workspaces', runtime.runtimeId, 'main', 'manifest.json'), 'utf8')))
    const hashes = manifests.map((manifest) => manifest.files['probe/roundtrip.json'].blob)
    assert.equal(new Set(hashes).size, 3, 'each runtime should keep its own latest content')
    assert.equal(listRuntimes(storeRoot).filter((item) => item.status === 'running').length, 3)
  } finally {
    for (const runtime of runtimes) {
      await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId }).catch(() => {})
      removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E2E：缺少 requires 时在分配端口前失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-service-reject-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = workspaceDomain(root)
  const domain = JSON.parse(fs.readFileSync(domainFile, 'utf8'))
  domain.runtime.requires.tools = ['missing_*']
  fs.writeFileSync(domainFile, JSON.stringify(domain, null, 2) + '\n')
  try {
    await assert.rejects(
      () => createRuntime({ name: 'reject', domainInput: domainFile, storeRoot }),
      /缺少工具能力/,
    )
    assert.equal(listRuntimes(storeRoot).length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

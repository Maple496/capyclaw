import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, removeRuntime, startRuntime, stopRuntime } from '../../dsh-suite-kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const REPO = path.resolve(PKG, '..', '..')
const CATALOG_PKG = path.join(REPO, 'packages', 'dsh-catalog')
const INSTALLER_PKG = path.join(REPO, 'packages', 'dsh-installer')

/**
 * 控制面/worker 共用的最小可启动 domain（runtime-control + catalog + installer 三件套，
 * 组件自带 healthz，已被 deploy/runtime e2e 反复证明可拉起）。
 * 注：ppt 域包（extensions/bridges/ppt-bridge）在 profile 安装态下的行组合不加载
 * （见 LOOP_CLOSURE_PLAN.md P2 发现），在其修复前 e2e 不依赖它。
 */
function controlDomain(root, name = 'runtime-control-e2e') {
  const domain = {
    name,
    version: '1.0.0',
    title: 'Runtime Control E2E',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: [PKG, CATALOG_PKG, INSTALLER_PKG],
    profile: { name, port: 3080 },
    runtime: {
      driver: 'node',
      workId: 'main',
      requires: {
        services: ['runtimeControl', 'catalog', 'installer'],
        capabilities: ['runtime.control@^1.0.0', 'catalog.works@^1.0.0', 'installer.domain@^1.0.0'],
      },
      bindings: [{ row: 'runtime-control', config: { port: '${ports.content}' } }],
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'control', kind: 'content', path: 'content/control', patterns: ['**'] },
        ],
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
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const body = await res.json()
  if (!res.ok || body.ok === false) throw new Error(`${url}: ${JSON.stringify(body)}`)
  return body
}

async function stopWorker(base, storeRoot, worker) {
  if (!worker) return
  await fetch(`http://127.0.0.1:${base}/control/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: worker.runtimeId }),
  }).catch(() => {})
  removeRuntime({ storeRoot, runtimeId: worker.runtimeId })
}

test('E2E control plane：控制面插件创建/启动/停止 worker runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-e2e-'))
  const storeRoot = path.join(root, 'store')
  const controlDomainFile = controlDomain(root, 'runtime-control-e2e')
  const workerDomainFile = controlDomain(root, 'control-worker-e2e')
  const control = await createRuntime({ name: 'control', domainInput: controlDomainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  let worker = null
  try {
    const started = await startRuntime({ storeRoot, runtimeId: control.runtimeId, waitMs: 30000 })
    assert.equal(started.ready, true)
    const base = `http://127.0.0.1:${control.ports.content}`
    const health = await fetchJson(`${base}/healthz`)
    assert.equal(health.service, 'runtime-control')
    const services = await fetchJson(`${base}/control/services`)
    assert.equal(services.runtimeControl, true)
    assert.equal(services.catalog, true)
    assert.equal(services.installer, true)

    const created = await fetchJson(`${base}/control/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-e2e', domainInput: workerDomainFile }),
    })
    worker = created.runtime
    assert.ok(worker.runtimeId)
    assert.ok(worker.ports.content > 0)

    const startedWorker = await fetchJson(`${base}/control/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeId: worker.runtimeId }),
    })
    assert.equal(startedWorker.runtime.ready, true)

    const workerHealth = await fetchJson(`http://127.0.0.1:${worker.ports.content}/healthz`)
    assert.equal(workerHealth.ok, true)
    assert.equal(workerHealth.service, 'runtime-control')

    const list = await fetchJson(`${base}/control/list`)
    assert.ok(list.runtimes.some((runtime) => runtime.runtimeId === worker.runtimeId && runtime.running))
    const doctor = await fetchJson(`${base}/control/doctor?runtimeId=${worker.runtimeId}`)
    assert.equal(doctor.ok, true)
    const catalog = await fetchJson(`${base}/control/catalog`)
    assert.ok(catalog.works.some((work) => work.runtimeId === worker.runtimeId && work.workId === 'main'))
    const resolved = await fetchJson(`${base}/control/resolve?domain=${encodeURIComponent(workerDomainFile)}`)
    for (const suite of ['dsh-runtime-control-suite', 'dsh-catalog-suite', 'dsh-installer-suite']) {
      assert.ok(resolved.resolved.components.includes(suite), `组件应包含 ${suite}`)
    }
  } finally {
    await stopWorker(control.ports.content, storeRoot, worker)
    await stopRuntime({ storeRoot, runtimeId: control.runtimeId }).catch(() => {})
    removeRuntime({ storeRoot, runtimeId: control.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E2E control plane（.works 线）：worksFile → 校验转换 → create/start/healthz', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-works-'))
  const storeRoot = path.join(root, 'store')
  const controlDomainFile = controlDomain(root, 'runtime-control-e2e')
  const workerDomainFile = controlDomain(root, 'control-worker-works')
  const control = await createRuntime({ name: 'control', domainInput: controlDomainFile, storeRoot, harnessPort: 0, dshPort: 0, contentPort: 0 })
  let worker = null
  try {
    const started = await startRuntime({ storeRoot, runtimeId: control.runtimeId, waitMs: 30000 })
    assert.equal(started.ready, true)
    const base = `http://127.0.0.1:${control.ports.content}`

    // .works 文件：deployment.source 指向可启动的 worker domain（绝对路径）
    const worksFile = path.join(root, 'worker.works')
    fs.writeFileSync(worksFile, `%%%WORKS-META%%%
{
  "name": "worker-e2e-deploy",
  "brief": "经控制面拉起的 .works 线",
  "view": { "kind": "deployment" },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": ${JSON.stringify(workerDomainFile)}, "autoStart": true },
  "runtime": { "driver": "node", "workId": "main" }
}
`)

    const created = await fetchJson(`${base}/control/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-works', worksFile }),
    })
    worker = created.runtime
    assert.ok(worker.runtimeId, '.works 必须能转换为 domain 并创建 runtime')
    assert.ok(worker.ports.content > 0)

    const startedWorker = await fetchJson(`${base}/control/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeId: worker.runtimeId }),
    })
    assert.equal(startedWorker.runtime.ready, true)
    const workerHealth = await fetchJson(`http://127.0.0.1:${worker.ports.content}/healthz`)
    assert.equal(workerHealth.ok, true)

    // worksInput 内联形态：不落文件，直接传 .works 文本
    const inline = await fetchJson(`${base}/control/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-inline', worksInput: fs.readFileSync(worksFile, 'utf8').replace('worker-e2e-deploy', 'worker-inline-deploy') }),
    })
    assert.ok(inline.runtime.runtimeId, 'worksInput 内联形态应能创建 runtime')
    await fetch(`${base}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeId: inline.runtime.runtimeId }),
    }).catch(() => {})
    removeRuntime({ storeRoot, runtimeId: inline.runtime.runtimeId })

    // 负路径：缺 deployment.source 的 .works → 400 且带错误清单
    const badWorks = path.join(root, 'bad.works')
    fs.writeFileSync(badWorks, `%%%WORKS-META%%%
{ "name": "bad", "brief": "x", "view": { "kind": "deployment" }, "schema_version": "1.0.0" }

%%%WORKS-CODE%%%
{ "deployment": { "type": "domain" } }
`)
    const bad = await fetch(`${base}/control/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker-bad', worksFile: badWorks }),
    })
    assert.equal(bad.status, 400)
    const badBody = await bad.json()
    assert.equal(badBody.ok, false)
    assert.match(badBody.error, /deployment\.source 必填/)
  } finally {
    await stopWorker(control.ports.content, storeRoot, worker)
    await stopRuntime({ storeRoot, runtimeId: control.runtimeId }).catch(() => {})
    removeRuntime({ storeRoot, runtimeId: control.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

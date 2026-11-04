/**
 * dsh-stack v2：domain 型 stack 的 plan/apply/start/status/doctor/stop E2E。
 *
 * 用临时 domain（一个探针插件 + 一个 suite services.json 探针服务）+ 临时
 * storeRoot/stateDir；不碰桌面 3016/39311 或当前 dev 13594/13596。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const DSHD = path.join(REPO, 'tools', 'dsh-launcher', 'bin', 'dshd.mjs')

// dsh 宿主已移出本仓库：优先 DSH_HARNESS_DIR，其次文档化的移出位置
if (!process.env.DSH_HARNESS_DIR) {
  const candidate = path.join(REPO, '..', 'dsh-runtime', 'apps', 'harness', 'deepseek-harness')
  if (existsSync(path.join(candidate, 'auth-proxy.mjs'))) process.env.DSH_HARNESS_DIR = candidate
  else console.error('[skip-hint] 未找到 dsh 宿主，请设置 DSH_HARNESS_DIR。')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function runDshd(args, { timeout = 180000, allowFail = false, env = {} } = {}) {
  const result = spawnSync(process.execPath, [DSHD, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
  if (result.error) throw result.error
  if (!allowFail && result.status !== 0) {
    throw new Error(`dshd ${args.join(' ')} 失败（${result.status}）\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await fn()) return } catch { /* retry */ }
    await sleep(interval)
  }
  throw new Error(`等待超时: ${label}`)
}

async function waitClosed(port) {
  await waitFor(async () => !(await portOpen(port)), { timeout: 20000, label: `port ${port} closed` })
}

async function fetchStatus(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) })
    await res.text()
    return res.status
  } catch {
    return null
  }
}

async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

async function snapshotExternalStacks() {
  return {
    desktop3016: await fetchStatus('http://127.0.0.1:3016/'),
    ppt39311: await fetchStatus('http://127.0.0.1:39311/healthz'),
    dev13594: await fetchStatus('http://127.0.0.1:13594/'),
    launchpad13596: await fetchStatus('http://127.0.0.1:13596/healthz'),
  }
}

/** 临时 domain：probe 插件 + suite services.json 的 probe 服务。 */
async function makeDomainFixture(temp) {
  const domainDir = path.join(temp, 'domain')
  const pluginDir = path.join(domainDir, 'plugin')
  const suiteDir = path.join(domainDir, 'suite')
  mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
  mkdirSync(path.join(suiteDir, 'lib'), { recursive: true })

  writeJson(path.join(pluginDir, 'package.json'), {
    name: 'probe-plugin',
    version: '1.0.0',
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
  })
  writeFileSync(path.join(pluginDir, 'lib', 'index.mjs'), 'export const name = "probe-plugin"\nexport function apply() {}\n')

  writeJson(path.join(suiteDir, 'package.json'), {
    name: 'probe-suite',
    version: '1.0.0',
    type: 'module',
    main: './lib/index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['lib/', 'dsh-suite.json', 'cordis.patch.yml', 'services.json', 'service.mjs'],
  })
  writeJson(path.join(suiteDir, 'dsh-suite.json'), {
    name: 'probe-suite',
    version: '1.0.0',
    title: 'Probe Suite',
    packages: {
      'probe-plugin': {
        role: 'runtime',
        version: '^1.0.0',
        path: '../plugin',
        provides: { services: ['probe-service'] },
      },
    },
    rows: [{ id: 'probe-plugin', name: 'probe-plugin' }],
    checks: [],
  })
  writeFileSync(path.join(suiteDir, 'cordis.patch.yml'), '- insert:\n    - id: probe-plugin\n      name: "probe-plugin"\n')
  writeFileSync(path.join(suiteDir, 'lib', 'index.mjs'), 'export const name = "probe-suite"\nexport function apply() {}\n')
  writeJson(path.join(suiteDir, 'services.json'), {
    services: [{
      id: 'probe-service',
      cmd: ['node', '${PACKAGE_DIR}/service.mjs', '--port', '${PORT}'],
      ports: { main: 'auto' },
      url: 'http://127.0.0.1:${PORT}',
      healthPath: '/healthz',
      keepAlive: true,
    }],
  })
  writeFileSync(path.join(suiteDir, 'service.mjs'), `import http from 'node:http'
const i = process.argv.indexOf('--port')
const port = Number(i >= 0 ? process.argv[i + 1] : 0) || 0
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'probe', pid: process.pid, port }))
    return
  }
  res.writeHead(404); res.end('no')
})
server.listen(port, '127.0.0.1', () => console.log('probe listening', port))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
`)

  writeJson(path.join(domainDir, 'dsh-domain.json'), {
    name: 'probe-domain',
    version: '1.0.0',
    title: 'Probe Domain',
    components: ['./suite'],
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    profile: { name: 'probe-domain', port: 0 },
    runtime: {
      driver: 'node',
      workId: 'main',
      model: false,
      workspaceController: false,
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [{ id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] }],
        workspace: { workId: 'main', files: ['**'], allowNew: true },
        network: { bind: ['127.0.0.1'] },
        processes: { killTree: true },
      },
      ports: { harness: 0, dsh: 0, content: 0 },
    },
  })
}

test('dsh-stack v2：domain 栈 plan/apply/start/status/doctor/stop + 复用', { timeout: 240000 }, async (t) => {
  const beforeExternal = await snapshotExternalStacks()
  t.diagnostic(`外部栈基线: ${JSON.stringify(beforeExternal)}`)

  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-domain-stack-'))
  const stateDir = path.join(temp, 'state')
  const stackFile = path.join(temp, 'stack.json')
  const runtimeId = 'rt-stack-domain-e2e'
  try {
    await makeDomainFixture(temp)
    writeJson(stackFile, {
      kind: 'domain',
      name: 'domain-e2e',
      stateDir: './state',
      ports: { proxy: 'auto', upstream: 'auto', content: 'auto', broker: 'auto' },
      domain: { source: './domain', runtimeId },
      open: false,
    })

    // 1. plan：domain 摘要 + 将创建
    const plan = JSON.parse(runDshd(['stack', 'plan', '--stack', stackFile, '--json']).stdout)
    assert.equal(plan.valid, true)
    assert.equal(plan.kind, 'domain')
    assert.equal(plan.domain.runtimeId, runtimeId)
    assert.equal(plan.changes.domain.exists, false)
    assert.deepEqual(plan.domain.summary.components, ['probe-suite'])
    assert.deepEqual(plan.domain.summary.services, ['probe-service'])
    t.diagnostic('1/6 plan：domain 摘要 + runtime 将创建')

    // 2. apply：创建 runtime（不启动）
    const applied = JSON.parse(runDshd(['stack', 'apply', '--stack', stackFile, '--json']).stdout)
    assert.equal(applied.applied, true)
    assert.equal(applied.kind, 'domain')
    assert.equal(applied.created, true)
    assert.ok(applied.runtime.ports.harness > 0)
    assert.ok(applied.runtime.ports.content > 0)
    const runtimeFile = path.join(stateDir, 'store', 'runtimes', runtimeId, 'runtime.json')
    assert.ok(existsSync(runtimeFile))
    const installed = readJson(runtimeFile)
    assert.equal(installed.status, 'installed')
    const profileDir = path.join(installed.paths.dshHome, 'profiles', installed.profile)
    assert.ok(existsSync(path.join(profileDir, 'package.json')), 'domain profile 应生成')
    t.diagnostic('2/6 apply：runtime + profile 生成')

    // 3. start：真实拉起 dsh + broker + probe-service
    const sessionDir = path.join(temp, 'session')
    const token = 'a'.repeat(48)
    writeJson(path.join(sessionDir, 'session.json'), { token, status: 'open' })
    const sessionEnv = { DSH_PRODUCT_SESSION_DIR: sessionDir, DSH_PRODUCT_SESSION_TOKEN: token }
    const start = runDshd(['start', '--stack', stackFile], { env: sessionEnv })
    assert.equal(readJson(runtimeFile).productSession, token)
    assert.equal((await import('node:fs')).readdirSync(path.join(sessionDir, 'domains')).length, 1)
    const otherDir = path.join(temp, 'other-session'); const otherToken = 'b'.repeat(48)
    writeJson(path.join(otherDir, 'session.json'), { token: otherToken, status: 'open' })
    runDshd(['start', '--stack', stackFile], { env: { DSH_PRODUCT_SESSION_DIR: otherDir, DSH_PRODUCT_SESSION_TOKEN: otherToken } })
    assert.equal(readJson(runtimeFile).productSession, token)
    assert.equal(existsSync(path.join(otherDir, 'domains')), false)
    writeJson(path.join(sessionDir, 'session.json'), { token, status: 'closing' })
    const rejected = runDshd(['start', '--stack', stackFile], { env: sessionEnv, allowFail: true })
    assert.notEqual(rejected.status, 0)
    assert.match(start.stdout, /dsh 就绪/)
    assert.match(start.stdout, /probe-service/)
    const runtime = readJson(runtimeFile)
    assert.equal(runtime.status, 'running')
    assert.ok(Number.isInteger(runtime.ports.harness))
    assert.ok(Number.isInteger(runtime.ports.broker))
    assert.ok(Number.isInteger(runtime.ports.services['probe-service']))
    const harnessUrl = `http://127.0.0.1:${runtime.ports.harness}/`
    await waitFor(async () => (await fetchStatus(harnessUrl)) === 200, { timeout: 30000, label: 'dsh web ready' })
    const serviceUrl = `http://127.0.0.1:${runtime.ports.services['probe-service']}`
    const health = await fetchJson(`${serviceUrl}/healthz`)
    assert.equal(health.ok, true)
    assert.equal(health.service, 'probe')
    const discovery = readJson(runtime.services.discovery)
    assert.equal(discovery.services['probe-service'].state, 'running')
    t.diagnostic('3/6 start：dsh 200 + probe-service health + discovery running')

    // 4. plan 幂等：runtime 已存在
    const planAgain = JSON.parse(runDshd(['stack', 'plan', '--stack', stackFile, '--json']).stdout)
    assert.equal(planAgain.changes.domain.exists, true)
    assert.equal(planAgain.changes.domain.changed, false)
    t.diagnostic('4/6 plan 幂等：runtime 已存在')

    // 5. status/doctor
    const status = runDshd(['status', '--stack', stackFile])
    assert.match(status.stdout, /dsh \(auth-proxy\)\s+running/)
    assert.match(status.stdout, /service-broker\s+running/)
    assert.match(status.stdout, /probe-service\s+running/)
    const doctor = runDshd(['doctor', '--stack', stackFile])
    assert.match(doctor.stdout, /✓ harness/)
    assert.match(doctor.stdout, /✓ broker/)
    assert.match(doctor.stdout, /✓ files:workspace/)
    t.diagnostic('5/6 status/doctor：dsh/broker/service 全绿')

    // 6. Only the owning session may stop this runtime.
    const { stopDomain } = await import('../lib/domain.mjs')
    const cfg = { stateDir, storeRoot: path.join(stateDir, 'store'), runtimeId }
    await stopDomain(cfg, { sessionToken: otherToken })
    assert.equal(readJson(runtimeFile).status, 'running')
    await stopDomain(cfg, { sessionToken: token })
    await waitClosed(runtime.ports.harness)
    await waitClosed(runtime.ports.services['probe-service'])
    const statusStopped = runDshd(['status', '--stack', stackFile])
    assert.match(statusStopped.stdout, /dsh \(auth-proxy\)\s+stopped/)
    assert.match(statusStopped.stdout, /probe-service\s+stopped/)
    t.diagnostic('6/6 stop：端口释放 + status stopped')

    // 7. 复用启动：同一 runtime/端口
    const startAgain = runDshd(['start', '--stack', stackFile])
    assert.match(startAgain.stdout, /复用 domain runtime/)
    const runtimeAgain = readJson(runtimeFile)
    assert.equal(runtimeAgain.ports.harness, runtime.ports.harness)
    assert.equal(runtimeAgain.ports.services['probe-service'], runtime.ports.services['probe-service'])
    runDshd(['stop', '--stack', stackFile])
    t.diagnostic('7/7 复用：端口不变，重启后已回收')

    // 8. domain 源码被删/搬走，stop/status 仍可用（只依赖 runtime 记录）
    await rm(path.join(temp, 'domain'), { recursive: true, force: true })
    const statusNoSource = runDshd(['status', '--stack', stackFile])
    assert.match(statusNoSource.stdout, /dsh \(auth-proxy\)\s+stopped/)
    assert.match(statusNoSource.stdout, /probe-service\s+stopped/)
    const stopNoSource = runDshd(['stop', '--stack', stackFile])
    assert.match(stopNoSource.stdout, /已停止 domain runtime/)
    t.diagnostic('8/8 domain 源码缺失：status/stop 仍可用')

    const afterExternal = await snapshotExternalStacks()
    assert.deepEqual(afterExternal, beforeExternal, '外部栈状态不应变化')
  } finally {
    // A failed start may already have spawned processes and persisted their identities.
    // Always ask the launcher to resolve its own runtime before removing the evidence.
    if (existsSync(stackFile)) {
      const stop = runDshd(['stop', '--stack', stackFile], { allowFail: true, timeout: 60000 })
      if (stop.status !== 0) {
        throw new Error(`隔离 runtime 未能安全回收，保留 ${temp}\n${stop.stdout}\n${stop.stderr}`)
      }
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
})

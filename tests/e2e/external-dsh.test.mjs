/**
 * 端到端：插件工程 ↔ 仓外 dsh
 *
 * 证明四件事：
 *   1. 只给 DSH_HARNESS_DIR，插件工程就能把**仓库外**的插件注入那个 dsh
 *   2. 注入是**真的激活**（inventory: enabled + fiberPhase=active），不是"进程起来了"
 *   3. 运行时两级开关：包级（setBundleEnabled，保留依赖）+ 行级（setPluginEnabled）
 *   4. 坏 bundle 不被静默吞掉（编译期拒绝 / 运行期带 error）
 *
 * 实测行为（2026-11-04，dsh 0.2.0-rc.2）——决定了断言口径：
 *   - `GET /` 200 只说明 web 必需 entry 活着，**不能**作为插件激活证据
 *   - `ctx.on('dispose')` 在 entry 被禁用时**不会触发**（禁用只是不实例化）
 *     所以探针不能注册会冲突的资源（如具名路由），否则重开会 duplicate route
 *   - `webserver/index-inject` 是**每次响应重新收集**的最好观测点：停用后注入消失
 *   - `setPluginEnabled` 用 **entryId**（`include:<rowId>`），不是 patchId
 *   - `setBundleEnabled` 用**包名**，只改 bundles 不动 dependencies
 *
 * 运行：npm run test-e2e
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DSHD = path.join(REPO, 'tools', 'dsh-launcher', 'bin', 'dshd.mjs')

const HARNESS_CANDIDATES = [
  process.env.DSH_HARNESS_DIR,
  path.join(REPO, '..', 'dsh-runtime', 'apps', 'harness', 'deepseek-harness'),
].filter(Boolean)
const HARNESS = HARNESS_CANDIDATES.find((p) => existsSync(path.join(p, 'auth-proxy.mjs')))
if (HARNESS) process.env.DSH_HARNESS_DIR = HARNESS
const SKIP = HARNESS
  ? false
  : '未找到 dsh 宿主：设置 DSH_HARNESS_DIR，或放一份在 ../dsh-runtime/apps/harness/deepseek-harness'

const PROBE_NAME = '@e2e/probe'
const PROBE_ENTRY_ID = 'include:e2e-probe'

// ---------- 工具 ----------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runDshd(args, { timeout = 180000, allowFail = false } = {}) {
  const result = spawnSync(process.execPath, [DSHD, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  })
  if (result.error) throw result.error
  if (!allowFail && result.status !== 0) {
    throw new Error(`dshd ${args.join(' ')} 失败（${result.status}）\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function uniquePorts(count) {
  const ports = new Set()
  while (ports.size < count) ports.add(await freePort())
  return [...ports]
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(`等待超时: ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

const testFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, connection: 'close' } })

async function fetchStatus(url, timeoutMs = 3000) {
  try {
    const res = await testFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.text()
    return res.status
  } catch {
    return null
  }
}

async function fetchText(url, timeoutMs = 5000) {
  const res = await testFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: res.status, text: await res.text() }
}

async function fetchJson(url, init = {}, timeoutMs = 20000) {
  const res = await testFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`${url} 返回非 JSON（${res.status}）: ${text.slice(0, 300)}`) }
  return body
}

/** dsh Typert Remote 一元调用：POST /api/<ns>/<method> */
async function dshApi(base, endpoint, args = {}) {
  const [ns, method] = endpoint.split('/')
  const res = await testFetch(`${base}api/${ns}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: endpoint,
      payload: { args },
    }),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`${endpoint} 返回非 JSON（${res.status}）: ${text.slice(0, 300)}`) }
  const result = body?.result
  if (!result?.ok) throw new Error(`${endpoint} 失败: ${JSON.stringify(result?.error || body).slice(0, 500)}`)
  return result.value
}

const inventory = async (base) => {
  const value = await dshApi(base, 'pluginInventory/list', {})
  return Array.isArray(value?.entries) ? value.entries : []
}

const pluginEntry = async (base) => (await inventory(base)).find((e) => e.entryId === PROBE_ENTRY_ID)

// ---------- 探针 fixture ----------

/**
 * 探针只用「日志 + index-inject」两种观测手段：
 * 不注册具名路由 —— 因为 entry 被禁用时 dsh 不会调用 dispose，
 * 残留的注册会让重开失败（duplicate route），把测试变成测 dsh 的清理缺陷。
 */
function makeProbe(root, { marker = 'e2e-marker' } = {}) {
  const dir = path.join(root, 'probe')
  writeJson(path.join(dir, 'package.json'), {
    name: PROBE_NAME,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './lib/host.mjs',
    exports: { '.': './lib/host.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: e2e-probe',
    `      name: "${PROBE_NAME}"`,
    '      config:',
    `        marker: ${marker}`,
    '',
  ].join('\n'))
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'lib', 'host.mjs'), `
export const name = '${PROBE_NAME}'

export function apply(ctx, config = {}) {
  const marker = config.marker || 'e2e-marker'
  console.log('[e2e-probe] active ' + marker)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__E2E_PROBE__', value: { marker } })
  })
}
`)
  return dir
}

function makeStack(root, probeDir, ports) {
  const stateDir = path.join(root, 'state')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const stackFile = path.join(root, 'dsh-stack.json')
  writeJson(stackFile, {
    name: 'e2e-external-dsh',
    home,
    profile: 'web',
    workspace,
    stateDir,
    ports: { broker: ports[0], proxy: ports[1], upstream: ports[2] },
    plugins: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', { name: PROBE_NAME, path: probeDir }],
      install: true,
    },
    services: [],
  })
  return { stackFile, home, stateDir, workspace }
}

// ---------- 主用例 ----------

test('插件工程 ↔ 仓外 dsh：注入 → 激活 → 包级/行级开关', { skip: SKIP, timeout: 360000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-dsh-'))
  const ports = await uniquePorts(3)
  const dshUrl = `http://127.0.0.1:${ports[1]}/`
  const probeDir = makeProbe(root)
  const { stackFile, home, stateDir } = makeStack(root, probeDir, ports)

  const profileFile = path.join(home, 'profiles', 'web', 'package.json')
  const profilePatch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  const dshLog = path.join(stateDir, 'logs', 'dsh.log')
  let started = false

  try {
    // ---- 1) 装配 ----
    const plan = JSON.parse(runDshd(['stack', 'plan', '--stack', stackFile, '--json']).stdout)
    assert.equal(plan.valid, true, 'stack 应校验通过')
    assert.ok(plan.profile.bundles.includes(PROBE_NAME), 'plan 的 bundles 应含探针')

    runDshd(['stack', 'apply', '--stack', stackFile])
    const applied = readJson(profileFile)
    assert.ok(applied.dsh.profile.bundles.includes(PROBE_NAME), 'profile bundles 应含探针')
    assert.match(String(applied.dependencies[PROBE_NAME] || ''), /^link:/, '探针应是 link 依赖')
    assert.ok(
      existsSync(path.join(home, 'profiles', 'web', 'node_modules', '@e2e', 'probe', 'package.json')),
      '探针应链接进 profile node_modules',
    )

    // ---- 2) 启动真实 dsh ----
    const start = runDshd(['start', '--stack', stackFile], { timeout: 300000 })
    started = true
    assert.match(start.stdout, /dsh 就绪/, 'dsh 应报告就绪')
    await waitFor(async () => (await fetchStatus(dshUrl)) === 200, { timeout: 60000, label: 'dsh web ready' })

    // 组合层可观测：dump-config 能看到探针的 patch 行
    const dump = spawnSync(process.execPath, [
      path.join(HARNESS, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '--profile', 'web', '--dump-config',
    ], { cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_HOME: home } })
    assert.equal(dump.status, 0, `dump-config 失败: ${dump.stderr}`)
    assert.ok(dump.stdout.includes(PROBE_NAME), 'dump-config 应含探针 bundle 分组')
    assert.ok(dump.stdout.includes('e2e-probe'), 'dump-config 应含探针行 id')
    assert.doesNotMatch(dump.stderr, /skipping profile bundle/, '不应出现 bundle 被跳过')

    // ---- 3) 激活证据（三层，缺一不可）----
    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return Boolean(entry && entry.enabled === true && entry.fiberPhase === 'active')
    }, { timeout: 60000, label: 'probe entry active' })

    assert.match((await fetchText(dshUrl)).text, /__E2E_PROBE__/, '首页应注入探针全局')
    assert.match(readFileSync(dshLog, 'utf8'), /\[e2e-probe\] active/, 'dsh 日志应含探针启动行')

    // ---- 4) 包级关闭：不参与组合，但依赖保留 ----
    const offBundle = await dshApi(dshUrl, 'pluginManager/setBundleEnabled', { name: PROBE_NAME, enabled: false })
    assert.equal(offBundle?.application, 'applied', `热关闭应 applied: ${JSON.stringify(offBundle)}`)

    const afterOff = readJson(profileFile)
    assert.ok(!afterOff.dsh.profile.bundles.includes(PROBE_NAME), '关闭后 bundles 不应含探针')
    assert.ok(afterOff.dependencies[PROBE_NAME], '关闭包必须保留依赖（便于重开）')

    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return !entry || entry.enabled === false
    }, { timeout: 60000, label: 'probe entry not active' })
    await waitFor(async () => !/__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'probe injection gone' })

    // ---- 5) 包级重开 ----
    const onBundle = await dshApi(dshUrl, 'pluginManager/setBundleEnabled', { name: PROBE_NAME, enabled: true })
    assert.equal(onBundle?.application, 'applied', `热开启应 applied: ${JSON.stringify(onBundle)}`)
    assert.ok(readJson(profileFile).dsh.profile.bundles.includes(PROBE_NAME), '重开后 bundles 应含探针')
    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return Boolean(entry && entry.enabled === true && entry.fiberPhase === 'active')
    }, { timeout: 60000, label: 'probe active again' })
    await waitFor(async () => /__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'probe injection back' })

    // ---- 6) 行级关闭：bundle 仍在，只关这一行 ----
    const offEntry = await dshApi(dshUrl, 'pluginManager/setPluginEnabled', { id: PROBE_ENTRY_ID, enabled: false })
    assert.equal(offEntry?.application, 'applied', `行级关闭应 applied: ${JSON.stringify(offEntry)}`)

    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return Boolean(entry && entry.enabled === false)
    }, { timeout: 60000, label: 'probe entry disabled' })

    assert.ok(readJson(profileFile).dsh.profile.bundles.includes(PROBE_NAME), '行级关闭不应移除 bundle')
    assert.match(readFileSync(profilePatch, 'utf8'), /disabled:\s*true/, 'profile patch 应写入 disabled: true')
    await waitFor(async () => !/__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'injection gone after entry disable' })

    // ---- 7) 行级重开 ----
    const onEntry = await dshApi(dshUrl, 'pluginManager/setPluginEnabled', { id: PROBE_ENTRY_ID, enabled: true })
    assert.equal(onEntry?.application, 'applied', `行级重开应 applied: ${JSON.stringify(onEntry)}`)
    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return Boolean(entry && entry.enabled === true && entry.fiberPhase === 'active')
    }, { timeout: 60000, label: 'probe entry re-enabled' })
    await waitFor(async () => /__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'injection back after entry re-enable' })
  } finally {
    if (started) {
      try { runDshd(['stop', '--stack', stackFile], { timeout: 120000, allowFail: true }) } catch { /* 尽力 */ }
    }
    await sleep(800)
    try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 保留排查 */ }
  }
})

test('坏 bundle 不静默：编译期就被拒绝', { skip: SKIP, timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-bad-'))
  try {
    const badDir = path.join(root, 'bad')
    writeJson(path.join(badDir, 'package.json'), {
      name: '@e2e/bad',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './lib/host.mjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    mkdirSync(path.join(badDir, 'lib'), { recursive: true })
    writeFileSync(path.join(badDir, 'lib', 'host.mjs'), 'export const name = "@e2e/bad"\nexport function apply() {}\n')

    const ports = await uniquePorts(3)
    const stateDir = path.join(root, 'state')
    const home = path.join(root, 'home')
    const workspace = path.join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const stackFile = path.join(root, 'dsh-stack.json')
    writeJson(stackFile, {
      name: 'e2e-bad',
      home,
      profile: 'web',
      workspace,
      stateDir,
      ports: { broker: ports[0], proxy: ports[1], upstream: ports[2] },
      plugins: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', { name: '@e2e/bad', path: badDir }],
        install: false,
      },
      services: [],
    })

    // 缺 patch 文件应当在 apply 前就被 stack 校验拦下，而不是带着坏配置启动
    const result = runDshd(['stack', 'apply', '--stack', stackFile], { allowFail: true })
    assert.notEqual(result.status, 0, '坏 bundle 应当让 apply 失败')
    assert.match(result.stderr, /patch 不存在/, 'stderr 应指出 patch 缺失')
  } finally {
    await sleep(200)
    try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* noop */ }
  }
})

// ---------- 管理器插件（@capyclaw/plugin-sync） ----------

const SYNC_PKG = path.join(REPO, 'extensions', 'official', 'capyclaw-plugin-sync')
const PLUGIN_KIT = path.join(REPO, 'packages', 'dsh-plugin-kit')

test('管理器插件：清单驱动开关（report → apply → 生效）', { skip: SKIP, timeout: 360000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-sync-'))
  const ports = await uniquePorts(3)
  const dshUrl = `http://127.0.0.1:${ports[1]}/`
  const probeDir = makeProbe(root)

  // 清单：期望把探针关掉，并声明一个不可能满足的版本（用于验证"只报告差异"）
  const manifestFile = path.join(root, 'manifest.json')
  writeJson(manifestFile, {
    version: 1,
    plugins: [{ name: PROBE_NAME, version: '9.9.9', enabled: false }],
  })

  const stateDir = path.join(root, 'state')
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const stackFile = path.join(root, 'dsh-stack.json')
  writeJson(stackFile, {
    name: 'e2e-sync',
    home,
    profile: 'web',
    workspace,
    stateDir,
    ports: { broker: ports[0], proxy: ports[1], upstream: ports[2] },
    plugins: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        { name: PROBE_NAME, path: probeDir },
        { name: '@capyclaw/plugin-sync', path: SYNC_PKG },
      ],
      dependencies: { 'dsh-plugin-kit': { path: PLUGIN_KIT } },
      configs: [{ name: '@capyclaw/plugin-sync', config: { sourcePath: manifestFile } }],
      install: true,
    },
    services: [],
  })

  let started = false
  try {
    runDshd(['stack', 'apply', '--stack', stackFile])
    runDshd(['start', '--stack', stackFile], { timeout: 300000 })
    started = true
    await waitFor(async () => (await fetchStatus(dshUrl)) === 200, { timeout: 60000, label: 'dsh ready (sync)' })

    // 探针与同步器都应激活
    await waitFor(async () => {
      const entries = await inventory(dshUrl)
      const probe = entries.find((e) => e.entryId === PROBE_ENTRY_ID)
      const sync = entries.find((e) => String(e.moduleName) === '@capyclaw/plugin-sync')
      return Boolean(probe?.fiberPhase === 'active' && sync?.fiberPhase === 'active')
    }, { timeout: 60000, label: 'probe + plugin-sync active' })

    // ---- report：清单说关，实际是开 → 差异应体现 ----
    const report = await fetchJson(`${dshUrl}__plugin_sync__/report`)
    assert.equal(report.ok, true)
    assert.equal(report.report.source.id, 'local')
    const bundleChange = report.report.diff.changes.find((c) => c.op === 'bundle' && c.name === PROBE_NAME)
    assert.ok(bundleChange, '报告应指出探针需要关闭')
    assert.equal(bundleChange.enabled, false)
    assert.deepEqual(report.report.versions.local, [
      { name: PROBE_NAME, desired: '9.9.9', installed: '1.0.0', kind: 'installed-vs-desired' },
    ], '版本差异只报告，不触发安装')

    // ---- apply：按报告里的变更执行 ----
    const applied = await fetchJson(`${dshUrl}__plugin_sync__/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: report.report.diff.changes }),
    })
    assert.equal(applied.ok, true, `apply 应成功: ${JSON.stringify(applied)}`)
    assert.equal(applied.applied, 1)

    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return !entry || entry.enabled === false
    }, { timeout: 60000, label: 'probe disabled via plugin-sync' })
    await waitFor(async () => !/__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'probe injection gone via plugin-sync' })

    // 依赖保留
    const profile = readJson(path.join(home, 'profiles', 'web', 'package.json'))
    assert.ok(profile.dependencies[PROBE_NAME], '关闭包应保留依赖')

    // ---- 再开回来 ----
    const reopened = await fetchJson(`${dshUrl}__plugin_sync__/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ op: 'bundle', name: PROBE_NAME, enabled: true }] }),
    })
    assert.equal(reopened.ok, true)
    await waitFor(async () => {
      const entry = await pluginEntry(dshUrl)
      return Boolean(entry && entry.enabled === true && entry.fiberPhase === 'active')
    }, { timeout: 60000, label: 'probe re-enabled via plugin-sync' })
    await waitFor(async () => /__E2E_PROBE__/.test((await fetchText(dshUrl)).text),
      { timeout: 30000, label: 'probe injection back via plugin-sync' })

    // ---- 非法变更被拒（不静默吞掉）----
    const bad = await testFetch(`${dshUrl}__plugin_sync__/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ op: 'nope', enabled: true }] }),
    })
    assert.equal(bad.status, 400, '非法 op 应 400')
    await bad.text()
  } finally {
    if (started) {
      try { runDshd(['stop', '--stack', stackFile], { timeout: 120000, allowFail: true }) } catch { /* 尽力 */ }
    }
    await sleep(800)
    try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 保留排查 */ }
  }
})

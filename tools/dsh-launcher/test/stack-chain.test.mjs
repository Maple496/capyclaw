/**
 * dsh-stack 链路 E2E：
 *   stack → 编译 → profile / broker 清单 → broker + dsh + launchpad → discovery → API
 *
 * 使用独立临时 home / stateDir / 端口；不碰桌面 3016/39311，也不碰当前 dev 13594/13596。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const DSHD = path.join(REPO, 'tools', 'dsh-launcher', 'bin', 'dshd.mjs')
const PLUGIN = path.join(REPO, 'extensions', 'official', 'capyclaw-launchpad')
const PLUGIN_KIT = path.join(REPO, 'packages', 'dsh-plugin-kit')

// dsh 宿主已移出本仓库：优先用 DSH_HARNESS_DIR，其次文档化的移出位置
const HARNESS_CANDIDATES = [
  process.env.DSH_HARNESS_DIR,
  path.join(REPO, '..', 'dsh-runtime', 'apps', 'harness', 'deepseek-harness'),
].filter(Boolean)
const RESOLVED_HARNESS = HARNESS_CANDIDATES.find((p) => existsSync(path.join(p, 'auth-proxy.mjs')))
if (RESOLVED_HARNESS) process.env.DSH_HARNESS_DIR = RESOLVED_HARNESS
else console.error('[skip-hint] 未找到 dsh 宿主，请设置 DSH_HARNESS_DIR。栈链路测试会因“配置不完整”失败。')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function waitPortClosed(port, timeout = 15000) {
  await waitFor(async () => !(await portOpen(port)), { timeout, label: `port ${port} closed` })
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// These tests stop and immediately restart servers on the same port. Do not
// reuse a pooled socket from an earlier instance after a restart.
function testFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...init.headers, connection: 'close' } })
}

async function fetchStatus(url, timeoutMs = 3000) {
  try {
    const res = await testFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.text()
    return res.status
  } catch {
    return null
  }
}

async function fetchJson(url, init = {}, timeoutMs = 10000) {
  const res = await testFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${String(text).slice(0, 500)}`)
  return body
}

async function snapshotExternalStacks() {
  return {
    desktop3016: await fetchStatus('http://127.0.0.1:3016/'),
    ppt39311: await fetchStatus('http://127.0.0.1:39311/healthz'),
    dev13594: await fetchStatus('http://127.0.0.1:13594/'),
    launchpad13596: await fetchStatus('http://127.0.0.1:13596/healthz'),
  }
}

test('dsh-stack 链路：plan/apply/start/stop/重启/漂移/失败/隔离', { timeout: 240000 }, async (t) => {
  const beforeExternal = await snapshotExternalStacks()
  t.diagnostic(`外部栈基线: ${JSON.stringify(beforeExternal)}`)

  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-stack-chain-'))
  const [brokerPort, proxyPort, upPort, launchpadPort] = await uniquePorts(4)
  const home = path.join(temp, 'home')
  const stateDir = path.join(temp, '.dshd', 'state')
  const workspace = path.join(temp, 'workspace')
  const stackFile = path.join(temp, 'dsh-stack.json')
  const profileFile = path.join(home, 'profiles', 'web', 'package.json')
  const manifestFile = path.join(stateDir, 'stack-services.json')
  const dshUrl = `http://127.0.0.1:${proxyPort}/`
  const launchpadUrl = `http://127.0.0.1:${launchpadPort}`
  let stackBFile = ''

  await mkdir(workspace, { recursive: true })
  const stack = {
    name: 'chain-test',
    home: './home',
    profile: 'web',
    workspace: './workspace',
    stateDir: './.dshd/state',
    ports: { broker: brokerPort, proxy: proxyPort, upstream: upPort },
    plugins: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        { name: '@capyclaw/launchpad', path: PLUGIN },
      ],
      dependencies: { 'dsh-plugin-kit': PLUGIN_KIT },
      install: true,
    },
    services: [
      {
        id: 'launchpad',
        path: path.join(PLUGIN, 'server.mjs'),
        args: [
          '--roots', `${REPO},${temp}`,
          '--dsh-home', '${home}',
          '--broker-url', `http://127.0.0.1:${brokerPort}`,
          '--launchpads', path.join(temp, 'launchpads'),
          '--dshd', DSHD,
        ],
        ports: { main: launchpadPort },
        healthPath: '/healthz',
        keepAlive: true,
      },
    ],
  }
  writeJson(stackFile, stack)

  try {
    // 1. plan：编译器独立可跑，不启动任何进程
    const plan = JSON.parse(runDshd(['stack', 'plan', '--stack', stackFile, '--json']).stdout)
    assert.equal(plan.valid, true)
    assert.deepEqual(plan.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@capyclaw/launchpad'])
    assert.deepEqual(plan.services.map((service) => service.id), ['launchpad'])
    assert.equal(plan.profile.installNeeded, true)
    assert.equal(plan.changes.profileBundles.changed, true)
    assert.ok(plan.changes.dependencies.added.includes('@capyclaw/launchpad'))
    assert.ok(plan.changes.dependencies.added.includes('dsh-plugin-kit'))
    assert.equal(plan.changes.manifest.changed, true)
    t.diagnostic('1/14 plan：stack 校验 + 依赖/服务计划 OK')

    // 2. apply：profile 与 broker 清单是生成物
    const applied = JSON.parse(runDshd(['stack', 'apply', '--stack', stackFile, '--json']).stdout)
    assert.equal(applied.applied, true)
    assert.equal(applied.profileWritten, true)
    assert.equal(applied.manifestWritten, true)
    assert.equal(applied.installSkipped, false)
    assert.ok(existsSync(profileFile))
    assert.ok(existsSync(manifestFile))

    const profile = readJson(profileFile)
    assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@capyclaw/launchpad'])
    assert.match(profile.dependencies['@capyclaw/launchpad'], /^link:/)
    assert.match(profile.dependencies['dsh-plugin-kit'], /^link:/)
    assert.ok(existsSync(path.join(home, 'profiles', 'web', 'node_modules', '@capyclaw', 'launchpad', 'package.json')))
    assert.ok(existsSync(path.join(home, 'profiles', 'web', 'node_modules', 'dsh-plugin-kit', 'package.json')))

    const manifest = readJson(manifestFile)
    assert.equal(manifest._generatedBy, 'dsh-stack-kit')
    assert.equal(manifest.services.length, 1)
    const spec = manifest.services[0]
    assert.equal(spec.id, 'launchpad')
    assert.equal(spec.cmd[0], 'node')
    assert.equal(spec.cmd[1], path.join(PLUGIN, 'server.mjs'))
    assert.ok(spec.cmd.includes('--port'))
    assert.ok(spec.cmd.includes('${PORT}'))
    assert.equal(spec.ports.main, launchpadPort)
    assert.equal(spec.url, 'http://127.0.0.1:${PORT}')
    assert.equal(spec.healthPath, '/healthz')
    assert.equal(spec.keepAlive, true)
    t.diagnostic('2/14 apply：profile bundles/link + broker 清单生成 OK')

    // 3. broker 契约：生成的服务 spec 必须被 broker normalizeSpec 接受
    const { normalizeSpec } = await import(pathToFileURL(path.join(REPO, 'packages', 'dsh-service-broker', 'lib', 'engine.mjs')).href)
    for (const service of manifest.services) {
      const normalized = normalizeSpec(service)
      assert.equal(normalized.id, service.id)
      assert.ok(normalized.cmd.length > 0)
    }
    t.diagnostic('3/14 seam：生成服务 spec 被 broker normalizeSpec 接受')

    // 4. apply 幂等：第二次不写文件、不跑 pnpm
    const appliedAgain = JSON.parse(runDshd(['stack', 'apply', '--stack', stackFile, '--json']).stdout)
    assert.equal(appliedAgain.profileWritten, false)
    assert.equal(appliedAgain.manifestWritten, false)
    assert.equal(appliedAgain.profile.installNeeded, false)
    assert.equal(appliedAgain.installSkipped, false)
    t.diagnostic('4/14 apply 幂等：第二次无写入、无 install')

    // 5. start：真实拉起 broker + dsh + launchpad
    const start = runDshd(['start', '--stack', stackFile])
    assert.match(start.stdout, /dsh 就绪/)
    assert.match(start.stdout, /launchpad/)
    const state = readJson(path.join(stateDir, 'state.json'))
    assert.equal(state.broker.port, brokerPort)
    assert.equal(state.dsh.proxyPort, proxyPort)
    assert.equal(state.dsh.upPort, upPort)
    assert.ok(pidAlive(state.broker.pid))
    assert.ok(pidAlive(state.dsh.pid))
    const authLock = path.join(stateDir, 'dsh.auth-proxy.lock')
    assert.ok(existsSync(authLock), 'auth-proxy 锁应落在 stateDir')
    assert.equal(readJson(authLock).pid, state.dsh.pid)
    await waitFor(async () => (await fetchStatus(dshUrl)) === 200, { timeout: 30000, label: 'dsh web ready' })
    const health = await fetchJson(`${launchpadUrl}/healthz`)
    assert.equal(health.ok, true)
    assert.equal(health.port, launchpadPort)
    assert.ok(health.pid > 0)

    const discovery = readJson(path.join(stateDir, 'services.json'))
    assert.equal(discovery.services.launchpad.state, 'running')
    assert.ok(pidAlive(discovery.services.launchpad.pid))
    assert.equal(discovery.services.launchpad.ports.main, launchpadPort)
    t.diagnostic('5/14 start：dsh 200 + launchpad /healthz + discovery running')

    // 6. launchpad 独立约定：识别 temp stack，且没有漂移
    await testFetch(`${launchpadUrl}/api/refresh`, { method: 'POST' })
    await sleep(150)
    const inventory = await fetchJson(`${launchpadUrl}/api/inventory`)
    const tempStack = inventory.manifests.find((item) => item.type === 'stack' && item.path === stackFile)
    assert.ok(tempStack, 'launchpad inventory 应包含 temp stack')
    assert.deepEqual(tempStack.stack.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@capyclaw/launchpad'])
    assert.deepEqual(tempStack.stack.services.map((item) => item.id), ['launchpad'])
    assert.deepEqual(tempStack.issues, [])
    assert.ok(inventory.summary.stacks >= 2) // 仓库 dev stack + temp stack

    const status = runDshd(['status', '--stack', stackFile])
    assert.match(status.stdout, /running/)
    assert.match(status.stdout, /launchpad/)
    const doctor = runDshd(['doctor', '--stack', stackFile])
    assert.equal(doctor.status, 0)
    t.diagnostic('6/14 launchpad：识别 stack、无漂移；dshd status/doctor OK')

    // 6b. 管理界面 API：通过 launchpad 的 DSL 执行器真实拉起一套嵌套 dsh
    const nestedLpDir = path.join(temp, 'launchpads')
    await mkdir(nestedLpDir, { recursive: true })
    await writeFile(path.join(nestedLpDir, 'nested.stack'), [
      'stack "nested" {',
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
    ].join('\n'))
    const nestedList = await fetchJson(`${launchpadUrl}/api/launchpads`)
    const nestedEntry = nestedList.launchpads.find((item) => item.id === 'nested')
    assert.ok(nestedEntry, 'launchpad API 应列出 nested DSL')
    assert.equal(nestedEntry.state, 'stopped')
    const nestedPlan = await fetchJson(`${launchpadUrl}/api/launchpads/nested/plan`, { method: 'POST' }, 60000)
    assert.equal(nestedPlan.ok, true)
    let nestedStarted = true // The request may fail after starting child processes.
    try {
      const nestedStart = await fetchJson(`${launchpadUrl}/api/launchpads/nested/start`, { method: 'POST' }, 200000)
      nestedStarted = true
      assert.equal(nestedStart.ok, true)
      assert.equal(nestedStart.status.state, 'running')
      const nestedDshUrl = nestedStart.status.dsh.url
      await waitFor(async () => (await fetchStatus(nestedDshUrl)) === 200, { timeout: 30000, label: 'nested dsh ready' })
      const nestedState = readJson(path.join(nestedLpDir, 'state', 'state.json'))
      const nestedPorts = [nestedState.dsh.proxyPort, nestedState.dsh.upPort, nestedState.broker.port]
      const nestedStop = await fetchJson(`${launchpadUrl}/api/launchpads/nested/stop`, { method: 'POST' }, 60000)
      nestedStarted = false
      assert.equal(nestedStop.ok, true)
      assert.equal(nestedStop.status.state, 'stopped')
      await Promise.all(nestedPorts.map((port) => waitPortClosed(port)))
      t.diagnostic('6b/14 管理界面 API：DSL plan/start/stop 真实拉起并回收一套 dsh')
    } finally {
      if (nestedStarted) {
        try {
          await testFetch(`${launchpadUrl}/api/launchpads/nested/stop`, { method: 'POST' })
        } catch { /* 尽力回收 */ }
      }
    }

    // 7. start 幂等：已在运行不重启
    const stateBefore = readJson(path.join(stateDir, 'state.json'))
    const startAgain = runDshd(['start', '--stack', stackFile])
    assert.match(startAgain.stdout, /已在运行/)
    const stateAfter = readJson(path.join(stateDir, 'state.json'))
    assert.equal(stateAfter.broker.pid, stateBefore.broker.pid)
    assert.equal(stateAfter.dsh.pid, stateBefore.dsh.pid)
    t.diagnostic('7/14 start 幂等：pid 不变')

    // 8. 并发两套栈：独立 home/state/端口，互不影响
    const tempB = path.join(temp, 'stack-b')
    const [brokerB, proxyB, upB, launchpadB] = await uniquePorts(4)
    await mkdir(path.join(tempB, 'workspace'), { recursive: true })
    stackBFile = path.join(tempB, 'dsh-stack.json')
    const stackB = JSON.parse(JSON.stringify(stack))
    stackB.name = 'chain-test-b'
    stackB.ports = { broker: brokerB, proxy: proxyB, upstream: upB }
    stackB.services[0].args = [
      '--roots', `${REPO},${tempB}`,
      '--dsh-home', '${home}',
      '--broker-url', `http://127.0.0.1:${brokerB}`,
    ]
    stackB.services[0].ports = { main: launchpadB }
    writeJson(stackBFile, stackB)
    const dshBUrl = `http://127.0.0.1:${proxyB}/`
    const launchpadBUrl = `http://127.0.0.1:${launchpadB}`
    runDshd(['start', '--stack', stackBFile])
    await waitFor(async () => (await fetchStatus(dshBUrl)) === 200, { timeout: 30000, label: 'stack B dsh ready' })
    const healthB = await fetchJson(`${launchpadBUrl}/healthz`)
    assert.equal(healthB.ok, true)
    assert.equal(healthB.port, launchpadB)
    const stateB = readJson(path.join(tempB, '.dshd', 'state', 'state.json'))
    assert.notEqual(stateB.dsh.pid, state.dsh.pid)
    assert.notEqual(stateB.broker.pid, state.broker.pid)
    const authLockB = path.join(tempB, '.dshd', 'state', 'dsh.auth-proxy.lock')
    assert.ok(existsSync(authLockB), '第二套栈的 auth-proxy 锁应落在自己的 stateDir')
    assert.equal(readJson(authLockB).pid, stateB.dsh.pid)
    assert.notEqual(readJson(authLockB).pid, readJson(authLock).pid)
    assert.equal(await fetchStatus(dshUrl), 200)
    assert.equal((await fetchJson(`${launchpadUrl}/healthz`)).ok, true)
    runDshd(['stop', '--stack', stackBFile])
    await Promise.all([brokerB, proxyB, upB, launchpadB].map((port) => waitPortClosed(port)))
    assert.equal(await fetchStatus(dshUrl), 200)
    assert.equal((await fetchJson(`${launchpadUrl}/healthz`)).ok, true)
    t.diagnostic('8/14 并发：第二套栈独立拉起/停止，第一套全程 200')

    // 9. keepAlive：强杀 launchpad 服务，broker 按原端口复活；dsh 不受影响
    const oldServicePid = readJson(path.join(stateDir, 'services.json')).services.launchpad.pid
    process.kill(oldServicePid, 'SIGTERM')
    await waitFor(async () => {
      const row = readJson(path.join(stateDir, 'services.json')).services.launchpad
      return row?.state === 'running' && row.pid && row.pid !== oldServicePid
    }, { timeout: 20000, label: 'broker keepAlive restart' })
    const restartedService = readJson(path.join(stateDir, 'services.json')).services.launchpad
    assert.ok(pidAlive(restartedService.pid))
    await waitFor(async () => (await fetchStatus(`${launchpadUrl}/healthz`)) === 200, { timeout: 10000, label: 'launchpad restarted' })
    assert.equal(await fetchStatus(dshUrl), 200)
    t.diagnostic(`9/14 keepAlive：launchpad ${oldServicePid} → ${restartedService.pid}，dsh 仍 200`)

    // 10. 漂移：改 profile → 检测 → apply 恢复；改生成清单 → 检测 → apply 恢复
    const driftProfile = readJson(profileFile)
    driftProfile.dsh.profile.bundles.push('drift-plugin')
    writeJson(profileFile, driftProfile)
    await testFetch(`${launchpadUrl}/api/refresh`, { method: 'POST' })
    await sleep(150)
    const driftInventory = await fetchJson(`${launchpadUrl}/api/inventory`)
    const driftStack = driftInventory.manifests.find((item) => item.path === stackFile)
    assert.ok(driftStack.issues.some((issue) => issue.code === 'stack-profile-drift'))

    runDshd(['stack', 'apply', '--stack', stackFile])
    await testFetch(`${launchpadUrl}/api/refresh`, { method: 'POST' })
    await sleep(150)
    const restoredInventory = await fetchJson(`${launchpadUrl}/api/inventory`)
    const restoredStack = restoredInventory.manifests.find((item) => item.path === stackFile)
    assert.ok(!restoredStack.issues.some((issue) => issue.code === 'stack-profile-drift'))
    assert.deepEqual(readJson(profileFile).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@capyclaw/launchpad'])

    const driftManifest = readJson(manifestFile)
    driftManifest.services = []
    writeJson(manifestFile, driftManifest)
    await testFetch(`${launchpadUrl}/api/refresh`, { method: 'POST' })
    await sleep(150)
    const manifestDriftInventory = await fetchJson(`${launchpadUrl}/api/inventory`)
    const manifestDriftStack = manifestDriftInventory.manifests.find((item) => item.path === stackFile)
    assert.ok(manifestDriftStack.issues.some((issue) => issue.code === 'stack-manifest-drift'))

    runDshd(['stack', 'apply', '--stack', stackFile])
    await testFetch(`${launchpadUrl}/api/refresh`, { method: 'POST' })
    await sleep(150)
    const manifestRestoredInventory = await fetchJson(`${launchpadUrl}/api/inventory`)
    const manifestRestoredStack = manifestRestoredInventory.manifests.find((item) => item.path === stackFile)
    assert.ok(!manifestRestoredStack.issues.some((issue) => issue.code === 'stack-manifest-drift'))
    assert.equal(readJson(manifestFile).services.length, 1)
    t.diagnostic('10/14 漂移：profile/manifest 都能检测并用 apply 恢复')

    // 9. stop：回收全部进程与端口
    runDshd(['stop', '--stack', stackFile])
    await Promise.all([brokerPort, proxyPort, upPort, launchpadPort].map((port) => waitPortClosed(port)))
    assert.equal(await fetchStatus(dshUrl), null)
    assert.equal(await fetchStatus(`${launchpadUrl}/healthz`), null)
    assert.equal(existsSync(path.join(stateDir, 'state.json')), false)
    t.diagnostic('11/14 stop：broker/dsh/launchpad 进程与 4 个端口全部释放')

    // 10. 连续冷启/停止 2 轮，验证端口释放与重复拉起稳定
    for (let cycle = 1; cycle <= 2; cycle++) {
      runDshd(['start', '--stack', stackFile])
      await waitFor(async () => (await fetchStatus(dshUrl)) === 200, { timeout: 30000, label: `cycle ${cycle} dsh ready` })
      await fetchJson(`${launchpadUrl}/healthz`)
      runDshd(['stop', '--stack', stackFile])
      await Promise.all([brokerPort, proxyPort, upPort, launchpadPort].map((port) => waitPortClosed(port)))
      t.diagnostic(`12/14 重启循环 ${cycle}/2 OK`)
    }

    // 11. 失败路径：非法 stack 在编译阶段拒绝，不拉任何进程
    const badStack = JSON.parse(JSON.stringify(stack))
    badStack.services = [badStack.services[0], badStack.services[0]]
    const badFile = path.join(temp, 'bad-stack.json')
    writeJson(badFile, badStack)
    const badPlan = runDshd(['stack', 'plan', '--stack', badFile], { allowFail: true })
    assert.notEqual(badPlan.status, 0)
    const badStart = runDshd(['start', '--stack', badFile], { allowFail: true })
    assert.notEqual(badStart.status, 0)
    for (const port of [brokerPort, proxyPort, upPort, launchpadPort]) {
      assert.equal(await portOpen(port), false, `非法 stack 不应占用端口 ${port}`)
    }
    t.diagnostic('13/14 失败路径：重复服务 id 被拒，未拉起进程')

    // 12. 外部栈隔离：桌面 3016/39311 与当前 dev 13594/13596 状态不变
    const afterExternal = await snapshotExternalStacks()
    for (const key of Object.keys(beforeExternal)) {
      if (beforeExternal[key] !== null) {
        assert.equal(afterExternal[key], beforeExternal[key], `${key} 被测试影响`)
      }
    }
    t.diagnostic(`14/14 隔离：外部栈状态未变 ${JSON.stringify(afterExternal)}`)
  } finally {
    const cleanupErrors = []
    for (const file of [stackBFile, stackFile].filter(Boolean)) {
      try {
        const stop = runDshd(['stop', '--stack', file], { timeout: 60000, allowFail: true })
        if (stop.status !== 0) cleanupErrors.push(`${file}: ${stop.stderr}`)
      } catch (error) { cleanupErrors.push(`${file}: ${error.message}`) }
    }
    if (cleanupErrors.length) throw new Error(`隔离栈未能安全回收，保留 ${temp}: ${cleanupErrors.join('\n')}`)
    for (const port of [brokerPort, proxyPort, upPort, launchpadPort]) {
      try { await waitPortClosed(port, 5000) } catch { /* 留给下面的清理 */ }
    }
    try {
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      t.diagnostic(`临时目录清理失败（可手工检查）: ${temp}: ${error.message}`)
    }
  }
})

test('失败服务/端口冲突：dsh 仍可用，status/doctor 诚实报 missing', { timeout: 120000 }, async (t) => {
  const beforeExternal = await snapshotExternalStacks()
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dsh-stack-fail-'))
  const [brokerPort, proxyPort, upPort, launchpadPort, badExitPort, badPort] = await uniquePorts(6)
  const home = path.join(temp, 'home')
  const stateDir = path.join(temp, '.dshd', 'state')
  const stackFile = path.join(temp, 'dsh-stack.json')
  const badExitFile = path.join(temp, 'bad-exit.mjs')
  const badPortFile = path.join(temp, 'bad-port.mjs')
  const dshUrl = `http://127.0.0.1:${proxyPort}/`
  const launchpadUrl = `http://127.0.0.1:${launchpadPort}`

  await mkdir(path.join(temp, 'workspace'), { recursive: true })
  await writeFile(badExitFile, 'process.exit(1)\n')
  await writeFile(badPortFile, 'process.exit(0)\n')

  // 占住一个端口：broker 必须诚实报“端口被其他进程占用”
  const dummy = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not a service')
  })
  await new Promise((resolve, reject) => {
    dummy.once('error', reject)
    dummy.listen(badPort, '127.0.0.1', resolve)
  })

  const stack = {
    name: 'chain-failure',
    home: './home',
    profile: 'web',
    workspace: './workspace',
    stateDir: './.dshd/state',
    ports: { broker: brokerPort, proxy: proxyPort, upstream: upPort },
    plugins: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        { name: '@capyclaw/launchpad', path: PLUGIN },
      ],
      dependencies: { 'dsh-plugin-kit': PLUGIN_KIT },
      install: true,
    },
    services: [
      {
        id: 'launchpad',
        path: path.join(PLUGIN, 'server.mjs'),
        args: [
          '--roots', `${REPO},${temp}`,
          '--dsh-home', '${home}',
          '--broker-url', `http://127.0.0.1:${brokerPort}`,
          '--launchpads', path.join(temp, 'launchpads'),
          '--dshd', DSHD,
        ],
        ports: { main: launchpadPort },
        healthPath: '/healthz',
        keepAlive: true,
      },
      { id: 'bad-exit', path: badExitFile, ports: { main: badExitPort }, keepAlive: false },
      { id: 'bad-port', path: badPortFile, ports: { main: badPort }, keepAlive: false },
    ],
  }
  writeJson(stackFile, stack)

  try {
    const start = runDshd(['start', '--stack', stackFile])
    assert.match(start.stdout, /⚠ bad-exit: 清单声明但未就绪/)
    assert.match(start.stdout, /⚠ bad-port: 清单声明但未就绪/)
    await waitFor(async () => (await fetchStatus(dshUrl)) === 200, { timeout: 30000, label: 'failure stack dsh ready' })
    const health = await fetchJson(`${launchpadUrl}/healthz`)
    assert.equal(health.ok, true)
    assert.equal(health.port, launchpadPort)
    t.diagnostic('失败栈：dsh 200 + launchpad 200，坏服务未拖垮整链')

    const status = runDshd(['status', '--stack', stackFile])
    assert.match(status.stdout, /bad-exit/)
    assert.match(status.stdout, /bad-port/)
    assert.match(status.stdout, /stopped/)

    const doctor = runDshd(['doctor', '--stack', stackFile], { allowFail: true })
    assert.notEqual(doctor.status, 0)
    assert.match(doctor.stdout, /✗ bad-exit/)
    assert.match(doctor.stdout, /✗ bad-port/)
    assert.match(doctor.stdout, /✓ dsh \(auth-proxy\)/)
    assert.match(doctor.stdout, /✓ launchpad/)
    t.diagnostic('失败栈：status 列出 missing，doctor 对 missing 返回非 0')

    const brokerLog = readFileSync(path.join(stateDir, 'logs', 'broker.log'), 'utf8')
    assert.match(brokerLog, /✗ bad-exit/)
    assert.match(brokerLog, /端口 .* 已被其他进程占用/)
    t.diagnostic('失败栈：broker.log 如实记录早退与端口冲突')

    const incomplete = runDshd(['stop', '--stack', stackFile], { allowFail: true })
    assert.notEqual(incomplete.status, 0)
    assert.match(incomplete.stderr, /ownership:bad-exit\.json:unresolved/)
    // The fixture is exactly process.exit(1), so this test can resolve its own
    // receipt. Production cannot infer absence of descendants from root exit.
    await rm(path.join(stateDir, 'services.json.ownership', 'bad-exit.json'))
    runDshd(['stop', '--stack', stackFile])
    await Promise.all([brokerPort, proxyPort, upPort, launchpadPort].map((port) => waitPortClosed(port)))

    const afterExternal = await snapshotExternalStacks()
    for (const key of Object.keys(beforeExternal)) {
      if (beforeExternal[key] !== null) {
        assert.equal(afterExternal[key], beforeExternal[key], `${key} 被失败测试影响`)
      }
    }
    t.diagnostic('失败栈：停止后端口释放，外部栈状态未变')
  } finally {
    // Start can fail after creating children, before returning successfully.
    // This fixture is exactly process.exit(1), so it cannot leave descendants.
    await rm(path.join(stateDir, 'services.json.ownership', 'bad-exit.json'), { force: true })
    const stop = runDshd(['stop', '--stack', stackFile], { timeout: 60000, allowFail: true })
    if (stop.status !== 0) {
      t.diagnostic(`隔离栈未能安全回收，保留 ${temp}: ${stop.stderr}`)
    }
    await new Promise((resolve) => {
      try { dummy.close(() => resolve()) } catch { resolve() }
    })
    if (stop.status !== 0) throw new Error(`隔离栈未能安全回收，保留 ${temp}: ${stop.stderr}`)
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
})

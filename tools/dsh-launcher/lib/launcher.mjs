/**
 * dshd 核心：把「桌面后端执行启动清单」这件事抽成一个独立进程组。
 *
 * 启动链（与桌面前端完全同构，但零桌面依赖）：
 *
 *   dshd start
 *     ├─ ① broker   node <brokerDir>/server.mjs --manifest <清单> --port <p>
 *     │      └─ 按清单拉起各服务（ppt-workbench / dsh-skills …），写 discovery，
 *     │         keepAlive 守护由 broker 内置 guard 承担
 *     ├─ ② dsh      node <harnessDir>/auth-proxy.mjs（env 注入 DSH_HOME/PROFILE/
 *     │              WORKSPACE/端口/锁/ discovery）
 *     └─ ③ 就绪后写本包 state.json，输出浏览器入口（可选 --open）
 *
 * 幂等：已在跑 → 直接报告不重启；broker 复用优先收编端口上的健康实例。
 * 停机：仅对已验证的 broker 请求停止其 owned 服务，并验证进程身份。
 */
import { spawn, spawnSync } from 'node:child_process'
import { processIdentity, processAlive, verifiedKill } from './process-identity.mjs'
import { marker as recoveryMarker, absent as processAbsent, recoverServices, remainingReceipts } from '../../../packages/dsh-service-broker/lib/recovery.mjs'
import { connect, createServer } from 'node:net'
import { existsSync, mkdirSync, readdirSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  clearState, clearSupervisor, discoveryFile, dshLockFile, loadState, loadSupervisor,
  logsDir, saveState, saveSupervisor, startLockFile, stateFile,
} from './state.mjs'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

const IS_WIN = process.platform === 'win32'

/* ---------------- 基础探测原语（与 broker / works_runtime 同口径） ---------------- */

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function tcpAlive(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { socket.destroy() } catch { /* 已销毁 */ } resolve(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 任意 HTTP 响应都算活（对 auth-proxy 这种「排队闸」监听器，状态码无意义）。 */
export async function httpAny(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitTcp(port, { deadlineMs = 20000, pollMs = 300 } = {}) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await tcpAlive(port)) return true
    await sleep(pollMs)
  }
  return false
}

async function waitHttpAny(url, { deadlineMs = 100000, pollMs = 500 } = {}) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const hit = await httpAny(url, 2500)
    if (hit.ok) return hit
    await sleep(pollMs)
  }
  return { ok: false, status: 0 }
}

/* ---------------- 进程拉起（分离进程，与桌面同语义：不随 launcher 退出） ---------------- */

function spawnDetached(cmd, args, { cwd, env, logFile }) {
  // cwd 不存在时 spawn 只发异步 error 事件（Windows 上常见 ENOENT），pid 为空且原因不可见。
  // 预检 + 落日志，把真实原因带出来，否则上层只能看到 "进程创建失败" 而无从排查。
  if (cwd && !existsSync(cwd)) {
    throw new Error(`进程工作目录不存在: ${cwd}（请修正配置中的 workspace，或先创建该目录）`)
  }
  mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(cmd, args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    })
    child.on('error', (error) => {
      try {
        appendFileSync(logFile, `[dshd] spawn error: ${error?.code ? error.code + ' ' : ''}${error?.message || error}\n`)
      } catch { /* 日志失败不阻断 */ }
    })
    child.unref()
    if (!child.pid) throw new Error(`进程创建失败: ${cmd}（真实原因见 ${logFile} 末尾的 spawn error 行）`)
    return child.pid
  } finally {
    closeSync(fd)
  }
}

function note(stateDir, id, text) {
  try {
    mkdirSync(logsDir(stateDir), { recursive: true })
    appendFileSync(path.join(logsDir(stateDir), `${id}.log`),
      `[dshd] ${new Date().toISOString()} ${text}\n`)
  } catch { /* 日志失败不阻断 */ }
}

/* ---------------- discovery 只读 ---------------- */

export async function readDiscovery(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const services = raw?.services
    return services && typeof services === 'object' ? services : {}
  } catch {
    return {}
  }
}

/* ---------------- 端口解析 ---------------- */

async function resolvePort(want, label) {
  if (want === 'auto') return freePort()
  if (await tcpAlive(want)) throw new Error(`${label}=${want} 已被占用（固定端口不自动换，诚实失败）`)
  return want
}

/* ---------------- start ---------------- */

function acquireStartLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // An incomplete, abandoned or unverifiable lock is not proof that it is safe
      // to remove. In particular another process may still be writing its owner.
      throw new Error(`运行时生命周期锁已存在或归属不明: ${file}；请确认无操作进行后手动清理`)
    }
  }
  throw new Error(`无法获取启动锁: ${file}`)
}

function releaseStartLock(file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'))
    if (info?.pid === process.pid) unlinkSync(file)
  } catch { /* 不存在或不是自己的 */ }
}

/** 启动入口：先拿启动锁（并发冷启会各拉一套），再执行真正拉起。 */
export async function start(cfg, flags = {}) {
  mkdirSync(cfg.stateDir, { recursive: true })
  const lock = startLockFile(cfg.stateDir)
  acquireStartLock(lock)
  try {
    return await startOnce(cfg, flags)
  } finally {
    releaseStartLock(lock)
  }
}

async function startOnce(cfg, flags = {}) {
  const log = (msg) => console.log(msg)
  const disc = discoveryFile(cfg.stateDir)
  const lock = dshLockFile(cfg.stateDir)
  const state = await loadState(cfg.stateDir)

  // A product session cannot adopt a base started without its environment.
  // Reject even malformed state instead of treating it as an empty runtime.
  if (flags.sessionToken && existsSync(stateFile(cfg.stateDir))) {
    throw new Error('已有或无法验证的 base 运行态，产品窗口拒绝复用；请先检查并停止')
  }
  if (state?.brokerStartupPending || state?.dshStartupPending) throw new Error('启动意图尚未解决；请先 stop 并检查')
  // 幂等：dsh 入口仍活 → 已在运行
  if (state?.dsh?.identity?.marker && processIdentity(state.dsh.pid)?.marker === state.dsh.identity.marker && state?.dsh?.proxyPort && (await tcpAlive(state.dsh.proxyPort))) {
    const brokerActual = processIdentity(state?.broker?.pid)
    if (!state?.broker?.identity?.marker || brokerActual?.marker !== state.broker.identity.marker) throw new Error('dsh 仍在运行但 broker 不可验证；请先 stop 安全恢复')
    const url = state.dsh.url
    log(`✓ 已在运行：${url}（如需重启请先 dshd stop）`)
    if (flags.open) openBrowser(url)
    return { already: true, url }
  }
  // 有守护在管但 dsh 已死：不要抢着重启（会与守护的自动重启互相打架）
  const sup = await loadSupervisor(cfg.stateDir)
  if (sup?.pid && pidAlive(sup.pid) && commandLineOf(sup.pid).includes('dshd')) {
    throw new Error(`守护进程 ${sup.pid} 正在管理该栈（dsh 可能正在重启）；先 dshd stop 再重新 start`)
  }

  mkdirSync(cfg.stateDir, { recursive: true })
  if (state || existsSync(stateFile(cfg.stateDir))) throw new Error('存在未清理或无法读取的运行态；请先 stop 并检查未解决的进程')

  const brokerPort = await resolvePort(cfg.brokerPort, 'brokerPort')
  const proxyPort = await resolvePort(cfg.dshProxyPort, 'dshProxyPort')
  const upPort = await resolvePort(cfg.dshUpPort, 'dshUpPort')
  const ports = new Set([brokerPort, proxyPort, upPort])
  if (ports.size !== 3) throw new Error('端口分配撞号（auto 分配结果重复），请重试')

  // Record intent before spawning; never infer ownership after an interrupted spawn.
  const initialState = { productSessionToken: flags.sessionToken || undefined, startedAt: new Date().toISOString(), brokerStartupPending: true, discovery: disc, broker: null, dsh: null }
  await saveState(cfg.stateDir, initialState)
  // An empty manifest otherwise never causes the broker to publish discovery.
  // Do not overwrite existing evidence.
  if (!existsSync(disc)) writeFileSync(disc, JSON.stringify({ services: {} }), { flag: 'wx' })

  // ① broker（开机清单在它启动内完成；listen 就绪 = 清单已处理完）
  log(`⏏ 拉起 broker: ${cfg.brokerDir}/server.mjs --manifest ${cfg.manifest} --port ${brokerPort}`)
  const brokerPid = spawnDetached(process.execPath,
    [path.join(cfg.brokerDir, 'server.mjs'), '--port', String(brokerPort), '--manifest', cfg.manifest],
    {
      env: {
        ...(cfg.env || {}),
        DSH_DISCOVERY_FILE: disc,
        DSH_BROKER_PORT: String(brokerPort),
        DSH_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
      },
      logFile: path.join(logsDir(cfg.stateDir), 'broker.log'),
    })
  const brokerRecoveryMarker = recoveryMarker(brokerPid)
  const broker = { pid: brokerPid, identity: processIdentity(brokerPid), recoveryMarker: brokerRecoveryMarker, port: brokerPort, manifest: cfg.manifest, url: `http://127.0.0.1:${brokerPort}` }
  const startupState = { ...initialState, broker }
  await saveState(cfg.stateDir, startupState)
  const brokerReady = await waitTcp(brokerPort, { deadlineMs: 60000 })
  if (!brokerReady || !pidAlive(brokerPid)) {
    await stopOnce(cfg, { sessionToken: flags.sessionToken })
    throw new Error(`broker 在 60s 内未就绪（日志 ${path.join(logsDir(cfg.stateDir), 'broker.log')}）`)
  }

  // ② dsh（auth-proxy：零登录入口；env 与桌面 services.json 注入完全同构）
  const workspace = cfg.workspace || path.join(cfg.harnessDir, 'workspace')
  mkdirSync(workspace, { recursive: true }) // cwd 必须先存在，否则 spawn ENOENT
  log(`⏏ 拉起 dsh: ${cfg.harnessDir}/auth-proxy.mjs（profile=${cfg.profile}，浏览器端口 ${proxyPort}）`)
  // TCP alone may belong to an unrelated listener; require the recorded broker.
  let brokerVerified = false
  try {
    const response = await fetch(`http://127.0.0.1:${brokerPort}/healthz`, { signal: AbortSignal.timeout(2000) })
    const health = await response.json()
    brokerVerified = response.ok && health?.service === 'dsh-service-broker' && health.pid === brokerPid && broker.identity?.marker && processIdentity(brokerPid)?.marker === broker.identity.marker
  } catch { /* preserve startup intent */ }
  if (!brokerVerified) throw new Error('broker 身份无法验证；保留启动状态，请检查')
  startupState.brokerStartupPending = false
  startupState.dshStartupPending = true
  await saveState(cfg.stateDir, startupState)
  const dshPid = spawnDetached(process.execPath, [path.join(cfg.harnessDir, 'auth-proxy.mjs')], {
    cwd: workspace,
    env: {
      ...(cfg.env || {}),
      DSH_HOME: cfg.dshHome,
      DSH_PROFILE: cfg.profile,
      DSH_WORKSPACE: workspace,
      DSH_PROXY_PORT: String(proxyPort),
      DSH_UP_PORT: String(upPort),
      DSH_LOCK_FILE: lock,
      DSH_DISCOVERY_FILE: disc,
      DSHD_MANAGED: '1',  // 标记为服务管理器启动，允许绕过前台运行守卫
    },
    logFile: path.join(logsDir(cfg.stateDir), 'dsh.log'),
  })
  const dsh = { pid: dshPid, identity: processIdentity(dshPid), proxyPort, upPort, url: `http://127.0.0.1:${proxyPort}/` }
  startupState.dsh = dsh
  startupState.dshStartupPending = false
  await saveState(cfg.stateDir, startupState)

  const up = await waitTcp(proxyPort, { deadlineMs: 30000 })
  if (!up || !pidAlive(dshPid)) {
    await stopOnce(cfg, { sessionToken: flags.sessionToken })
    throw new Error(`dsh 入口在 30s 内未监听（日志 ${path.join(logsDir(cfg.stateDir), 'dsh.log')}）`)
  }
  const url = `http://127.0.0.1:${proxyPort}/`
  log('… 等待 dsh 就绪（token 兑换，浏览器零登录）…')
  const ready = await waitHttpAny(url, { deadlineMs: 100000 })
  if (!ready.ok) {
    log(`⚠ dsh 监听已就绪但 ${100}s 内未完成就绪闸（可能仍在冷启动）；入口 ${url}，稍后直接访问即可`)
  }

  const rows = await readDiscovery(disc)
  const expectedIds = (cfg._compiled?.services || []).map((service) => service.id)
  const missing = expectedIds.filter((id) => !rows[id])
  const services = [
    ...Object.values(rows).map((r) => ({ id: r.id, url: r.url, pid: r.pid, reused: r.reused })),
    ...missing.map((id) => ({ id, url: '', pid: null, missing: true })),
  ]
  await saveState(cfg.stateDir, {
    ...startupState,
    dsh: { ...dsh, ready: ready.ok },
    services,
  })

  log('')
  log(`✓ dsh 就绪: ${url}`)
  for (const s of services) {
    if (s.missing) continue
    log(`  · ${s.id}: ${s.url}${s.reused ? '（收编已运行实例）' : ''}`)
  }
  for (const id of missing) log(`  ⚠ ${id}: 清单声明但未就绪（查看 ${logsDir(cfg.stateDir)}/broker.log）`)
  log(`  broker: http://127.0.0.1:${brokerPort}/control/*`)
  log(`  日志:   ${logsDir(cfg.stateDir)}`)
  if (flags.open) openBrowser(url)
  return { url, brokerPid, dshPid, services, missing }
}

/** 前台守护模式：dsh 死了按原端口重启（限连败次数）；退出时全停。
 *
 * 注意：守护进程被杀（SIGTERM/任务管理器）也必须回收它拉起的 dsh/broker，
 * 否则 detached 子进程会变成孤儿继续占端口（2026-11-02 稳定性测试实测到）。
 * 因此 SIGINT/SIGTERM/exit 全部挂同一个幂等清理。 */
export async function supervise(cfg, { maxRestarts = 3 } = {}) {
  // 守护单实例锁：两个 --foreground 同时盯一份 state 会互相抢重启/互相复活。
  const existing = await loadSupervisor(cfg.stateDir)
  if (existing && pidAlive(existing.pid) && commandLineOf(existing.pid).includes('dshd')) {
    throw new Error(`已有守护进程在运行（pid ${existing.pid}）；先 dshd stop 或结束它`)
  }
  await saveSupervisor(cfg.stateDir, { pid: process.pid, identity: processIdentity(process.pid), startedAt: new Date().toISOString() })

  let failures = 0
  let cleaning = false
  let lastState = null
  const cleanup = async (code = 0) => {
    if (cleaning) return
    cleaning = true
    console.log('\n[dshd] 停机中…')
    try { await stop(cfg) } catch (error) { console.error(`[dshd] 停机失败: ${error.message}`) }
    await clearSupervisor(cfg.stateDir, process.pid)
    process.exit(code)
  }
  process.on('SIGINT', () => { cleanup(0) })
  process.on('SIGTERM', () => { cleanup(0) })
  process.on('SIGHUP', () => { cleanup(0) })
  console.log(`[dshd] 前台守护中（dsh 崩溃自动重启，连续 ${maxRestarts} 次失败让位；Ctrl+C 全停）`)
  for (;;) {
    await sleep(3000)
    const state = await loadState(cfg.stateDir)
    lastState = state
    if (!state) {
      // state 被 dshd stop 清空：守护必须让位，否则会拿旧内存值把 dsh 复活
      console.log('[dshd] 运行态已被停止，守护退出')
      await clearSupervisor(cfg.stateDir, process.pid)
      process.exit(0)
    }
    const dsh = state?.dsh
    if (!dsh?.pid) continue
    if (pidAlive(dsh.pid) && (await tcpAlive(dsh.proxyPort))) { failures = 0; continue }
    failures += 1
    if (failures > maxRestarts) {
      console.error(`[dshd] dsh 连续 ${maxRestarts} 次重启失败，停止守护（日志 ${logsDir(cfg.stateDir)}）`)
      process.exit(1)
    }
    console.log(`[dshd] dsh 进程死亡，第 ${failures} 次重启（原端口 ${dsh.proxyPort}）`)
    note(cfg.stateDir, 'dsh', `守护重启 #${failures}`)
    const prior = verifiedKill(dsh.identity || { pid: dsh.pid })
    if (!prior.ok || processAlive(dsh.pid)) { console.error('[dshd] 无法验证或停止旧进程，停止重启'); break }
    await saveState(cfg.stateDir, { ...state, dsh: null, dshStartupPending: true })
    const restartWorkspace = cfg.workspace || path.join(cfg.harnessDir, 'workspace')
    mkdirSync(restartWorkspace, { recursive: true }) // cwd 必须先存在，否则 spawn ENOENT
    const pid = spawnDetached(process.execPath, [path.join(cfg.harnessDir, 'auth-proxy.mjs')], {
      cwd: restartWorkspace,
      env: {
        ...(cfg.env || {}),
        DSH_HOME: cfg.dshHome,
        DSH_PROFILE: cfg.profile,
        DSH_WORKSPACE: restartWorkspace,
        DSH_PROXY_PORT: String(dsh.proxyPort),
        DSH_UP_PORT: String(dsh.upPort),
        DSH_LOCK_FILE: dshLockFile(cfg.stateDir),
        DSH_DISCOVERY_FILE: discoveryFile(cfg.stateDir),
      },
      logFile: path.join(logsDir(cfg.stateDir), 'dsh.log'),
    })
    await saveState(cfg.stateDir, { ...state, dshStartupPending: !pid, dsh: { ...dsh, pid, identity: processIdentity(pid) } })
  }
}

/* ---------------- stop ---------------- */

async function brokerStop(broker, id) {
  const base = `http://127.0.0.1:${broker.port}`
  const headers = { 'Content-Type': 'application/json' }
  if (broker.token || process.env.DSH_BROKER_TOKEN) headers['x-broker-token'] = broker.token || process.env.DSH_BROKER_TOKEN
  try {
    const res = await fetch(`${base}/control/stop`, {
      method: 'POST', headers, body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(10000),
    })
    const body = await res.json()
    return res.ok && body?.stopped === true
  } catch {
    return false
  }
}

export async function stop(cfg, options = {}) {
  mkdirSync(cfg.stateDir, { recursive: true })
  const lock = startLockFile(cfg.stateDir)
  acquireStartLock(lock)
  try { return await stopOnce(cfg, options) }
  finally { releaseStartLock(lock) }
}

async function stopOnce(cfg, { sessionToken } = {}) {
  const state = await loadState(cfg.stateDir)
  if (!state && existsSync(stateFile(cfg.stateDir))) throw new Error('运行态无法读取，拒绝停止并保留状态')
  if (sessionToken && state?.productSessionToken !== sessionToken) {
    throw new Error('base 运行态不属于此产品会话，拒绝停止')
  }
  const disc = state?.discovery || discoveryFile(cfg.stateDir)
  let rows = {}
  let discoveryError = false
  if (existsSync(disc)) {
    try {
      const raw = JSON.parse(await readFile(disc, 'utf8'))
      if (!raw?.services || typeof raw.services !== 'object' || Array.isArray(raw.services)) throw new Error('invalid discovery')
      rows = raw.services
    } catch { discoveryError = true }
  }
  const stopped = []
  const unresolved = discoveryError ? ['discovery:unreadable'] : (state?.broker && !existsSync(disc) ? ['discovery:missing'] : [])
  if (state?.brokerStartupPending) unresolved.push('broker:startup-interrupted')
  if (state?.dshStartupPending) unresolved.push('dsh:startup-interrupted')
  const borrowed = []
  const supervisor = await loadSupervisor(cfg.stateDir)
  if (supervisor?.pid && supervisor.pid !== process.pid) {
    const result = verifiedKill(supervisor.identity || { pid: supervisor.pid })
    if (!result.ok) unresolved.push(`supervisor:${supervisor.pid}:${result.reason}`)
    else {
      for (let i = 0; i < 20 && processAlive(supervisor.pid); i++) await sleep(100)
      if (processAlive(supervisor.pid)) unresolved.push(`supervisor:${supervisor.pid}:still-running`)
      else { stopped.push(`supervisor:${supervisor.pid}`); await clearSupervisor(cfg.stateDir, supervisor.pid) }
    }
  }
  let recovered = new Set()
  if (state?.broker?.pid && processAbsent(state.broker.pid)) {
    const report = await recoverServices(disc, { ...state.broker.identity, recoveryMarker: state.broker.recoveryMarker })
    stopped.push(...report.stopped)
    recovered = new Set(report.stopped)
    unresolved.push(...report.unresolved)
  }
  // Discovery is not proof of ownership or PID identity. In particular an old
  // broker may kill adopted services even through its control endpoint.
  for (const [id, row] of Object.entries(rows)) {
    if (recovered.has(id)) continue
    if (row?.reused === true || row?.ownership === 'borrowed' || row?.ownership === 'reused') { borrowed.push(id); continue }
    // `error` rows may be dead roots whose receipt the broker can resolve once
    // its declared ports are free; asking the broker keeps that check in one place.
    if (row?.state !== 'running' && row?.state !== 'error') continue
    const actual = processIdentity(state?.broker?.pid)
    const trusted = state?.broker?.identity?.marker && actual?.marker === state.broker.identity.marker
    if (row.ownership === 'owned' && trusted && await brokerStop({ ...state.broker, token: cfg.env?.DSH_BROKER_TOKEN }, id)) stopped.push(id)
    else unresolved.push(`service:${id}:ownership-unverified-or-stop-failed`)
  }
  if (state?.broker?.recoveryMarker && !processAbsent(state.broker.pid)) unresolved.push(...remainingReceipts(disc))
  for (const name of ['broker', 'dsh']) {
    const item = state?.[name]
    if (!item?.pid) continue
    if (name === 'broker' && unresolved.length) continue
    const result = verifiedKill(item.identity || { pid: item.pid })
    if (!result.ok) { unresolved.push(`${name}:${item.pid}:${result.reason}`); continue }
    for (let i = 0; i < 30 && processAlive(item.pid); i++) await sleep(100)
    if (processAlive(item.pid)) unresolved.push(`${name}:${item.pid}:still-running`)
    else stopped.push(name)
  }
  if (unresolved.length) {
    if (state) await saveState(cfg.stateDir, { ...state, stopResult: { stopped, borrowed, unresolved } })
    console.error(`停机未完成，保留状态: ${unresolved.join(', ')}`)
    process.exitCode = 1
  } else {
    await clearState(cfg.stateDir)
    console.log(`已停止: ${stopped.join(', ') || '无'}${borrowed.length ? `；借用服务保留: ${borrowed.join(', ')}` : ''}`)
  }
  return { stopped, borrowed, unresolved, ok: unresolved.length === 0 }
}

/** 端口监听者 pid（Windows netstat / 其他平台 lsof 尽力）。 */
function pidsListeningOn(port) {
  try {
    if (IS_WIN) {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout || ''
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
        const m = line.trim().match(/\s(\d+)$/)
        if (m) pids.add(Number(m[1]))
      }
      return [...pids]
    }
    const out = spawnSync('sh', ['-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`], { encoding: 'utf8' }).stdout || ''
    return out.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** 进程命令行（身份核验用；取不到返回空串 = 不误杀）。 */
function commandLineOf(pid) {
  try {
    if (IS_WIN) {
      const out = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
        { encoding: 'utf8' }).stdout || ''
      return out.replace(/CommandLine\s*/i, '').trim()
    }
    return spawnSync('sh', ['-c', `ps -p ${pid} -o args= 2>/dev/null`], { encoding: 'utf8' }).stdout || ''
  } catch {
    return ''
  }
}

/* ---------------- status / doctor ---------------- */

async function rowHealth(row) {
  const port = Number(Object.values(row?.ports || {})[0]) || 0
  const url = String(row?.url || '')
  const hit = url ? await httpAny(url, 1200) : { ok: false }
  const alive = pidAlive(Number(row?.pid) || 0)
  return { alive, listening: port ? await tcpAlive(port) : false, http: hit.ok, status: hit.status }
}

export async function statusRows(cfg) {
  const state = await loadState(cfg.stateDir)
  const rows = await readDiscovery(state?.discovery || discoveryFile(cfg.stateDir))
  const out = []
  if (state?.dsh?.proxyPort) {
    const tcp = await tcpAlive(state.dsh.proxyPort)
    const hit = tcp ? await httpAny(state.dsh.url, 3000) : { ok: false }
    out.push({
      id: 'dsh (auth-proxy)', kind: 'dsh',
      pid: state.dsh.pid, pidAlive: pidAlive(state.dsh.pid),
      url: state.dsh.url, ready: tcp && hit.ok, reused: false,
    })
  }
  if (state?.broker?.port) {
    const hit = await httpAny(`${state.broker.url}/healthz`, 1200)
    out.push({
      id: 'service-broker', kind: 'broker',
      pid: state.broker.pid, pidAlive: pidAlive(state.broker.pid),
      url: `${state.broker.url}/control/*`, ready: hit.ok, reused: false,
    })
  }
  const seen = new Set()
  for (const row of Object.values(rows)) {
    seen.add(row.id)
    const h = await rowHealth(row)
    out.push({
      id: row.id, kind: 'service',
      pid: row.pid, pidAlive: h.alive,
      url: row.url, ready: h.http && h.alive, reused: !!row.reused,
    })
  }
  /* stack 声明的服务如果启动失败，discovery 里可能没有行；按期望补一行，
   * 让 status/doctor 诚实地显示 missing，而不是整套栈“全绿”。 */
  if ((state?.dsh || state?.broker) && cfg._compiled?.services) {
    for (const service of cfg._compiled.services) {
      if (seen.has(service.id)) continue
      let url = service.url || ''
      if (typeof service.ports?.main === 'number') {
        url = url.replaceAll('${PORT}', String(service.ports.main))
      }
      out.push({
        id: service.id, kind: 'service',
        pid: null, pidAlive: false,
        url: url || '(declared)', ready: false, reused: false, missing: true,
      })
    }
  }
  return out
}

export async function printStatus(cfg) {
  const rows = await statusRows(cfg)
  if (!rows.length) {
    console.log('（没有运行态；dshd start 启动）')
    return
  }
  for (const r of rows) {
    const mark = r.ready ? '●' : (r.pidAlive ? '◐' : '○')
    console.log(`${mark} ${r.id.padEnd(20)} ${r.ready ? 'running' : (r.pidAlive ? 'degraded' : 'stopped')}  ${r.url}${r.reused ? '  (收编)' : ''}`)
  }
}

export async function printDoctor(cfg) {
  const rows = await statusRows(cfg)
  let ok = true
  for (const r of rows) {
    const issues = []
    if (!r.pidAlive) issues.push(`pid ${r.pid ?? '-'} 不存活`)
    if (!r.ready) issues.push('端点无响应')
    if (issues.length) ok = false
    console.log(`${issues.length ? '✗' : '✓'} ${r.id}  ${r.url}${issues.length ? `  — ${issues.join('; ')}` : ''}`)
  }
  if (!rows.length) { console.log('✗ 没有运行态'); ok = false }
  process.exitCode = ok ? 0 : 1
}

/* ---------------- logs / open ---------------- */

export function listLogs(cfg) {
  const dir = logsDir(cfg.stateDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f))
}

export function openBrowser(url) {
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

export { stateFile, logsDir, discoveryFile }

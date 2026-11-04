/**
 * dshd 的 domain 型 stack 执行面。
 *
 * stack 只描述“用哪个 domain + 端口/overrides”；真正的装配/服务/生命周期
 * 全部交给 dsh-suite-kit 的 runtime（createRuntime/startRuntime/stopRuntime）。
 * 这样 profile 栈与 domain 栈共用一份 dsh-stack.json，但各自保留既有契约。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { saveRuntime } from 'dsh-suite-kit/runtime'

import {
  collectSuiteServices,
  createRuntime,
  doctorRuntime,
  readRuntime,
  removeRuntime,
  resolveDomain,
  runtimePublicInfo,
  startRuntime,
  stopRuntime,
} from 'dsh-suite-kit'
import { compileStack, toLauncherConfig } from './stack.mjs'

const IS_WIN = process.platform === 'win32'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Same lock path as the product launcher registry; start/stop/remove cannot race. */
async function withLifecycleLock(cfg, fn) {
  const parent = path.join(path.dirname(cfg.stateDir), '.locks')
  const lock = path.join(parent, `${path.basename(cfg.stateDir)}.lock`)
  fs.mkdirSync(parent, { recursive: true })
  try { fs.mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`domain lifecycle is busy: ${lock}`)
    throw error
  }
  try { return await fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

function supervisorFile(cfg) { return path.join(cfg.stateDir, 'domain-supervisor.json') }
function readSupervisor(cfg) {
  try { return JSON.parse(fs.readFileSync(supervisorFile(cfg), 'utf8')) } catch { return null }
}
function clearOwnedSupervisor(cfg) {
  if (readSupervisor(cfg)?.pid === process.pid) fs.rmSync(supervisorFile(cfg), { force: true })
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

function readRuntimeSafe(cfg) {
  try {
    return readRuntime(cfg.storeRoot, cfg.runtimeId)
  } catch {
    return null
  }
}

function openBrowser(url) {
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

async function probe(url, timeoutMs = 1500) {
  if (!url) return false
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.text().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}

function readDiscovery(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw.services === 'object' ? raw.services : {}
  } catch {
    return {}
  }
}

export function assertDomainConfig(cfg, { forStart = false } = {}) {
  const missing = []
  if (!cfg.storeRoot) missing.push('storeRoot')
  if (!cfg.runtimeId) missing.push('runtimeId')
  if (forStart) {
    if (!cfg.domainSource) missing.push('domain.source')
    else if (!fs.existsSync(cfg.domainSource)) missing.push(`domain.source 不存在: ${cfg.domainSource}`)
    if (!cfg.harnessDir || !fs.existsSync(path.join(cfg.harnessDir, 'auth-proxy.mjs'))) {
      missing.push(`harnessDir 缺少 auth-proxy: ${cfg.harnessDir || '(空)'}`)
    }
    if (!cfg.brokerDir || !fs.existsSync(path.join(cfg.brokerDir, 'server.mjs'))) {
      missing.push(`brokerDir 缺少 server.mjs: ${cfg.brokerDir || '(空)'}`)
    }
  }
  if (missing.length) {
    throw new Error(`domain stack 配置不完整（${cfg._configFile || cfg._stackPath || 'stack'}）:\n  - ${missing.join('\n  - ')}`)
  }
  return cfg
}

// The fence serializes shutdown against the entire domain start, including failed starts.
// Unknown or abandoned locks are deliberately never reclaimed automatically.
async function withSessionFence(dir, fn) {
  const lock = path.join(dir, 'fence.lock')
  const deadline = Date.now() + 180000
  for (;;) {
    try { fs.mkdirSync(lock); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`产品会话栅栏被占用: ${lock}；请检查后手动清理`)
      await sleep(100)
    }
  }
  try { return await fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

function sessionContext() {
  const dir = process.env.DSH_PRODUCT_SESSION_DIR
  const token = process.env.DSH_PRODUCT_SESSION_TOKEN
  if (!dir && !token) return null
  if (!dir || !/^[a-f0-9]{48}$/.test(token || '')) throw new Error('产品会话信息无效')
  return { dir, token }
}

function sessionRead(session) {
  const data = JSON.parse(fs.readFileSync(path.join(session.dir, 'session.json'), 'utf8'))
  if (data.token !== session.token || data.status !== 'open') throw new Error('产品会话已关闭或归属不匹配')
  return data
}

function registerDomain(session, cfg) {
  const key = createHash('sha256').update(path.resolve(cfg.storeRoot) + '\0' + cfg.runtimeId).digest('hex')
  const dir = path.join(session.dir, 'domains')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ stateDir: cfg.stateDir, storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId }))
}

/** domain 的静态摘要：组件/包/行/服务，供 plan/status 展示。 */
export function describeDomain(source) {
  const resolved = resolveDomain(source)
  const domain = resolved.manifest
  return {
    name: domain.name,
    version: domain.version,
    title: domain.title || domain.name,
    profile: domain.profile?.name || '',
    components: resolved.suites.map((suite) => suite.manifest.name),
    packages: resolved.composed.packages.map((pkg) => pkg.name),
    rows: resolved.composed.rows.map((row) => row.id),
    services: collectSuiteServices(resolved).map(({ spec }) => spec.id),
    ports: domain.runtime?.ports || {},
    requires: domain.runtime?.requires || {},
  }
}

/** 创建/复用 runtime。recreate=true 时先删同名 runtime（破坏性）。 */
export async function ensureDomainRuntime(cfg, { recreate = false } = {}) {
  let existing = readRuntimeSafe(cfg)
  if (existing && recreate) {
    removeRuntime({ storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId })
    existing = null
  }
  if (existing) return { runtime: existing, created: false }
  const resolved = resolveDomain(cfg.domainSource)
  const domain = resolved.manifest
  const runtime = await createRuntime({
    domainInput: cfg.domainSource,
    storeRoot: cfg.storeRoot,
    runtimeId: cfg.runtimeId,
    name: cfg.domain?.name || cfg.name,
    profile: cfg.profile || domain.profile?.name || cfg.runtimeId,
    harnessDir: cfg.harnessDir,
    harnessPort: cfg.ports?.harness ?? 0,
    dshPort: cfg.ports?.dsh ?? 0,
    contentPort: cfg.ports?.content ?? 0,
    brokerPort: cfg.ports?.broker ?? 0,
    servicePorts: cfg.ports?.services || {},
    env: cfg.env || {},
    requires: cfg.domain?.requires,
    scope: cfg.domain?.scope,
    model: cfg.domain?.model,
    workspaceController: cfg.domain?.workspaceController,
  })
  return { runtime, created: true }
}

export async function applyDomainStack(stack, { recreate = false } = {}) {
  const compiled = compileStack(stack)
  if (!compiled.valid) {
    const error = new Error(`stack 校验失败:\n- ${compiled.errors.join('\n- ')}`)
    error.code = 'STACK_INVALID'
    error.errors = compiled.errors
    throw error
  }
  const cfg = toLauncherConfig(stack, compiled)
  const ensured = await withLifecycleLock(cfg, () => ensureDomainRuntime(cfg, { recreate: recreate || cfg.domain?.recreate }))
  return {
    applied: true,
    kind: 'domain',
    runtimeId: cfg.runtimeId,
    storeRoot: cfg.storeRoot,
    source: cfg.domainSource,
    created: ensured.created,
    runtime: runtimePublicInfo(ensured.runtime),
    domain: describeDomain(cfg.domainSource),
    warnings: compiled.warnings,
  }
}

export async function startDomain(cfg, flags = {}) {
  const session = sessionContext()
  const start = () => withLifecycleLock(cfg, async () => {
  if (session) sessionRead(session)
  // Recreating an existing runtime is destructive and cannot be attributed safely.
  if (session && (flags.recreate || cfg.domain?.recreate)) throw new Error('产品会话不允许重建 domain runtime')
  const ensured = await ensureDomainRuntime(cfg, { recreate: flags.recreate || cfg.domain?.recreate })
  const prior = ensured.runtime
  if (session && !prior.pids?.proxy && !prior.pids?.broker && !prior.brokerStartupPending && prior.status !== 'stop-incomplete') {
    registerDomain(session, cfg)
    prior.productSession = session.token
    saveRuntime(prior)
  }
  if (!session && prior.productSession && !prior.pids?.proxy && !prior.pids?.broker && !prior.brokerStartupPending) {
    delete prior.productSession
    saveRuntime(prior)
  }
  const started = await startRuntime({
    storeRoot: cfg.storeRoot,
    runtimeId: cfg.runtimeId,
    harnessDir: cfg.harnessDir,
    waitMs: 100000,
  })
  const runtime = started.runtime
  const url = `http://127.0.0.1:${runtime.ports.harness}/`
  const discovery = readDiscovery(runtime.services?.discovery)
  console.log(ensured.created ? '✓ 已创建 domain runtime' : '✓ 复用 domain runtime')
  console.log(started.alreadyRunning ? `✓ 已在运行：${url}（如需重启请先 dshd stop）` : `✓ dsh 就绪: ${url}`)
  for (const id of runtime.services?.ids || []) {
    const row = discovery[id]
    const port = runtime.ports?.services?.[id]
    console.log(`  · ${id}: ${row?.url || (port ? `http://127.0.0.1:${port}` : '(declared)')}${row?.reused ? '（收编已运行实例）' : ''}`)
  }
  if (runtime.services?.brokerPort) console.log(`  broker: http://127.0.0.1:${runtime.services.brokerPort}/control/*`)
  console.log(`  日志:   ${runtime.paths.logs}`)
  if (!runtime.ready) console.log(`⚠ 已启动但就绪闸未在等待时间内通过；入口 ${url}，稍后直接访问即可`)
  if (flags.open || cfg.open) openBrowser(url)
  return { url, runtime, started, created: ensured.created }
  })
  return session ? withSessionFence(session.dir, start) : start()
}

export async function stopDomain(cfg, { sessionToken } = {}) {
  return withLifecycleLock(cfg, async () => {
    const supervisor = readSupervisor(cfg)
    if (supervisor?.pid !== process.pid && pidAlive(supervisor?.pid)) {
      throw new Error(`domain 前台守护进程仍在运行（PID ${supervisor.pid}）；请先停止该前台会话`)
    }
    const runtime = readRuntimeSafe(cfg)
    if (!runtime) {
      console.log('（没有 domain runtime，无事可做）')
      return { stopped: [] }
    }
    if (sessionToken && runtime.productSession !== sessionToken) {
      console.log('domain 不属于本产品会话，保留')
      return { stopped: [] }
    }
    const wasRunning = pidAlive(runtime.pids?.proxy)
    await stopRuntime({ storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId })
    console.log(`✓ 已停止 domain runtime ${cfg.runtimeId}${wasRunning ? '' : '（原本未运行）'}`)
    return { stopped: [cfg.runtimeId] }
  })
}

export async function domainStatusRows(cfg) {
  const runtime = readRuntimeSafe(cfg)
  if (!runtime) return []
  const rows = []
  const harnessPort = runtime.ports?.harness
  const harnessUrl = harnessPort ? `http://127.0.0.1:${harnessPort}/` : ''
  const harnessAlive = pidAlive(runtime.pids?.proxy)
  rows.push({
    id: 'dsh (auth-proxy)', kind: 'dsh', pid: runtime.pids?.proxy, pidAlive: harnessAlive,
    url: harnessUrl, ready: harnessAlive && await probe(harnessUrl), reused: false,
  })
  if (runtime.services?.brokerPort) {
    const url = `http://127.0.0.1:${runtime.services.brokerPort}/healthz`
    rows.push({
      id: 'service-broker', kind: 'broker', pid: runtime.pids?.broker,
      pidAlive: pidAlive(runtime.pids?.broker), url: url.replace('/healthz', '/control/*'),
      ready: pidAlive(runtime.pids?.broker) && await probe(url), reused: false,
    })
  }
  const discovery = readDiscovery(runtime.services?.discovery)
  for (const id of runtime.services?.ids || []) {
    const row = discovery[id]
    const port = runtime.ports?.services?.[id]
    const url = row?.url || (port ? `http://127.0.0.1:${port}` : '')
    const alive = row ? pidAlive(Number(row.pid)) : false
    const health = url ? `${String(url).replace(/\/$/, '')}${row?.healthPath || '/healthz'}` : ''
    rows.push({
      id, kind: 'service', pid: row?.pid ?? null, pidAlive: alive,
      url: url || '(declared)', ready: alive && await probe(health), reused: !!row?.reused,
    })
  }
  for (const check of runtime.checks || []) {
    if (check.type !== 'http') continue
    rows.push({
      id: check.id, kind: 'check', pid: null, pidAlive: true,
      url: check.url, ready: await probe(check.url), reused: false,
    })
  }
  return rows
}

export async function printDomainStatus(cfg) {
  const runtime = readRuntimeSafe(cfg)
  if (!runtime) {
    console.log('（没有 domain runtime；dshd stack apply / start 创建）')
    return
  }
  const rows = await domainStatusRows(cfg)
  for (const r of rows) {
    const mark = r.ready ? '●' : (r.pidAlive ? '◐' : '○')
    console.log(`${mark} ${r.id.padEnd(20)} ${r.ready ? 'running' : (r.pidAlive ? 'degraded' : 'stopped')}  ${r.url}${r.reused ? '  (收编)' : ''}`)
  }
}

export async function printDomainDoctor(cfg) {
  const runtime = readRuntimeSafe(cfg)
  if (!runtime) {
    console.log('✗ 没有 domain runtime')
    process.exitCode = 1
    return
  }
  const report = await doctorRuntime({ storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId })
  for (const check of report.checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.id}  ${check.url || check.path || ''}${check.error ? `  — ${check.error}` : ''}`)
  }
  process.exitCode = report.ok ? 0 : 1
}

export function listDomainLogs(cfg) {
  const runtime = readRuntimeSafe(cfg)
  if (!runtime) return []
  const dir = runtime.paths?.logs
  if (!dir || !fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((file) => file.endsWith('.log')).map((file) => path.join(dir, file))
}

/**
 * 前台守护：只守护 domain runtime 的 proxy；proxy 死 → 整组 stop+start（限次）。
 * 服务/broker 的 keepAlive 由 broker 自己承担；这里不重复实现。
 */
export async function superviseDomain(cfg, { maxRestarts = 3 } = {}) {
  fs.mkdirSync(cfg.stateDir, { recursive: true })
  const file = supervisorFile(cfg)
  if (fs.existsSync(file)) {
    const existing = readSupervisor(cfg)
    if (!existing || !Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error(`domain supervisor 记录损坏: ${file}`)
    if (pidAlive(existing.pid)) throw new Error(`domain supervisor 已运行（PID ${existing.pid}）`)
    fs.rmSync(file, { force: true })
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' })
  process.on('exit', () => { try { clearOwnedSupervisor(cfg) } catch { /* best effort */ } })
  let cleaning = false
  const cleanup = async (code = 0) => {
    if (cleaning) return
    cleaning = true
    console.log('\n[dshd] 停机中…')
    try { await stopDomain(cfg) } catch (error) { console.error(`[dshd] 停机失败: ${error.message}`) }
    process.exit(code)
  }
  process.on('SIGINT', () => { void cleanup(0) })
  process.on('SIGTERM', () => { void cleanup(0) })

  console.log('[dshd] 前台守护中（domain runtime；Ctrl+C 全停）')
  let failures = 0
  while (true) {
    await sleep(3000)
    const runtime = readRuntimeSafe(cfg)
    if (!runtime) {
      console.error('[dshd] runtime 记录消失，退出守护')
      return
    }
    if (pidAlive(runtime.pids?.proxy)) continue
    failures++
    if (failures > maxRestarts) {
      console.error(`[dshd] domain proxy 连续 ${maxRestarts} 次重启失败，停止守护`)
      await cleanup(1)
      return
    }
    console.log(`[dshd] domain proxy 已退出，重启（${failures}/${maxRestarts}）…`)
    try {
      await withLifecycleLock(cfg, async () => {
        await stopRuntime({ storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId })
        await startRuntime({ storeRoot: cfg.storeRoot, runtimeId: cfg.runtimeId, harnessDir: cfg.harnessDir, waitMs: 100000 })
      })
    } catch (error) {
      console.error(`[dshd] 重启失败: ${error.message}`)
    }
  }
}

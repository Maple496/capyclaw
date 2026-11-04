/**
 * dsh-service-broker 引擎：服务编排核心。
 *
 * 职责边界（对应服务解耦标准）：
 *   - 接收「结构化命令」（清单或外部投递），把每个服务作为**独立进程**拉起；
 *   - 服务之间不互相感知、不互相带动；跨端口组织只发生在这里；
 *   - 复用优先：目标端口已有健康实例（/healthz 且带 pid）则收编不重启；
 *   - keepAlive 守护：进程死亡自动按原端口重启（限次）；
 *   - 运行事实写入 discovery 注册表（discovery.mjs），供 UI/侧栏/外部查询。
 *
 * 引擎不 import 任何 dsh 代码：embedded（cordis 插件壳）与 standalone
 * （server.mjs）两种形态共用这一份逻辑。
 */
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDiscovery, saveDiscovery } from './discovery.mjs'
import { marker, markerAsync, absent, receiptPath, writeReceipt, removeReceipt, receiptResolvable, waitReceiptResolvable } from './recovery.mjs'

const VAR_RE = /\$\{([^{}]+)\}/g
const IS_WIN = process.platform === 'win32'

/* ------------------------------------------------------------------ *
 * 基础探测原语（与 @capyclaw/suite-kit/src/runtime.mjs 同口径）
 * ------------------------------------------------------------------ */

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// OS creation identity, not a health endpoint's self-reported PID. Unsupported or
// inaccessible platforms deliberately return null and cannot authorize a kill.
export function processIdentity(pid) {
  return marker(pid)
}

export function canConnect(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { socket.destroy() } catch { /* 已销毁 */ } resolve(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** bind :0 取一个当前空闲端口（分配后立刻释放，存在理论竞争，和 works_runtime 同口径）。 */
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export async function probeHttp(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } catch {
    return { ok: false, status: 0, body: '' }
  }
}

/** 健康探测并尽力取回对端自报的 pid（服务标准：/healthz 带 pid 字段）。
 *  返回：null=不健康；-1=健康但无 pid；>0=健康且自报 pid。 */
export async function healthzPid(url, timeoutMs = 1500) {
  const hit = await probeHttp(url, timeoutMs)
  if (!hit.ok) return null
  try {
    const parsed = JSON.parse(hit.body)
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : -1
  } catch {
    return -1
  }
}

/* ------------------------------------------------------------------ *
 * 规格规范化与 ${VAR} 展开（与桌面后端 works_services 契约对齐）
 * ------------------------------------------------------------------ */

export function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('service spec 必须是对象')
  const spec = { ...raw }
  if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(spec.id)) {
    throw new Error(`service spec.id 非法: ${JSON.stringify(spec?.id)}`)
  }
  if (spec.cmd !== undefined) {
    if (!Array.isArray(spec.cmd) || !spec.cmd.length || !spec.cmd.every((a) => typeof a === 'string')) {
      throw new Error(`service ${spec.id}: cmd 必须是非空字符串数组`)
    }
  }
  if (spec.requires !== undefined && !Array.isArray(spec.requires)) {
    throw new Error(`service ${spec.id}: requires 必须是数组`)
  }
  return {
    cmd: undefined,
    env: {},
    cwd: undefined,
    ports: {},
    url: undefined,
    healthPath: '/healthz',
    keepAlive: true,
    requires: [],
    logFile: undefined,
    ...spec,
  }
}

export function specHash(spec) {
  const pick = (({ cmd, env, cwd, ports, url, healthPath }) =>
    JSON.stringify({ cmd, env, cwd, ports, url, healthPath }))(spec)
  return Buffer.from(pick).toString('base64url')
}

/** ${VAR} 展开：ctx 缺失的变量 → 空串（诚实降级，与桌面后端同口径）。 */
export function expandVars(value, ctx) {
  return String(value).replace(VAR_RE, (_, name) => (name in ctx ? String(ctx[name]) : ''))
}

export function expandSpec(spec, ctx) {
  const out = { ...spec, env: { ...spec.env } }
  if (Array.isArray(out.cmd)) out.cmd = out.cmd.map((a) => expandVars(a, ctx))
  for (const key of ['url', 'cwd', 'logFile']) {
    if (typeof out[key] === 'string') out[key] = expandVars(out[key], ctx)
  }
  for (const [k, v] of Object.entries(out.env)) out.env[k] = expandVars(v, ctx)
  return out
}

/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */

export class ServiceEngine {
  /**
   * @param {{
   *   discoveryPath?: string,   // discovery 注册表落点，缺省 ~/.dsh/services.json
   *   logDir?: string,          // 预留：服务日志落点，缺省 <discovery 目录>/logs
   *   log?: (msg: string) => void,
   *   defaultWaitMs?: number,
   * }} options
   */
  constructor(options = {}) {
    // discovery 是用户级事实表：固定 ~/.dsh/services.json（DSH_DISCOVERY_FILE
    // 可覆盖）。不随 DSH_HOME 走——broker 可能由网关拉起（无 DSH_HOME），
    // 而 dsh 内的消费者（侧栏等）带着自己的 DSH_HOME，两边必须指向同一张表。
    const discoveryPath = options.discoveryPath
      || process.env.DSH_DISCOVERY_FILE
      || path.join(os.homedir(), '.dsh', 'services.json')
    this.discoveryPath = discoveryPath
    this.logDir = options.logDir || path.join(path.dirname(discoveryPath), 'logs')
    this.log = options.log || ((msg) => console.log(`[service-broker] ${msg}`))
    this.defaultWaitMs = options.defaultWaitMs ?? 20000
    this._guardTimer = null
    this._guardFailures = new Map()   // id → 连续重启次数
    this._lastSpecs = new Map()       // id → 最近一次 up 的原始 spec（守护重启用）
    this._upLocks = new Map()         // id → 启动互斥尾（同 id 并发 up 排队）
    this._regLock = null              // 注册表读-改-写互斥尾
    this._stopping = false
    this._owned = new Map() // per-engine authority, never restored from discovery
    // broker 自身的创建身份在本进程生命周期内不变；Windows 上 marker() 约 900ms，
    // 每次 up 重算会白烧近 1 秒。null 时不缓存（瞬时查询失败可重试）。
    this._brokerMarker = null
  }

  /* ---------- discovery / 状态 ---------- */

  /** 注册表读-改-写互斥：并发的 adopt/stop/守护标记在同一把进程内锁里排队，
   *  保证后写者基于前写者的结果（否则并发拉起会互相覆盖丢行）。 */
  _locked(fn) {
    const run = (this._regLock = this._regLock || Promise.resolve()).then(fn, fn)
    this._regLock = run.then(() => {}, () => {})
    return run
  }

  async _loadRegistry() {
    const reg = await loadDiscovery(this.discoveryPath)
    return reg?.services && typeof reg.services === 'object' ? reg.services : {}
  }

  async _saveRegistry(services) {
    await saveDiscovery(this.discoveryPath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      services,
    })
  }

  async list() {
    const services = await this._loadRegistry()
    return Object.values(services).map((row) => ({
      ...row,
      running: row.state === 'running' && pidAlive(row.pid),
    }))
  }

  async statusOf(id) {
    const row = (await this._loadRegistry())[id]
    return row ? { ...row, running: row.state === 'running' && pidAlive(row.pid) } : null
  }

  async doctor(id) {
    const row = await this.statusOf(id)
    if (!row) return { id, state: 'unknown', issues: ['discovery 无此服务记录'] }
    const issues = []
    if (!pidAlive(row.pid)) issues.push(`pid ${row.pid ?? '-'} 不存活`)
    const health = row.url ? await healthzPid(this._healthUrl(row)) : null
    if (health === null) issues.push('健康端点无响应')
    return { ...row, issues, healthy: issues.length === 0 }
  }

  /** 健康端点完整地址（discovery 行带自己当初的 healthPath）。 */
  _healthUrl(row) {
    return row.url + (row.healthPath || '/healthz')
  }

  /* ---------- 端口与占位符 ---------- */

  async _resolvePorts(spec) {
    const ports = {}
    const declared = spec.ports && typeof spec.ports === 'object' ? spec.ports : {}
    const names = Object.keys(declared)
    if (!names.includes('main')) names.push('main')
    for (const name of names) {
      const want = declared[name]
      if (want === 'auto' || want === undefined || want === null || want === '') {
        ports[name] = await allocatePort()
        continue
      }
      const num = Number(want)
      if (!Number.isInteger(num) || num <= 0) throw new Error(`service ${spec.id}: 端口 ${name}=${want} 非法`)
      ports[name] = num
    }
    return ports
  }

  _placeholderCtx(ports) {
    const ctx = {}
    for (const [name, port] of Object.entries(ports || {})) {
      ctx[name === 'main' ? 'PORT' : `PORT_${name.toUpperCase()}`] = String(port)
    }
    return ctx
  }

  _urlFor(spec, ports) {
    const main = ports.main
    if (!main) throw new Error(`service ${spec.id}: 缺少主端口`)
    return spec.url
      ? expandVars(spec.url, this._placeholderCtx(ports)).replace(/\/$/, '')
      : `http://127.0.0.1:${main}`
  }

  /* ---------- 拉起 / 复用 ---------- */

  /** 同一服务的并发 up 必须排队：首个执行拉起，其余落到复用路径。
   *  否则竞态下会各自分配端口各自 spawn，制造出 N 个"同名服务"。
   *  锁表按 id 保留（服务数量有限，不做清理）。 */
  up(rawSpec, { waitMs } = {}) {
    const id = rawSpec && rawSpec.id
    const prev = this._upLocks.get(id) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => this._upOnce(rawSpec, { waitMs }))
    this._upLocks.set(id, run.catch(() => {}))
    return run
  }

  async _upOnce(rawSpec, { waitMs } = {}) {
    const spec = normalizeSpec(rawSpec)
    const id = spec.id
    const wait = waitMs ?? this.defaultWaitMs
    const deadline = Date.now() + wait

    // A previous broker's unresolved spawn cannot be made safe by a healthy
    // endpoint. Only this engine's own verified process may bypass the receipt.
    const prev = (await this._loadRegistry())[id]
    if (existsSync(receiptPath(this.discoveryPath, id))) {
      let existing
      try { existing = JSON.parse(readFileSync(receiptPath(this.discoveryPath, id), 'utf8')) } catch {}
      const owned = this._owned.get(id)
      const local = existing?.state === 'spawned' && existing.brokerPid === process.pid && existing.pid === owned?.pid && existing.identity === owned?.identity && owned?.identity && processIdentity(owned.pid) === owned.identity
      const liveOwner = existing?.id === id && existing.state === 'spawned' && existing.brokerMarker && marker(existing.brokerPid) === existing.brokerMarker && prev?.state === 'running' && prev.ownership === 'owned' && prev.pid === existing.pid && existing.identity && processIdentity(existing.pid) === existing.identity
      if (!local && !liveOwner) {
        // A dead root whose declared ports are all free left nothing of this
        // service behind; keeping the receipt would block the product forever.
        if (await receiptResolvable(existing, prev?.ports)) removeReceipt(this.discoveryPath, id)
        else throw new Error(`service ${id}: 存在未解决的归属记录，拒绝启动或收编`)
      }
    }

    // 1) 复用优先：discovery 有存活记录且健康端点有响应 → 收编，不重启
    if (prev?.url && prev.state === 'running') {
      const pid = await healthzPid(this._healthUrl(prev))
      if (pid !== null) {
        this._guardFailures.delete(id)
        this.log(`✓ ${id} 复用已运行实例 ${prev.url}（pid ${pid > 0 ? pid : '未知'}）`)
        this._lastSpecs.set(id, spec)
        return this._adopt(id, spec, prev.url, pid, prev.ports, true)
      }
    }

    // 2) 按声明解析端口 → 展开占位符 → 校验 → spawn
    const ports = await this._resolvePorts(spec)
    const ctx = { ...process.env, ...spec.env, ...this._placeholderCtx(ports) }
    const expanded = expandSpec(spec, ctx)
    if (!Array.isArray(expanded.cmd) || !expanded.cmd.length) {
      throw new Error(`service ${id}: 缺少 cmd，无法拉起`)
    }
    const exe = expanded.cmd[0]
    // 绝对路径不存在 → 诚实报错（${VAR} 展开失败最常见的样子）；
    // 裸命令名（node/npx…）交给 PATH 解析，spawn 失败会在下面捕获。
    if (/^([a-z]:\\|\/)/i.test(exe) && !existsSync(exe)) {
      throw new Error(`service ${id}: cmd 可执行文件不存在: ${exe}`)
    }
    const url = this._urlFor(expanded, ports)
    const healthUrl = url + (expanded.healthPath || '/healthz')

    // 目标端口已被占但非本服务（健康端点无响应）→ 不抢，诚实失败
    if (await canConnect(ports.main)) {
      const pid = await healthzPid(healthUrl)
      if (pid === null) throw new Error(`service ${id}: 端口 ${ports.main} 已被其他进程占用`)
      // 健康但 discovery 无记录（比如 broker 换了 discovery 文件）→ 收编
      this.log(`✓ ${id} 端口上发现健康实例，收编 ${url}`)
      this._lastSpecs.set(id, spec)
      return this._adopt(id, spec, url, pid, ports, true)
    }

    // Never overwrite an unresolved receipt, including a crash in the spawn window.
    if (existsSync(receiptPath(this.discoveryPath, id))) throw new Error(`service ${id}: 存在未解决的归属记录，拒绝启动`)
    const brokerMarker = this._brokerMarker ?? (this._brokerMarker = marker(process.pid))
    if (!brokerMarker) throw new Error(`service ${id}: 无法验证 broker 身份，拒绝启动`)
    const receipt = { id, brokerPid: process.pid, brokerMarker, ports, state: 'pending' }
    writeReceipt(this.discoveryPath, id, receipt)
    const logFile = expanded.logFile || path.join(this.logDir, `service-${id}.log`)
    this.log(`⏏ 拉起 ${id}: ${expanded.cmd.join(' ')}（日志 ${logFile}）`)
    let child
    try {
      child = spawn(expanded.cmd[0], expanded.cmd.slice(1), {
        cwd: expanded.cwd || undefined,
        env: ctx,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (err) {
      removeReceipt(this.discoveryPath, id)
      throw new Error(`service ${id}: spawn 失败: ${err.message}`)
    }
    // Wait for the definitive spawn outcome before interpreting a missing PID.
    // An asynchronous ENOENT has created no process and cannot leave descendants.
    const spawnError = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null))
      child.once('error', resolve)
    })
    // Retain an error listener after startup as ChildProcess may emit later errors.
    child.on('error', () => {})
    if (spawnError) {
      if (!child.pid) removeReceipt(this.discoveryPath, id)
      throw new Error(`service ${id}: spawn 失败: ${spawnError.message}`)
    }
    child.unref()
    const childIdentity = await markerAsync(child.pid)
    if (child.pid && childIdentity) writeReceipt(this.discoveryPath, id, { ...receipt, state: 'spawned', pid: child.pid, identity: childIdentity })
    else if (!child.pid) removeReceipt(this.discoveryPath, id)

    // 超时/早退时回收刚拉起的进程树——执行器不生产孤儿
    const reapChild = () => {
      if (!childIdentity || processIdentity(child.pid) !== childIdentity) return false
      if (IS_WIN) {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return result.status === 0
      }
      try { process.kill(child.pid, 'SIGTERM'); return true } catch { return false }
    }

    // 3) 等健康
    while (Date.now() < deadline) {
      if (!pidAlive(child.pid)) {
        /* 子进程退出 ≠ 服务失败：两种真实形态都要收编——
         *   a) allowReuse 服务发现端口上已有健康实例 → 直接返回并退出（relay reused 路径）；
         *   b) 子进程派生/守护了真正的服务进程后自己退出（detached 孙进程还在启动）。
         * 给一个短宽限窗持续探测健康端点，健康即收编，而不是把日志留成 error。
         * （2026-11-02 稳定性测试实测；宽限窗上限 3s，避免病态服务拖长失败时间） */
        const graceDeadline = Date.now() + Math.min(3000, Math.max(0, deadline - Date.now()))
        for (;;) {
          const adopted = await healthzPid(healthUrl)
          if (adopted !== null) {
            this._guardFailures.delete(id)
            this.log(`✓ ${id} 子进程退出但端口上已有健康实例，收编 ${url}`)
            this._lastSpecs.set(id, spec)
            // Adopted as borrowed: no receipt, because this engine never gains
            // authority to stop the healthy instance it did not spawn.
            removeReceipt(this.discoveryPath, id)
            return this._adopt(id, spec, url, adopted, ports, true)
          }
          if (Date.now() >= graceDeadline) break
          await new Promise((r) => setTimeout(r, 200))
        }
        // An exited wrapper may have left a daemon behind. Keep the receipt
        // only while one of its declared ports is still occupied.
        if (!(await receiptResolvable({ ...receipt, pid: child.pid, identity: childIdentity }, ports))) removeReceipt(this.discoveryPath, id)
        else writeReceipt(this.discoveryPath, id, { ...receipt, state: 'unverified' })
        throw new Error(`service ${id}: 进程在健康检查通过前退出（pid ${child.pid}，日志 ${logFile}）`)
      }
      const pid = await healthzPid(healthUrl)
      if (pid !== null) {
        this._guardFailures.delete(id)
        this.log(`✓ ${id} 就绪 ${url}（pid ${pid > 0 ? pid : '未知'}）`)
        this._lastSpecs.set(id, spec)
        const owned = pid === child.pid && childIdentity && processIdentity(child.pid) === childIdentity
        return this._adopt(id, spec, url, pid, ports, !owned, child.pid, owned ? childIdentity : null)
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    /* 超时前最后一探：若健康端点已可用（服务慢启动/自治子进程），收编不杀。 */
    const latePid = await healthzPid(healthUrl)
    if (latePid !== null) {
      this._guardFailures.delete(id)
      this.log(`✓ ${id} 超时窗口后已就绪，收编 ${url}`)
      this._lastSpecs.set(id, spec)
      // Borrowed adoption: the healthy endpoint was not proven to be our child.
      removeReceipt(this.discoveryPath, id)
      return this._adopt(id, spec, url, latePid, ports, true)
    }
    const reaped = reapChild()
    // Sending a signal, or even observing the root exit, does not verify its
    // descendants. Retain the original receipt and identity across restarts.
    throw new Error(`service ${id}: ${Math.round(wait / 1000)}s 内未通过健康检查（${healthUrl}，日志 ${logFile}）；${reaped ? '已发送停止请求，但子进程清理未验证' : '未能安全回收启动进程'}`)
  }

  async _adopt(id, spec, url, healthPid, ports, reused, spawnPid, identity = null) {
    const pid = healthPid && healthPid > 0 ? healthPid : (spawnPid ?? null)
    const previous = this._owned.get(id)
    // A wrapper/daemon or an unrelated endpoint cannot transfer authority.
    // Borrowed adoptions must not leave a receipt behind: otherwise every
    // later stop would report an ownership record it can never resolve.
    if (reused && spawnPid && existsSync(receiptPath(this.discoveryPath, id))) {
      removeReceipt(this.discoveryPath, id)
    }
    const ownedIdentity = identity || (previous?.pid === pid && processIdentity(pid) === previous.identity ? previous.identity : null)
    if (ownedIdentity) this._owned.set(id, { pid, identity: ownedIdentity })
    else this._owned.delete(id)
    const row = {
      id,
      state: 'running',
      url,
      healthPath: spec.healthPath || '/healthz',
      pid,
      ports,
      specHash: specHash(spec),
      keepAlive: !!spec.keepAlive,
      reused: ownedIdentity ? false : !!reused,
      ownership: ownedIdentity ? 'owned' : 'borrowed',
      startedAt: new Date().toISOString(),
    }
    return this._locked(async () => {
      const services = await this._loadRegistry()
      // A health response is not proof of ownership. In particular, another
      // engine reusing this endpoint must not erase the owning engine's record.
      if (!ownedIdentity && services[id]?.ownership === 'owned' && services[id]?.state === 'running') {
        return { ...row, running: true }
      }
      services[id] = row
      await this._saveRegistry(services)
      return { ...row, reused: !!reused, running: true }
    })
  }

  /* ---------- 停止 / 守护 ---------- */

  stop(id, _options = {}) {
    const prev = this._upLocks.get(id) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => this._stopOnce(id))
    this._upLocks.set(id, run.catch(() => {}))
    return run
  }

  async _stopOnce(id) {
    const row = (await this._loadRegistry())[id]
    if (!row) return { id, state: 'unknown', stopped: false }
    if (row.state === 'stopped') return { id, state: 'stopped', stopped: true }
    const owned = this._owned.get(id)
    if (!owned || owned.pid !== row.pid) {
      return { id, state: row.state, stopped: false, reason: 'borrowed' }
    }
    const { pid, identity } = owned
    if (!pidAlive(pid)) {
      // Root already gone. Only clear the record when nothing listens on the
      // declared ports; otherwise a detached descendant may still own them.
      if (!(await waitReceiptResolvable({ pid, ports: row.ports }, row.ports))) {
        throw new Error(`service ${id}: 根进程已退出且声明端口仍被占用，拒绝清除归属记录`)
      }
    } else {
      if (!identity || processIdentity(pid) !== identity) {
        throw new Error(`service ${id}: 进程身份无法验证或已变化，拒绝停止`)
      }
      if (IS_WIN) {
        const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
        if (result.status !== 0 && pidAlive(pid)) throw new Error(`service ${id}: taskkill 失败: ${result.error?.message || result.stderr || result.status}`)
      } else {
        try { process.kill(pid, 'SIGTERM') } catch (err) {
          if (err.code !== 'ESRCH') throw new Error(`service ${id}: 停止失败: ${err.message}`)
        }
      }
      for (let i = 0; i < 50 && pidAlive(pid) && processIdentity(pid) === identity; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (pidAlive(pid) && processIdentity(pid) === identity) throw new Error(`service ${id}: 停止超时，进程仍存活`)
      if (pidAlive(pid) && !processIdentity(pid)) throw new Error(`service ${id}: 无法确认进程是否退出`)
    }
    await this._locked(async () => {
      const services = await this._loadRegistry()
      if (!services[id] || services[id].pid !== pid || services[id].startedAt !== row.startedAt) {
        throw new Error(`service ${id}: 停止期间记录已变更`)
      }
      services[id] = { ...services[id], state: 'stopped', pid: null, stoppedAt: new Date().toISOString() }
      await this._saveRegistry(services)
    })
    if (absent(pid)) removeReceipt(this.discoveryPath, id)
    this._owned.delete(id)
    this.log(`■ ${id} 已停止（pid ${pid}）`)
    return { id, state: 'stopped', stopped: true }
  }

  /** 记录各服务最近一次 up 的原始 spec，供守护按原样重启。 */
  rememberSpec(spec) {
    this._lastSpecs.set(spec.id, normalizeSpec(spec))
  }

  /** keepAlive 守护：周期巡检，进程死亡按原规格原端口重启（限连续次数）。 */
  startGuard({ intervalMs = 5000, maxConsecutive = 3 } = {}) {
    if (this._guardTimer) return
    this._guardTimer = setInterval(() => {
      if (this._stopping || this._sweeping) return
      this._sweeping = true
      this._sweepOnce(maxConsecutive).finally(() => { this._sweeping = false })
    }, intervalMs)
    this._guardTimer.unref?.()
  }

  async _markError(row, message) {
    await this._locked(async () => {
      const cur = await this._loadRegistry()
      const current = cur[row.id]
      if (!current || current.state !== 'running' || current.pid !== row.pid || current.startedAt !== row.startedAt) return
      cur[row.id] = { ...current, state: 'error', error: message }
      await this._saveRegistry(cur)
    })
    this.log(`✗ ${row.id} ${message}`)
  }

  async _sweepOnce(maxConsecutive) {
    try {
      const services = await this._loadRegistry()
      for (const row of Object.values(services)) {
        if (!row.keepAlive || row.state !== 'running' || !this._owned.has(row.id)) continue
        if (pidAlive(row.pid)) {
          this._guardFailures.delete(row.id)
          continue
        }
        // Root death alone is not proof its descendants are gone. Serialize the
        // decision with up/stop, then require the declared ports to be free
        // before dropping the receipt or starting a replacement.
        const prev = this._upLocks.get(row.id) || Promise.resolve()
        const transition = prev.catch(() => {}).then(async () => {
          if (this._stopping) return
          const owned = this._owned.get(row.id)
          if (!owned || owned.pid !== row.pid || !absent(owned.pid)) return
          if (!(await waitReceiptResolvable({ pid: owned.pid, ports: row.ports }, row.ports))) {
            await this._markError(row, '进程已退出但声明端口仍被占用，拒绝自动重启')
            return
          }
          removeReceipt(this.discoveryPath, row.id)
          this._owned.delete(row.id)
          const failures = this._guardFailures.get(row.id) || 0
          const spec = this._lastSpecs.get(row.id)
          if (!spec) { await this._markError(row, '缺少重启规格，拒绝自动重启'); return }
          if (failures >= maxConsecutive) { await this._markError(row, '连续重启次数超限，停止自动重启'); return }
          this._guardFailures.set(row.id, failures + 1)
          try {
            await this._upOnce(spec, {})
            this.log(`↻ ${row.id} 已自动重启`)
          } catch (err) {
            await this._markError(row, `自动重启失败: ${err.message}`)
          }
        })
        this._upLocks.set(row.id, transition.catch(() => {}))
        await transition
      }
    } catch { /* 巡检一轮失败不致命，下轮再来 */ }
  }

  async shutdown({ stopAll = false } = {}) {
    this._stopping = true
    if (this._guardTimer) { clearInterval(this._guardTimer); this._guardTimer = null }
    if (!stopAll) return { ok: true, services: [], errors: [] }
    const services = await this._loadRegistry()
    const results = [], errors = []
    for (const row of Object.values(services)) {
      if (row.state === 'running') {
        try {
          const result = await this.stop(row.id)
          results.push(result)
          if (!result.stopped) errors.push({ id: row.id, error: result.reason || 'not stopped' })
        } catch (err) {
          errors.push({ id: row.id, error: err.message })
          this.log(`✗ 停止 ${row.id} 失败: ${err.message}`)
        }
      }
    }
    return { ok: errors.length === 0, services: results, errors }
  }

  /* ---------- 结构化命令投递 ---------- */

  /**
   * commands: [{op:'up', service:{...spec}} | {op:'stop', id}]
   * up 按 requires 闭包拓扑排序；已健康的服务幂等跳过。
   */
  async apply(commands, { waitMs } = {}) {
    if (!Array.isArray(commands)) throw new Error('apply: commands 必须是数组')
    const bad = commands.filter((c) => !c || !['up', 'stop'].includes(c.op))
    if (bad.length) throw new Error(`apply: 未知命令 op: ${bad.map((c) => c?.op).join(', ')}`)

    const byId = new Map()
    for (const c of commands) {
      if (c.op !== 'up') continue
      const spec = normalizeSpec(c.service)
      byId.set(spec.id, spec)
    }

    // 拓扑排序（requires 闭包；指向本批之外的服务视为已由别处管理，跳过）
    const ordered = []
    const visiting = new Set()
    const done = new Set()
    const visit = (id, chain = []) => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new Error(`apply: requires 成环: ${[...chain, id].join(' → ')}`)
      const spec = byId.get(id)
      if (!spec) return
      visiting.add(id)
      for (const dep of spec.requires || []) visit(dep, [...chain, id])
      visiting.delete(id)
      done.add(id)
      ordered.push(spec)
    }
    for (const id of byId.keys()) visit(id)

    const results = []
    const errors = []
    for (const spec of ordered) {
      this.rememberSpec(spec)
      try {
        results.push(await this.up(spec, { waitMs }))
      } catch (err) {
        errors.push({ id: spec.id, error: err.message })
      }
    }
    for (const cmd of commands.filter((c) => c.op === 'stop')) {
      try {
        const result = await this.stop(cmd.id)
        results.push(result)
        if (!result.stopped) errors.push({ id: cmd.id, error: result.reason || 'unknown service' })
      } catch (err) {
        errors.push({ id: cmd.id, error: err.message })
      }
    }
    return { ok: errors.length === 0, services: results, errors }
  }
}

/**
 * 运行态：discovery 是服务运行事实的唯一落点（broker 写、其他只读）。
 * launcher 的 state.json 是「谁拉起了 broker/dsh」的另一张表，两者分开呈现。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { brokerList, resolveBrokerToken, resolveBrokerUrl } from './broker.mjs'

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export async function loadDiscovery(file) {
  if (!file) return { file: '', exists: false, data: null, error: null }
  if (!existsSync(file)) return { file, exists: false, data: null, error: null }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层必须是对象')
    if (raw.services != null && (typeof raw.services !== 'object' || Array.isArray(raw.services))) {
      throw new Error('services 必须是对象（id -> 运行行）')
    }
    return { file, exists: true, data: raw, error: null }
  } catch (error) {
    return { file, exists: true, data: null, error: error.message }
  }
}

/**
 * discovery 路径优先级：
 * --discovery > LAUNCHPAD_DISCOVERY > DSH_DISCOVERY_FILE > launcher state > stateDir/services.json
 * > DSH_HOME/services.json > ~/.dsh/services.json
 */
export function resolveDiscoveryPath(options = {}) {
  const env = options.env || process.env
  const candidates = []
  const seen = new Set()
  const add = (file, source) => {
    if (!file) return
    const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(options.cwd || process.cwd(), file)
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ file: abs, source, exists: existsSync(abs) })
  }

  if (options.flag) {
    add(options.flag, 'flag')
    return { ...candidates[0], candidates }
  }
  add(env.LAUNCHPAD_DISCOVERY, 'env:LAUNCHPAD_DISCOVERY')
  add(env.DSH_DISCOVERY_FILE, 'env:DSH_DISCOVERY_FILE')

  for (const launcher of options.launchers || []) {
    const entry = launcher?.launcher
    if (!entry) continue
    if (entry.state?.discovery) add(entry.state.discovery, 'launcher-state')
    if (entry.resolved?.stateDir) add(path.join(entry.resolved.stateDir, 'services.json'), 'launcher-state-dir')
  }

  const dshHome = options.dshHome || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  add(path.join(dshHome, 'services.json'), 'dsh-home')
  add(path.join(os.homedir(), '.dsh', 'services.json'), 'default')

  const hit = candidates.find((candidate) => candidate.exists)
  return { ...(hit || candidates[candidates.length - 1] || { file: '', source: 'none', exists: false }), candidates }
}

export async function refreshLauncherState(manifest) {
  const entry = manifest?.launcher
  if (!entry) return manifest
  if (!entry.stateFile || !existsSync(entry.stateFile)) {
    return { ...manifest, launcher: { ...entry, runtime: null } }
  }
  try {
    const state = JSON.parse(await readFile(entry.stateFile, 'utf8'))
    const runtime = {
      broker: state?.broker
        ? { ...state.broker, pidAlive: pidAlive(state.broker.pid) }
        : null,
      dsh: state?.dsh
        ? { ...state.dsh, pidAlive: pidAlive(state.dsh.pid) }
        : null,
      supervisor: state?.supervisor
        ? { ...state.supervisor, pidAlive: pidAlive(state.supervisor.pid) }
        : null,
    }
    return { ...manifest, launcher: { ...entry, state, stateError: null, runtime } }
  } catch (error) {
    return { ...manifest, launcher: { ...entry, stateError: error.message, runtime: null } }
  }
}

export async function probeHealth(url, healthPath = '/healthz', timeoutMs = 1200) {
  if (!url || String(url).includes('${')) {
    return { ok: false, skipped: true, error: '没有可探测的地址' }
  }
  const base = String(url).replace(/\/+$/, '')
  const suffix = String(healthPath || '/healthz').startsWith('/') ? healthPath : `/${healthPath}`
  const target = base + suffix
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(target, { signal: controller.signal, headers: { accept: 'application/json' } })
    const text = await res.text()
    let body = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
    }
    return { ok: res.ok, status: res.status, url: target, body }
  } catch (error) {
    return {
      ok: false,
      url: target,
      error: error.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : error.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function mapLimit(items, limit, fn) {
  const list = Array.from(items || [])
  const results = new Array(list.length)
  let next = 0
  async function worker() {
    while (true) {
      const index = next++
      if (index >= list.length) return
      results[index] = await fn(list[index], index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker)
  await Promise.all(workers)
  return results
}

/**
 * @param {object} inventory - analyze() 的返回值
 * @param {object} options - { probe, discovery, brokerUrl, brokerToken, env, cwd }
 */
export async function buildStatus(inventory, options = {}) {
  const launchers = await Promise.all((inventory.launchers || []).map(refreshLauncherState))
  const discoveryPath = resolveDiscoveryPath({
    flag: options.discovery,
    env: options.env,
    cwd: options.cwd,
    dshHome: inventory.dshHome,
    launchers,
  })
  const discovery = await loadDiscovery(discoveryPath.file)
  const discoveryRows = discovery.data?.services && typeof discovery.data.services === 'object'
    ? discovery.data.services
    : {}

  const brokerUrl = resolveBrokerUrl({
    flag: options.brokerUrl,
    env: options.env,
    launchers,
  })
  const brokerToken = resolveBrokerToken({
    flag: options.brokerToken,
    env: options.env,
  })
  const broker = {
    url: brokerUrl,
    reachable: false,
    error: null,
    services: [],
  }
  if (brokerUrl) {
    try {
      const list = await brokerList({
        url: brokerUrl,
        token: brokerToken,
        timeoutMs: options.brokerTimeoutMs || 3000,
      })
      broker.reachable = true
      broker.services = list.services
    } catch (error) {
      broker.error = error.message
    }
  }

  const services = (inventory.services || []).map((service) => {
    const row = discoveryRows[service.serviceId]
    const declaredState = typeof row?.state === 'string' ? row.state : 'unknown'
    const pid = Number.isInteger(row?.pid) && row.pid > 0 ? row.pid : null
    const alive = pid == null ? null : pidAlive(pid)
    let state = declaredState
    if (declaredState === 'running' && pid != null && alive === false) state = 'stale'
    if (declaredState === 'running' && pid == null) state = 'running' // discovery 明确 running，但没有 pid（老记录）
    const url = row?.url || service.spec?.url || ''
    return {
      recordId: service.id,
      serviceId: service.serviceId,
      manifestId: service.manifestId,
      manifestRelativePath: service.manifestRelativePath,
      state,
      declaredState,
      running: state === 'running',
      pid,
      pidAlive: alive,
      url,
      healthPath: row?.healthPath || service.spec?.healthPath || '/healthz',
      ports: row?.ports || service.ports || {},
      keepAlive: row?.keepAlive ?? service.spec?.keepAlive ?? true,
      reused: row?.reused,
      startedAt: row?.startedAt,
      stoppedAt: row?.stoppedAt,
      healthy: null,
      health: null,
    }
  })

  if (options.probe) {
    await mapLimit(services, 8, async (service) => {
      if (!service.running) return
      const result = await probeHealth(service.url, service.healthPath, options.probeTimeoutMs || 1200)
      service.healthy = result.ok
      service.health = result
    })
  }

  const counts = { running: 0, stopped: 0, error: 0, stale: 0, unknown: 0 }
  for (const service of services) {
    if (counts[service.state] === undefined) counts.unknown += 1
    else counts[service.state] += 1
  }

  return {
    generatedAt: new Date().toISOString(),
    discovery: {
      file: discoveryPath.file,
      source: discoveryPath.source,
      exists: discovery.exists,
      updatedAt: discovery.data?.updatedAt || null,
      error: discovery.error,
      candidates: discoveryPath.candidates,
    },
    launchers: launchers.map((manifest) => ({
      id: manifest.id,
      title: manifest.title,
      path: manifest.path,
      relativePath: manifest.relativePath,
      activeManifestId: manifest.launcher?.activeManifestId || null,
      resolved: manifest.launcher?.resolved || null,
      stateFile: manifest.launcher?.stateFile || '',
      stateError: manifest.launcher?.stateError || null,
      runtime: manifest.launcher?.runtime || null,
    })),
    broker: {
      url: broker.url,
      reachable: broker.reachable,
      error: broker.error,
      serviceCount: broker.services.length,
      services: broker.services,
    },
    services,
    summary: {
      services: services.length,
      probe: !!options.probe,
      brokerReachable: broker.reachable,
      ...counts,
    },
  }
}

/**
 * 体检：roots / discovery / broker / launcher / 清单错误。
 * required=false 的项（broker）失败不改变 overall ok，但会在结果里如实标注。
 */
export async function buildDoctor(inventory, options = {}) {
  const status = await buildStatus(inventory, options)
  const checks = []

  for (const root of inventory.roots || []) {
    checks.push({
      name: `root ${root}`,
      required: true,
      ok: existsSync(root),
      detail: existsSync(root) ? '可访问' : '不存在',
    })
  }

  checks.push({
    name: 'discovery',
    required: true,
    ok: status.discovery.exists && !status.discovery.error,
    detail: status.discovery.error
      ? `解析失败: ${status.discovery.error}`
      : status.discovery.exists
        ? `${status.discovery.file}（${status.discovery.source}）`
        : `未找到: ${status.discovery.file}`,
  })

  checks.push({
    name: 'broker 控制端点',
    required: false,
    ok: status.broker.reachable,
    detail: !status.broker.url
      ? '未配置（启停不可用；可设 --broker-url / DSH_BROKER_URL）'
      : status.broker.reachable
        ? `${status.broker.url}（${status.broker.serviceCount} 个服务）`
        : `${status.broker.url} 不可达: ${status.broker.error}`,
  })

  for (const launcher of status.launchers) {
    const runtime = launcher.runtime
    if (!runtime) {
      checks.push({
        name: `launcher ${launcher.title}`,
        required: false,
        ok: false,
        detail: launcher.stateError ? `state 解析失败: ${launcher.stateError}` : '没有运行态 state.json',
      })
      continue
    }
    checks.push({
      name: `launcher ${launcher.title} broker`,
      required: false,
      ok: !!runtime.broker?.pidAlive,
      detail: runtime.broker ? `pid=${runtime.broker.pid} alive=${runtime.broker.pidAlive}` : 'state 无 broker 段',
    })
    checks.push({
      name: `launcher ${launcher.title} dsh`,
      required: false,
      ok: !!runtime.dsh?.pidAlive,
      detail: runtime.dsh ? `pid=${runtime.dsh.pid} alive=${runtime.dsh.pidAlive}` : 'state 无 dsh 段',
    })
  }

  checks.push({
    name: '清单错误',
    required: true,
    ok: inventory.summary.errors === 0,
    detail: `${inventory.summary.errors} errors / ${inventory.summary.warnings} warnings`,
  })

  const requiredChecks = checks.filter((check) => check.required)
  return {
    ok: requiredChecks.every((check) => check.ok),
    actionsAvailable: status.broker.reachable,
    checks,
    summary: {
      required: requiredChecks.length,
      failedRequired: requiredChecks.filter((check) => !check.ok).length,
      failedOptional: checks.filter((check) => !check.required && !check.ok).length,
    },
    status,
  }
}

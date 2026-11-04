/**
 * Launchpad 管理器：DSL 文件的 CRUD + 状态 + 通过 dshd 执行。
 *
 * 边界：本模块是**控制面**，不直接 spawn 服务。启动/停止一律调用
 * tools/dsh-launcher/bin/dshd.mjs（它再经 broker 编排）；这样不复制中间件逻辑。
 */
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { PACKAGE_DIR, findRepoRoot } from './scan.mjs'
import { pidAlive } from './status.mjs'
import { lintStackPaths, replacePluginsBlock, validateDsl } from './dsl.mjs'

const FILE_RE = /\.(stack|dsh)$/i
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

function launchpadError(code, message, status = 400, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.extra = extra
  return error
}

function canonical(value) {
  const abs = path.resolve(value)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function isInside(dir, file) {
  const base = canonical(dir)
  const target = canonical(file)
  return target === base || target.startsWith(`${base}${path.sep}`)
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

async function httpStatus(url, timeoutMs = 2000) {
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.text()
    return res.status
  } catch {
    return null
  }
}

export function runProcess(command, args, { cwd, env, timeoutMs = 60000, killOnTimeout = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (killOnTimeout) {
        try { child.kill() } catch { /* 已退出 */ }
      }
      finish({ code: null, timedOut: true, stdout, stderr })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => finish({ code, timedOut: false, stdout, stderr }))
  })
}

export function createLaunchpadManager(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || findRepoRoot(PACKAGE_DIR) || process.cwd())
  const launchpadsDir = path.resolve(
    options.launchpadsDir
    || options.launchpads
    || process.env.DSH_LAUNCHPAD_DIR
    || path.join(repoRoot, 'launchpads'),
  )
  const dshdPath = options.dshd
    || options.dshdPath
    || process.env.DSH_LAUNCHPAD_DSHD
    || path.join(repoRoot, 'tools', 'dsh-launcher', 'bin', 'dshd.mjs')
  const dshd = dshdPath ? path.resolve(dshdPath) : ''
  const rawHostState = options.hostStateDir
    || (process.env.DSH_DISCOVERY_FILE ? path.dirname(process.env.DSH_DISCOVERY_FILE) : '')
  const hostStateDir = rawHostState ? path.resolve(rawHostState) : ''
  const ctx = { repoRoot, launchpadsDir, dshd, hostStateDir }
  let catalogCache = { at: 0, list: [] }

  function requireDshd() {
    if (!dshd || !existsSync(dshd)) {
      throw launchpadError(
        'DSHD_NOT_FOUND',
        `找不到 dshd 执行器: ${dshd || '(未配置)'}。设置 --dshd 或 DSH_LAUNCHPAD_DSHD 指向 tools/dsh-launcher/bin/dshd.mjs`,
        503,
      )
    }
    return dshd
  }

  async function runDshd(args, { timeoutMs = 60000, killOnTimeout = true } = {}) {
    const bin = requireDshd()
    const result = await runProcess(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      timeoutMs,
      killOnTimeout,
      env: process.env,
    })
    if (result.timedOut) {
      throw launchpadError('DSHD_TIMEOUT', `dshd ${args.join(' ')} 超时（${timeoutMs}ms）`, 504, result)
    }
    if (result.code !== 0) {
      throw launchpadError('DSHD_FAILED', `dshd ${args.join(' ')} 失败（${result.code}）`, 502, result)
    }
    return result
  }

  function fileFor(id, { create = false } = {}) {
    const key = String(id || '').trim()
    if (!ID_RE.test(key)) throw launchpadError('INVALID_ID', `launchpad id 非法: ${JSON.stringify(id)}`, 400)
    const candidates = [path.join(launchpadsDir, `${key}.stack`), path.join(launchpadsDir, `${key}.dsh`)]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        if (!isInside(launchpadsDir, candidate)) {
          throw launchpadError('INVALID_ID', 'launchpad 路径越界', 400)
        }
        return candidate
      }
    }
    if (!create) throw launchpadError('LAUNCHPAD_NOT_FOUND', `launchpad 不存在: ${key}`, 404)
    return candidates[0]
  }

  function generatedFor(id, stack) {
    return path.join(stack.stateDir, '.launchpad', `${id}.json`)
  }

  function isHost(stack) {
    if (!hostStateDir || !stack?.stateDir) return false
    return canonical(stack.stateDir) === canonical(hostStateDir)
  }

  function bundleName(bundle) {
    if (typeof bundle === 'string') return bundle
    return bundle && typeof bundle.name === 'string' ? bundle.name : ''
  }

  function readProfileState(stack) {
    const file = path.join(stack.home, 'profiles', stack.profile, 'package.json')
    if (!existsSync(file)) {
      return { exists: false, file, bundles: [], dependencies: {}, missing: [], extra: [] }
    }
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      const bundles = Array.isArray(pkg.dsh?.profile?.bundles)
        ? pkg.dsh.profile.bundles.filter((item) => typeof item === 'string')
        : []
      const desired = (stack.plugins?.bundles || []).map(bundleName).filter(Boolean)
      return {
        exists: true,
        file,
        bundles,
        dependencies: pkg.dependencies || {},
        missing: desired.filter((name) => !bundles.includes(name)),
        extra: bundles.filter((name) => !desired.includes(name)),
      }
    } catch (error) {
      return { exists: true, file, bundles: [], dependencies: {}, missing: [], extra: [], error: error.message }
    }
  }

  function scanCatalog() {
    // 只扫 roots 下真实存在的插件目录；不再假设仓库里一定有某个固定布局。
    const roots = [path.join(repoRoot, 'extensions')].filter((dir) => existsSync(dir))
    const skip = new Set(['node_modules', 'archives', 'bundles', 'dist', 'release', 'data', 'logs', '.git', 'bench', '__pycache__', 'test', 'fixtures'])
    const found = new Map()
    function walk(dir, depth) {
      if (depth > 6) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      const pkgFile = path.join(dir, 'package.json')
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
          const patch = pkg.dsh?.bundle?.patch
          const patches = Array.isArray(patch) ? patch : patch ? [patch] : []
          if (pkg.name && patches.length && !found.has(pkg.name)) {
            const valid = patches.every((rel) => existsSync(path.join(dir, rel)))
            if (valid) {
              found.set(pkg.name, {
                name: pkg.name,
                version: pkg.version || '',
                title: pkg.meta?.title || pkg.name,
                description: pkg.meta?.description || pkg.description || '',
                category: pkg.dsh?.category || '',
                path: dir,
                requiresDshPluginKit: !!pkg.dependencies?.['@capyclaw/plugin-kit'],
              })
            }
          }
        } catch { /* 坏 package.json 跳过 */ }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (skip.has(entry.name)) continue
        walk(path.join(dir, entry.name), depth + 1)
      }
    }
    for (const root of roots) if (existsSync(root)) walk(root, 0)
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  function catalog({ force = false } = {}) {
    const now = Date.now()
    if (!force && now - catalogCache.at < 10000) return catalogCache.list
    const list = scanCatalog()
    catalogCache = { at: now, list }
    return list
  }

  function normalizeBundles(bundles) {
    if (!Array.isArray(bundles)) throw launchpadError('INVALID_BODY', 'bundles 必须是数组', 400)
    const out = []
    const seen = new Set()
    for (const raw of bundles) {
      let entry
      let name
      if (typeof raw === 'string') {
        name = raw.trim()
        entry = name
      } else if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
        name = raw.name.trim()
        if (raw.path) {
          const resolved = path.isAbsolute(raw.path) ? path.normalize(raw.path) : path.resolve(launchpadsDir, raw.path)
          entry = { name, path: resolved }
        } else if (raw.version) {
          entry = { name, version: String(raw.version) }
        } else {
          entry = name
        }
      } else {
        throw launchpadError('INVALID_BODY', 'bundles 项必须是 string 或 {name,path|version}', 400)
      }
      if (!name) throw launchpadError('INVALID_BODY', 'bundle 缺少名称', 400)
      if (seen.has(name)) throw launchpadError('DUPLICATE_BUNDLE', `bundle 重复: ${name}`, 400)
      seen.add(name)
      out.push(entry)
    }
    return out
  }

  function stackSlug(value) {
    return String(value || '').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'stack'
  }

  /** domain 型：状态在 runtime.json（dshd/domain runtime 契约），不是 state.json。 */
  async function statusOfDomainStack(stack) {
    const stateDir = stack.stateDir
    const storeRoot = stack.domain?.storeRoot || path.join(stateDir, 'store')
    const runtimeId = stack.domain?.runtimeId || `rt-stack-${stackSlug(stack.name)}`
    const runtimeFile = path.join(storeRoot, 'runtimes', runtimeId, 'runtime.json')
    if (!existsSync(runtimeFile)) {
      return { state: 'stopped', kind: 'domain', stateDir, stateFile: runtimeFile, runtimeId, dsh: null, broker: null, services: [] }
    }
    let runtime
    try {
      runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    } catch (error) {
      return { state: 'error', kind: 'domain', stateDir, stateFile: runtimeFile, runtimeId, error: error.message, dsh: null, broker: null, services: [] }
    }
    const dshPid = runtime.pids?.proxy
    const dshUrl = runtime.ports?.harness ? `http://127.0.0.1:${runtime.ports.harness}/` : ''
    const dshHttp = dshUrl ? await httpStatus(dshUrl, 2000) : null
    const dshAlive = pidAlive(dshPid)
    const brokerPort = runtime.services?.brokerPort || runtime.ports?.broker
    const brokerPid = runtime.pids?.broker
    const brokerUrl = brokerPort ? `http://127.0.0.1:${brokerPort}` : ''
    const brokerHttp = brokerUrl ? await httpStatus(`${brokerUrl}/healthz`, 1500) : null
    const running = dshAlive && dshHttp !== null
    const state = running ? 'running' : ((dshAlive || dshHttp !== null) ? 'degraded' : 'stopped')

    let services = []
    const discoveryFile = runtime.services?.discovery || path.join(stateDir, 'services.json')
    if (existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8'))
        services = Object.values(discovery.services || {}).map((row) => ({
          id: row.id,
          state: row.state,
          pid: row.pid ?? null,
          pidAlive: pidAlive(row.pid),
          url: row.url || '',
          ports: row.ports || {},
        }))
      } catch { /* 损坏 discovery 不影响 launchpad 状态 */ }
    }
    for (const id of runtime.services?.ids || []) {
      if (services.some((row) => row.id === id)) continue
      services.push({
        id, state: 'missing', pid: null, pidAlive: false,
        url: '', ports: runtime.ports?.services?.[id] ? { main: runtime.ports.services[id] } : {},
      })
    }
    return {
      state, kind: 'domain', stateDir, stateFile: runtimeFile, runtimeId,
      dsh: { pid: dshPid ?? null, pidAlive: dshAlive, url: dshUrl, httpStatus: dshHttp },
      broker: { pid: brokerPid ?? null, pidAlive: pidAlive(brokerPid), url: brokerUrl, httpStatus: brokerHttp },
      services,
      updatedAt: runtime.updatedAt || null,
    }
  }

  async function statusOfStack(stack) {
    if (stack.kind === 'domain' || stack.domain) return statusOfDomainStack(stack)
    const stateDir = stack.stateDir
    const stateFile = path.join(stateDir, 'state.json')
    if (!existsSync(stateFile)) {
      return { state: 'stopped', stateDir, stateFile, dsh: null, broker: null, services: [] }
    }
    let state
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch (error) {
      return { state: 'error', stateDir, stateFile, error: error.message, dsh: null, broker: null, services: [] }
    }
    const dshPid = state.dsh?.pid
    const dshUrl = state.dsh?.url || ''
    const dshHttp = dshUrl ? await httpStatus(dshUrl, 2000) : null
    const dshAlive = pidAlive(dshPid)
    const brokerPid = state.broker?.pid
    const brokerUrl = state.broker?.url || ''
    const brokerHttp = brokerUrl ? await httpStatus(`${brokerUrl}/healthz`, 1500) : null
    const running = dshAlive && dshHttp !== null
    const status = running ? 'running' : ((dshAlive || dshHttp !== null) ? 'degraded' : 'stopped')

    let services = []
    const discoveryFile = state.discovery || path.join(stateDir, 'services.json')
    if (existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8'))
        services = Object.values(discovery.services || {}).map((row) => ({
          id: row.id,
          state: row.state,
          pid: row.pid ?? null,
          pidAlive: pidAlive(row.pid),
          url: row.url || '',
          ports: row.ports || {},
        }))
      } catch { /* 损坏 discovery 不影响 launchpad 状态 */ }
    }
    return {
      state: status,
      stateDir,
      stateFile,
      dsh: { pid: dshPid ?? null, pidAlive: dshAlive, url: dshUrl, httpStatus: dshHttp },
      broker: { pid: brokerPid ?? null, pidAlive: pidAlive(brokerPid), url: brokerUrl, httpStatus: brokerHttp },
      services,
      updatedAt: state.updatedAt || null,
    }
  }

  async function readLaunchpad(id, { withText = false } = {}) {
    const file = fileFor(id)
    const text = readFileSync(file, 'utf8')
    const validation = validateDsl(text, file)
    if (!validation.ok) {
      return {
        id,
        file,
        name: validation.doc?.name || path.basename(file),
        kind: validation.kind || 'profile',
        profile: '',
        ports: {},
        services: [],
        state: 'invalid',
        running: false,
        host: false,
        errors: validation.errors,
        warnings: validation.warnings,
        status: { state: 'invalid' },
        ...(withText ? { text, stack: null } : {}),
      }
    }
    const stack = validation.stack
    const warnings = [...validation.warnings, ...lintStackPaths(stack)]
    const status = await statusOfStack(stack)
    const host = isHost(stack)
    const isDomain = stack.kind === 'domain' || !!stack.domain
    const profileState = isDomain
      ? { exists: false, notApplicable: true, file: '', bundles: [], dependencies: {}, missing: [], extra: [] }
      : readProfileState(stack)
    return {
      id,
      file,
      name: stack.name,
      kind: validation.kind || stack.kind || 'profile',
      profile: stack.profile || stack.domain?.profile || '',
      ports: stack.ports || {},
      services: isDomain
        ? (status.services || []).map((service) => service.id)
        : (stack.services || []).map((service) => service.id),
      domain: stack.domain || null,
      state: status.state,
      running: status.state === 'running',
      host,
      errors: [],
      warnings,
      status,
      ...(withText ? { text, stack, profileState } : {}),
    }
  }

  async function list() {
    if (!existsSync(launchpadsDir)) return []
    const files = readdirSync(launchpadsDir)
      .filter((name) => FILE_RE.test(name))
      .sort((a, b) => a.localeCompare(b))
    const out = []
    for (const name of files) {
      const id = name.replace(FILE_RE, '')
      try {
        out.push(await readLaunchpad(id, { withText: false }))
      } catch (error) {
        out.push({
          id,
          file: path.join(launchpadsDir, name),
          name: id,
          kind: 'profile',
          profile: '',
          ports: {},
          services: [],
          state: 'error',
          running: false,
          host: false,
          errors: [{ message: error.message, code: error.code || 'ERROR', line: 0 }],
          warnings: [],
          status: { state: 'error' },
        })
      }
    }
    return out
  }

  function template(name) {
    return `# ${name} — 由 dsh-launchpad 创建
# 可选：kind "profile"（v1）；插件 bundles、独立服务、端口都在这里决定。
stack "${name}" {
  kind "profile"
  home "../.dshd/launchpads/${name}/home"
  profile "web"
  workspace "../apps/harness/deepseek-harness/workspace"
  stateDir "../.dshd/launchpads/${name}/state"

  ports {
    broker "auto"
    proxy "auto"
    upstream "auto"
  }

  plugins {
    bundle "@deepseek-ai/dsh-base"
    bundle "@deepseek-ai/dsh-web-app"
    # plugin "dsh-launchpad" { path "../extensions/official/dsh-launchpad" }
    # dependency "@capyclaw/plugin-kit" { path "../packages/@capyclaw/plugin-kit" }
  }

  # service "example" {
  #   path "../path/to/server.mjs"
  #   args ["--port", "\${PORT}"]
  #   port 39700
  #   health "/healthz"
  #   keepAlive true
  # }
}
`
  }

  async function create(name) {
    const raw = String(name || '').trim()
    if (!raw) throw launchpadError('INVALID_NAME', 'name 必填', 400)
    const id = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id || !ID_RE.test(id)) throw launchpadError('INVALID_NAME', `无法生成合法 id: ${name}`, 400)
    const file = fileFor(id, { create: true })
    if (existsSync(file) || existsSync(path.join(launchpadsDir, `${id}.dsh`))) {
      throw launchpadError('LAUNCHPAD_EXISTS', `launchpad 已存在: ${id}`, 409)
    }
    mkdirSync(launchpadsDir, { recursive: true })
    writeAtomic(file, template(id))
    return readLaunchpad(id, { withText: true })
  }

  async function get(id) {
    return readLaunchpad(id, { withText: true })
  }

  async function save(id, text) {
    if (typeof text !== 'string') throw launchpadError('INVALID_BODY', 'text 必须是字符串', 400)
    const file = fileFor(id)
    writeAtomic(file, text)
    return readLaunchpad(id, { withText: true })
  }

  async function validate(id) {
    const file = fileFor(id)
    const text = readFileSync(file, 'utf8')
    const result = validateDsl(text, file)
    return {
      ok: result.ok,
      id,
      file,
      kind: result.kind || 'profile',
      errors: result.errors,
      warnings: result.ok ? [...result.warnings, ...lintStackPaths(result.stack)] : result.warnings,
      stack: result.stack,
    }
  }

  /** 插件面板：只改 DSL 的 plugins 块，保留 dependencies/overrides/install。 */
  async function savePlugins(id, bundles) {
    const lp = await readLaunchpad(id, { withText: true })
    if (!lp.stack) {
      throw launchpadError('LAUNCHPAD_INVALID', `launchpad ${id} 有 DSL 错误，先修复`, 400, { errors: lp.errors })
    }
    const normalized = normalizeBundles(bundles)
    const current = lp.stack.plugins || {}
    const dependencies = { ...(current.dependencies || {}) }
    for (const entry of normalized) {
      if (typeof entry === 'string' || !entry.path) continue
      const pkgFile = path.join(entry.path, 'package.json')
      if (!existsSync(pkgFile)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
        if (pkg.dependencies?.['@capyclaw/plugin-kit'] && !dependencies['@capyclaw/plugin-kit']) {
          dependencies['@capyclaw/plugin-kit'] = path.join(repoRoot, 'packages', 'capyclaw-plugin-kit')
        }
      } catch { /* 坏插件包由 plan 阶段报 */ }
    }
    const text = replacePluginsBlock(lp.text, {
      bundles: normalized,
      dependencies,
      overrides: current.overrides || {},
      install: current.install,
    })
    const parsed = validateDsl(text, lp.file)
    if (!parsed.ok) {
      throw launchpadError('LAUNCHPAD_INVALID', `插件写回后 DSL 校验失败: ${parsed.errors[0]?.message || ''}`, 400, { errors: parsed.errors })
    }
    writeAtomic(lp.file, text)
    return readLaunchpad(id, { withText: true })
  }

  async function writeGenerated(id, stack) {
    const file = generatedFor(id, stack)
    writeAtomic(file, `${JSON.stringify(stack, null, 2)}\n`)
    return file
  }

  async function plan(id) {
    const lp = await readLaunchpad(id, { withText: true })
    if (!lp.stack) {
      throw launchpadError('LAUNCHPAD_INVALID', `launchpad ${id} 有 DSL 错误，先修复`, 400, { errors: lp.errors })
    }
    const generated = await writeGenerated(id, lp.stack)
    const result = await runProcess(process.execPath, [requireDshd(), 'stack', 'plan', '--stack', generated, '--json'], {
      cwd: repoRoot,
      timeoutMs: 60000,
      env: process.env,
    })
    if (result.timedOut) throw launchpadError('DSHD_TIMEOUT', 'dshd stack plan 超时', 504, result)
    let parsed
    try {
      parsed = JSON.parse(result.stdout.trim())
    } catch {
      throw launchpadError('DSHD_BAD_OUTPUT', `dshd stack plan 输出不是 JSON（code ${result.code}）`, 502, result)
    }
    return {
      ok: parsed.valid !== false && result.code === 0,
      id,
      generated,
      plan: parsed,
      dshd: { code: result.code, stderr: result.stderr },
      launchpad: lp,
    }
  }

  async function start(id) {
    const lp = await readLaunchpad(id, { withText: true })
    if (!lp.stack) {
      throw launchpadError('LAUNCHPAD_INVALID', `launchpad ${id} 有 DSL 错误，先修复`, 400, { errors: lp.errors })
    }
    if (lp.stack.home) mkdirSync(lp.stack.home, { recursive: true })
    if (lp.stack.workspace) mkdirSync(lp.stack.workspace, { recursive: true })
    if (lp.stack.stateDir) mkdirSync(lp.stack.stateDir, { recursive: true })
    const generated = await writeGenerated(id, lp.stack)
    // A timed-out start may hold the product fence and lifecycle lock. Let it
    // finish and release both rather than killing it in the critical section.
    const result = await runDshd(['start', '--stack', generated], { timeoutMs: 180000, killOnTimeout: false })
    const status = await statusOfStack(lp.stack)
    return {
      ok: status.state === 'running',
      id,
      generated,
      dshd: { code: result.code, stdout: result.stdout, stderr: result.stderr },
      status,
    }
  }

  async function stop(id) {
    const lp = await readLaunchpad(id, { withText: true })
    if (!lp.stack) {
      throw launchpadError('LAUNCHPAD_INVALID', `launchpad ${id} 有 DSL 错误，先修复`, 400, { errors: lp.errors })
    }
    if (lp.host) {
      throw launchpadError('LAUNCHPAD_HOST', '这是当前 launchpad 服务所在的栈，停止会中断本页面；请用 dshd stop --stack 从外部停止', 409)
    }
    if (lp.status?.state === 'stopped') {
      return { ok: true, id, alreadyStopped: true, status: lp.status }
    }
    const generated = generatedFor(id, lp.stack)
    const stackFile = existsSync(generated) ? generated : await writeGenerated(id, lp.stack)
    const result = await runDshd(['stop', '--stack', stackFile], { timeoutMs: 60000, killOnTimeout: false })
    const status = await statusOfStack(lp.stack)
    return {
      ok: status.state === 'stopped',
      id,
      alreadyStopped: false,
      dshd: { code: result.code, stdout: result.stdout, stderr: result.stderr },
      status,
    }
  }

  async function remove(id) {
    const lp = await readLaunchpad(id, { withText: false })
    if (lp.host) throw launchpadError('LAUNCHPAD_HOST', '当前 launchpad 服务所在的栈不能删除', 409)
    if (lp.running || lp.status?.state === 'degraded') {
      throw launchpadError('LAUNCHPAD_RUNNING', 'launchpad 正在运行，先停止再删除', 409)
    }
    const file = fileFor(id)
    unlinkSync(file)
    return { ok: true, id, file }
  }

  async function status(id) {
    const lp = await readLaunchpad(id, { withText: false })
    return { ok: true, id, host: lp.host, launchpad: lp, status: lp.status }
  }

  return {
    ctx,
    launchpadsDir,
    dshd,
    repoRoot,
    list,
    get,
    create,
    save,
    validate,
    savePlugins,
    catalog,
    plan,
    start,
    stop,
    remove,
    status,
  }
}

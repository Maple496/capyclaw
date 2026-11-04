/**
 * DSH Runtime Lease：一台机器上的每个 DSH 进程 = 一个 runtime。
 *
 * 每个 runtime 拥有：
 *   - 独立的 harness / dsh / content 端口
 *   - 独立的 DSH_HOME、profile、workspace、日志、临时目录
 *   - 独立的 Content Store namespace token
 *   - 独立的 auth-proxy 锁文件
 *
 * 所有落盘文件都在同一个 DSH_STORE_ROOT 下：
 *   <root>/runtimes/<runtimeId>/...        runtime 私有文件
 *   <root>/objects/...                     内容对象（sha256 命名）
 *   <root>/works/<runtimeId>/<workId>/...  作品 manifest
 *   <root>/catalog/works.json              中间层可读目录
 *
 * 隔离级别是 L1（逻辑隔离）；driver 预留 jobobject / docker / wsl。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { processIdentity, processAlive, verifiedKill } from './process-identity.mjs'
import { resolveHarnessDir } from 'dsh-harness-paths'
import { marker as recoveryMarker, absent as processAbsent, recoverServices, remainingReceipts } from '../../dsh-service-broker/lib/recovery.mjs'
import { fileURLToPath } from 'node:url'
import { WorkspaceManager } from './workspace.mjs'
import { withAsyncFileLock, withFileLock } from '../../dsh-runtime-kit/src/util/fs-lock.mjs'
import { installDomain, resolveDomain } from './domain.mjs'
import { majorCompatible } from './compose.mjs'
import { tuning } from './tuning.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BROKER_DIR = path.resolve(HERE, '../../dsh-service-broker')
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RUNTIME_FILE = 'runtime.json'

export function defaultRuntimeStoreRoot() {
  return process.env.DSH_STORE_ROOT || path.join(os.homedir(), '.dsh-store')
}

export function runtimeRootOf(storeRoot = defaultRuntimeStoreRoot()) {
  return path.join(path.resolve(storeRoot), 'runtimes')
}

export function runtimeDirOf(storeRoot, runtimeId) {
  assertRuntimeId(runtimeId)
  return path.join(runtimeRootOf(storeRoot), runtimeId)
}

export function runtimeFileOf(storeRoot, runtimeId) {
  return path.join(runtimeDirOf(storeRoot, runtimeId), RUNTIME_FILE)
}

export function assertRuntimeId(runtimeId) {
  if (!ID_RE.test(String(runtimeId || ''))) throw new Error(`runtimeId 非法: ${runtimeId}`)
  return runtimeId
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  try { fs.renameSync(tmp, file) } catch {
    try { fs.rmSync(file, { force: true }) } catch { /* 忽略 */ }
    fs.renameSync(tmp, file)
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function normalizePreferred(value, fallback) {
  const defaultRange = tuning().portScanRange
  if (value == null) return { preferred: fallback, range: defaultRange }
  if (typeof value === 'number') return { preferred: value, range: defaultRange }
  if (typeof value === 'object') {
    return {
      preferred: Number(value.preferred ?? value.port ?? fallback) || 0,
      range: Number(value.range) || defaultRange,
    }
  }
  return { preferred: fallback, range: defaultRange }
}

function registryFile(storeRoot) {
  return path.join(path.resolve(storeRoot), 'registry.json')
}

function registryLock(storeRoot) {
  return path.join(path.resolve(storeRoot), 'locks', 'registry.lock')
}

export function readRegistry(storeRoot = defaultRuntimeStoreRoot()) {
  return readJson(registryFile(storeRoot), {
    schemaVersion: 1,
    updatedAt: '',
    ports: {},
    runtimes: {},
  })
}

function writeRegistry(storeRoot, registry) {
  registry.updatedAt = new Date().toISOString()
  writeJson(registryFile(storeRoot), registry)
}

function reservePorts(storeRoot, runtimeId, ports) {
  withFileLock(registryLock(storeRoot), () => {
    const registry = readRegistry(storeRoot)
    for (const [name, port] of ports) {
      const owner = registry.ports[String(port)]
      if (owner != null && owner !== runtimeId) {
        throw new Error(`runtime 端口 ${name}=${port} 已被 runtime ${owner} 预留，启动中止`)
      }
    }
    for (const [, port] of ports) registry.ports[String(port)] = runtimeId
    registry.runtimes[runtimeId] ||= {}
    registry.runtimes[runtimeId].createdAt ||= new Date().toISOString()
    writeRegistry(storeRoot, registry)
  })
}

export function releaseRuntimePorts(storeRoot, runtimeId) {
  withFileLock(registryLock(storeRoot), () => {
    const registry = readRegistry(storeRoot)
    for (const [port, owner] of Object.entries(registry.ports || {})) {
      if (owner === runtimeId) delete registry.ports[port]
    }
    if (registry.runtimes?.[runtimeId]) registry.runtimes[runtimeId].status = 'stopped'
    writeRegistry(storeRoot, registry)
  })
}

export async function allocateRuntimePorts({ storeRoot, runtimeId, preferences = {}, range = tuning().portScanRange } = {}) {
  return withAsyncFileLock(path.join(path.resolve(storeRoot), 'locks', 'allocator.lock'), async () => {
    while (true) {
      const registry = readRegistry(storeRoot)
      const reserved = new Set(Object.keys(registry.ports || {}).map(Number))
      const result = {}
      const used = new Set()
      const names = Object.keys(preferences).length
        ? Object.keys(preferences)
        : ['harness', 'dsh', 'content']

      for (const name of names) {
        const pref = normalizePreferred(preferences[name], name === 'content' ? 39311 : name === 'harness' ? 3080 : 0)
        let chosen = null
        for (let attempt = 0; attempt <= (pref.range || range); attempt++) {
          const candidate = pref.preferred > 0 ? pref.preferred + attempt : 0
          if (candidate > 65535) break
          if (candidate === 0) {
            const port = await freePort()
            if (!reserved.has(port) && !used.has(port)) { chosen = port; break }
            continue
          }
          if (reserved.has(candidate) || used.has(candidate)) continue
          if (!(await canBind(candidate))) continue
          chosen = candidate
          break
        }
        if (!chosen) throw new Error(`无法为 ${name} 分配到可用端口（首选 ${pref.preferred}）`)
        result[name] = chosen
        used.add(chosen)
      }
      const committed = withFileLock(registryLock(storeRoot), () => {
        const current = readRegistry(storeRoot)
        if (Object.values(result).some((port) => Object.hasOwn(current.ports, String(port)))) return false
        for (const port of Object.values(result)) current.ports[String(port)] = runtimeId
        current.runtimes[runtimeId] ||= { createdAt: new Date().toISOString() }
        current.runtimes[runtimeId].updatedAt = new Date().toISOString()
        writeRegistry(storeRoot, current)
        return true
      })
      if (committed) return result
    }
  })
}

export function safeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function getPath(source, key) {
  return String(key).split('.').reduce((value, part) => (value == null ? value : value[part]), source)
}

function renderTemplate(value, context) {
  if (typeof value === 'string') {
    const exact = /^\$\{(ports|paths)\.([A-Za-z0-9._-]+)\}$/.exec(value)
    if (exact) {
      const source = exact[1] === 'ports' ? context.ports : context.paths
      const found = getPath(source, exact[2])
      return found != null ? found : ''
    }
    return value.replace(/\$\{(ports|paths)\.([A-Za-z0-9._-]+)\}/g, (_, group, key) => {
      const source = group === 'ports' ? context.ports : context.paths
      const found = getPath(source, key)
      return found != null ? String(found) : ''
    }).replace(/\$\{workId\}/g, context.workId || 'main')
      .replace(/\$\{runtimeId\}/g, context.runtimeId || '')
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, context))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplate(item, context)]))
  }
  return value
}

function firstSuitePort(resolved) {
  for (const pkg of resolved.composed.packages || []) {
    for (const port of pkg.entry?.provides?.ports || []) {
      if (Number.isInteger(port)) return port
    }
  }
  return 39311
}

function matchesPattern(pattern, value) {
  if (!pattern || pattern === '*' || pattern === '**') return true
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return value === pattern
}

/**
 * 启动声明校验：domain 声明“我需要哪些工具/能力/服务”，
 * 中间层在分配端口/创建 runtime 之前先确认 suite 组合真的提供。
 */
export function checkRuntimeRequirements(resolved, requirements = {}) {
  const errors = []
  const packages = resolved.composed.packages || []
  const tools = packages.flatMap((pkg) => pkg.entry?.provides?.tools || [])
  const services = packages.flatMap((pkg) => pkg.entry?.provides?.services || [])
  const capabilities = new Map((resolved.composed.capabilities || []).map((item) => [item.capability, item]))
  for (const tool of requirements.tools || []) {
    if (!tools.some((provided) => matchesPattern(tool, provided) || matchesPattern(provided, tool))) errors.push(`缺少工具能力: ${tool}`)
  }
  for (const service of requirements.services || []) {
    if (!services.includes(service)) errors.push(`缺少服务: ${service}`)
  }
  for (const raw of requirements.capabilities || []) {
    const [name, range] = String(raw).split('@')
    const provider = capabilities.get(name)
    if (!provider) errors.push(`缺少能力: ${raw}`)
    else if (range && !majorCompatible(provider.version, range)) errors.push(`能力版本不兼容: ${raw}（提供者 ${provider.version}）`)
  }
  if (errors.length) throw new Error(`runtime 启动声明不满足:\n- ${errors.join('\n- ')}`)
  return { ok: true, tools, services, capabilities: [...capabilities.keys()] }
}

// dsh 宿主目录解析的唯一实现在 dsh-harness-paths（此前三处副本靠注释同步，已实际漂移）。
function defaultHarnessDir() {
  return resolveHarnessDir({ repoRoot: path.resolve(HERE, '..', '..', '..') })
}

function runtimePaths(storeRoot, runtimeId) {
  const root = runtimeDirOf(storeRoot, runtimeId)
  return {
    root,
    dshHome: path.join(root, '.dsh'),
    workspaceRoot: path.join(root, 'workspace'),
    workspace: path.join(root, 'workspace', 'deepseek-harness', 'default-workspace'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
    contentState: path.join(root, 'content'),
    sessions: path.join(root, '.dsh', 'sessions'),
    storages: path.join(root, '.dsh', 'storages'),
    lockFile: path.join(root, '.auth-proxy.lock'),
    runtimeFile: path.join(root, RUNTIME_FILE),
  }
}

function replaceLocalPort(url, port) {
  if (typeof url !== 'string') return url
  return url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost):\d+/, `$1$2:${port}`)
}

/**
 * 生成 profile 最后一层的 row overrides。
 * - runtime.bindings：按 row/package 注入端口、目录、workId 等模板值
 * - 未绑定但含本地 URL 的 row：把 URL 端口替换成 urlPort（默认 content）
 * - domain 自己的 rowOverrides 仍然优先保留
 */
export function buildRuntimeRowOverrides(resolved, runtime) {
  const domain = resolved.manifest
  const overrides = JSON.parse(JSON.stringify(domain.rowOverrides || {}))
  const runtimeConfig = domain.runtime || {}
  const bindings = Array.isArray(runtimeConfig.bindings) ? runtimeConfig.bindings : []
  const context = {
    runtimeId: runtime.runtimeId,
    workId: runtime.workId || 'main',
    ports: runtime.ports,
    paths: runtime.paths,
  }
  const urlPortName = runtimeConfig.urlPort || 'content'
  const urlPort = runtime.ports?.[urlPortName] || runtime.ports?.content

  for (const row of resolved.composed.rows || []) {
    const base = { ...(overrides[row.id] || {}) }
    const binding = bindings.find((item) => (item.row && item.row === row.id) || (item.package && item.package === row.name))
    const config = { ...(base.config || row.config || {}) }
    let changed = false

    if (binding) {
      const bound = renderTemplate(binding.config || {}, context)
      Object.assign(config, bound)
      if (binding.port && config.port == null) config.port = runtime.ports?.[binding.port]
      changed = true
    } else if (config.url && urlPort) {
      const next = replaceLocalPort(config.url, urlPort)
      if (next !== config.url) { config.url = next; changed = true }
    }

    if (changed) overrides[row.id] = { ...base, config }
  }
  return overrides
}
export function resolveRuntimeChecks(resolved, runtime) {
  const urlPort = runtime.ports?.[runtime.urlPort || 'content'] || runtime.ports?.content
  return (resolved.composed.checks || []).map((check) => ({
    ...check,
    url: replaceLocalPort(check.url, urlPort),
  }))
}

function insideRoot(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 解析启动声明里的 storage：
 *   scope.sessions = { path, isolated }   DSH 会话记录目录
 *   scope.files    = [{ id, path, patterns }] 该进程可修改的文件根目录
 * 所有路径必须是 runtime 根目录内的相对路径；中间层负责创建和记录绝对路径。
 */
function resolveRuntimeStorage(paths, scope = {}) {
  const sessionsDecl = scope.sessions && typeof scope.sessions === 'object' ? scope.sessions : {}
  const sessions = sessionsDecl.path
    ? path.resolve(paths.root, sessionsDecl.path)
    : paths.sessions
  if (!insideRoot(paths.root, sessions)) throw new Error(`scope.sessions.path 越出 runtime 根目录: ${sessionsDecl.path}`)
  fs.mkdirSync(sessions, { recursive: true })
  paths.sessions = sessions
  paths.storages = path.join(path.dirname(sessions), 'storages')
  fs.mkdirSync(paths.storages, { recursive: true })

  const declaredFiles = Array.isArray(scope.files) && scope.files.length
    ? scope.files
    : [{ id: 'workspace', path: 'workspace', patterns: ['**'] }]
  const files = declaredFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error(`scope.files[${index}] 必须包含 path`)
    }
    const resolved = path.resolve(paths.root, entry.path)
    if (!insideRoot(paths.root, resolved)) throw new Error(`scope.files[${index}].path 越出 runtime 根目录: ${entry.path}`)
    fs.mkdirSync(resolved, { recursive: true })
    return {
      id: entry.id || `files-${index}`,
      kind: entry.kind || 'files',
      path: resolved,
      declaredPath: entry.path,
      patterns: Array.isArray(entry.patterns) && entry.patterns.length ? entry.patterns : ['**'],
    }
  })
  const workspace = files.find((entry) => entry.kind === 'workspace' || entry.id === 'workspace')
  if (workspace) {
    paths.workspaceRoot = workspace.path
    paths.workspace = path.join(workspace.path, 'deepseek-harness', 'default-workspace')
    fs.mkdirSync(paths.workspace, { recursive: true })
  }
  const content = files.find((entry) => entry.kind === 'content' || entry.id === 'content')
  if (content) paths.contentState = content.path
  return {
    sessions: {
      path: sessions,
      isolated: sessionsDecl.isolated !== false,
      declaredPath: sessionsDecl.path || '.dsh/sessions',
    },
    files,
  }
}

function writeDshRootPatch(paths, model, workspaceController) {
  const lines = ['# 由 dsh-runtime 生成：模型通道 + 独立 workspace', '']
  if (model !== false && model) {
    const m = model === true ? {} : model
    if (!m.id || !m.plugin) throw new Error('runtime.model 必须声明 id 和 plugin')
    lines.push(`- id: ${m.id}`)
    lines.push(`  name: ${JSON.stringify(m.plugin)}`)
    lines.push('  config:')
    if (m.apiKeyEnv) lines.push(`    apiKeyEnv: ${JSON.stringify(m.apiKeyEnv)}`)
    if (m.baseURL) lines.push(`    baseURL: ${JSON.stringify(m.baseURL)}`)
  }
  if (workspaceController !== false) {
    const w = workspaceController === true || !workspaceController ? {} : workspaceController
    lines.push(`- id: ${w.id || 'workspace-controller'}`)
    lines.push(`  name: ${JSON.stringify(w.plugin || '@deepseek-ai/dsh-api-workspace-controller')}`)
    lines.push('  config:')
    lines.push(`    documentsDirectory: ${JSON.stringify(paths.workspaceRoot)}`)
  }
  if (lines.length <= 2) return null
  const file = path.join(paths.dshHome, 'cordis.patch.yml')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/**
 * 收集 suite 声明的服务清单（`<suite>/services.json`，broker spec 形状）。
 *
 * 服务解耦标准：runtime 不直接 spawn 服务，只把端口/目录解析成具体值，
 * 交给中间件（dsh-service-broker）按 spec 拉起。清单里的 `${PACKAGE_DIR}`
 * 在 materializeServiceManifest 里展开成绝对路径。
 */
export function collectSuiteServices(resolved) {
  const out = []
  const seen = new Map()
  for (const suite of resolved.suites || []) {
    const file = path.join(suite.dir, 'services.json')
    if (!fs.existsSync(file)) continue
    let raw
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
      throw new Error(`服务清单解析失败: ${file}: ${error.message}`)
    }
    const services = Array.isArray(raw) ? raw : raw.services
    if (!Array.isArray(services)) throw new Error(`服务清单缺 services 数组: ${file}`)
    for (const spec of services) {
      if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error(`服务清单条目缺 id: ${file}`)
      if (seen.has(spec.id)) throw new Error(`服务 id 冲突: ${spec.id}（${seen.get(spec.id)} 与 ${file}）`)
      seen.set(spec.id, file)
      out.push({ spec, suiteDir: suite.dir, file })
    }
  }
  return out
}

/** 由 composed packages 建立 包名 → 实际目录 映射，用于展开清单里的 node_modules 路径。 */
function packageDirMap(resolved) {
  const map = new Map()
  for (const pkg of resolved.composed.packages || []) {
    const target = pkg.entry?.path ? path.resolve(pkg.dir, pkg.entry.path) : null
    if (target) map.set(pkg.name, target)
  }
  return map
}

/**
 * 把 suite 的服务 spec 物化成 runtime 专属清单：
 *   - `portFrom: "content"` → 主端口 = runtime content 端口（PPT relay 与 MCP/检查同端口）
 *   - `dirFrom: "contentState"` → `--dir` 指向 runtime contentState
 *   - `${PACKAGE_DIR}/node_modules/<pkg>` → 包实际目录（dev 树与安装态都正确）
 *   - 其余 `${PACKAGE_DIR}` → suite 目录
 */
export function materializeServiceManifest({ services, resolved, runtimeRoot, ports, paths }) {
  const pkgDirs = packageDirMap(resolved)
  const rendered = []
  for (const { spec, suiteDir } of services) {
    const clone = JSON.parse(JSON.stringify(spec))
    const mainPort = clone.portFrom === 'content' || clone.portFrom === 'urlPort'
      ? ports.content
      : (ports.services?.[clone.id] ?? clone.ports?.main)
    if (!Number.isInteger(mainPort) || mainPort <= 0) throw new Error(`服务 ${clone.id}: 无法解析主端口`)
    clone.ports = { ...(clone.ports || {}), main: mainPort }
    delete clone.portFrom
    delete clone.dirFrom

    const subst = (value) => {
      if (typeof value !== 'string') return value
      let out = value
      // 长包名优先，避免 dsh-ppt-workbench 误匹配 dsh-ppt-workbench-extra 的前缀
      for (const [name, dir] of [...pkgDirs.entries()].sort((a, b) => b[0].length - a[0].length)) {
        out = out.replaceAll(`${'${PACKAGE_DIR}'}/node_modules/${name}`, dir)
          .replaceAll(`${'${PACKAGE_DIR}'}\\node_modules\\${name}`, dir)
      }
      return out.replaceAll('${PACKAGE_DIR}', suiteDir)
    }
    if (Array.isArray(clone.cmd)) {
      let cmd = clone.cmd.map(subst)
      if (spec.dirFrom === 'contentState') {
        const index = cmd.lastIndexOf('--dir')
        if (index >= 0 && index + 1 < cmd.length) cmd = cmd.map((arg, i) => (i === index + 1 ? paths.contentState : arg))
      }
      clone.cmd = cmd
    }
    for (const key of ['url', 'cwd', 'logFile']) {
      if (typeof clone[key] === 'string') clone[key] = subst(clone[key])
    }
    if (clone.env && typeof clone.env === 'object') {
      clone.env = Object.fromEntries(Object.entries(clone.env).map(([key, value]) => [key, subst(value)]))
    }
    rendered.push(clone)
  }
  const file = path.join(runtimeRoot, 'service-manifest.json')
  fs.writeFileSync(file, JSON.stringify({ services: rendered }, null, 2) + '\n')
  return { file, services: rendered }
}

/** 创建 runtime：分配端口、建立目录、生成 profile、写 runtime.json。 */
export async function createRuntime(options = {}) {
  if (!options.domainInput) throw new Error('createRuntime: domainInput 必填')
  const storeRoot = path.resolve(options.storeRoot || defaultRuntimeStoreRoot())
  const resolved = resolveDomain(options.domainInput)
  const domain = resolved.manifest
  const requirements = options.requires || domain.runtime?.requires || {}
  checkRuntimeRequirements(resolved, requirements)
  const scope = options.scope || domain.runtime?.scope || {}
  const workspaceDeclaration = scope.workspace || domain.runtime?.workspace || null
  const model = options.model !== undefined
    ? options.model
    : (domain.runtime?.model !== undefined ? domain.runtime.model : null)
  const workspaceController = options.workspaceController !== undefined
    ? options.workspaceController
    : (domain.runtime?.workspaceController !== undefined ? domain.runtime.workspaceController : true)
  const workId = options.workId || domain.runtime?.workId || workspaceDeclaration?.workId || 'main'
  const id = options.runtimeId
    || `rt-${safeSlug(options.name || domain.name)}-${crypto.randomBytes(3).toString('hex')}`
  assertRuntimeId(id)
  if (fs.existsSync(runtimeFileOf(storeRoot, id))) throw new Error(`runtime 已存在: ${id}`)

  const profile = options.profile || id
  const harnessPreferred = options.harnessPort != null
    ? options.harnessPort
    : (domain.runtime?.ports?.harness ?? domain.profile?.port ?? 3080)
  const contentPreferred = options.contentPort != null
    ? options.contentPort
    : (domain.runtime?.ports?.content ?? firstSuitePort(resolved))
  const dshPreferred = options.dshPort != null
    ? options.dshPort
    : (domain.runtime?.ports?.dsh ?? (Number(harnessPreferred) || 3080) + 1)
  const suiteServices = collectSuiteServices(resolved)
  const servicePrefs = { ...(domain.runtime?.ports?.services || {}) }
  for (const [id, pref] of Object.entries(options.servicePorts || {})) {
    servicePrefs[id] = pref
  }
  for (const { spec } of suiteServices) {
    if (spec.portFrom === 'content' || spec.portFrom === 'urlPort') continue
    if (servicePrefs[spec.id] !== undefined) continue
    servicePrefs[spec.id] = Number.isInteger(spec.ports?.main) ? spec.ports.main : 0
  }
  const brokerPreferred = options.brokerPort != null ? options.brokerPort : 0
  const preferences = {
    harness: harnessPreferred,
    dsh: dshPreferred,
    content: contentPreferred,
    ...(suiteServices.length || options.brokerPort != null ? { broker: brokerPreferred } : {}),
    ...Object.fromEntries(Object.entries(servicePrefs).map(([name, pref]) => [`services.${name}`, pref])),
  }
  const allocated = await allocateRuntimePorts({
    storeRoot,
    runtimeId: id,
    preferences,
    range: options.portRange || 200,
  })
  const ports = {
    harness: allocated.harness,
    dsh: allocated.dsh,
    content: allocated.content,
    ...(allocated.broker ? { broker: allocated.broker } : {}),
    services: {},
  }
  for (const { spec } of suiteServices) {
    ports.services[spec.id] = spec.portFrom === 'content' || spec.portFrom === 'urlPort'
      ? ports.content
      : allocated[`services.${spec.id}`]
  }
  for (const name of Object.keys(servicePrefs)) {
    if (ports.services[name] == null) ports.services[name] = allocated[`services.${name}`]
  }

  const paths = runtimePaths(storeRoot, id)
  for (const dir of [paths.root, paths.dshHome, paths.workspaceRoot, paths.workspace, paths.logs, paths.tmp, paths.contentState]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const serviceManifest = suiteServices.length
    ? materializeServiceManifest({ services: suiteServices, resolved, runtimeRoot: paths.root, ports, paths })
    : null

  const storage = resolveRuntimeStorage(paths, scope)
  const rootPatch = writeDshRootPatch(paths, model, workspaceController)

  const contentStore = new WorkspaceManager({ storeRoot }).init()
  const namespace = contentStore.namespaces.create(id, {
    ttlSec: options.ttlSec || 0,
    meta: { name: options.name || domain.name, domain: domain.name },
  })
  contentStore.declareWork(id, workId, workspaceDeclaration || { files: ['**'], allowNew: true })

  const runtime = {
    schemaVersion: 1,
    runtimeId: id,
    name: options.name || domain.name,
    domain: domain.name,
    domainInput: path.resolve(options.domainInput),
    profile,
    driver: options.driver || 'node',
    storeRoot,
    store: {
      root: storeRoot,
      namespace: id,
      token: namespace.token,
    },
    workId,
    urlPort: options.urlPort || domain.runtime?.urlPort || 'content',
    bindings: Array.isArray(domain.runtime?.bindings) ? domain.runtime.bindings : [],
    requires: requirements,
    scope,
    storage,
    model,
    workspaceController,
    env: renderTemplate({ ...(domain.runtime?.env || {}), ...(options.env || {}) }, {
      runtimeId: id,
      workId,
      ports,
      paths,
    }),
    rootPatch,
    declaration: contentStore.readManifest(id, workId)?.declaration || null,
    ports,
    services: serviceManifest ? {
      manifest: serviceManifest.file,
      discovery: path.join(paths.root, 'services.json'),
      brokerPort: ports.broker,
      ids: serviceManifest.services.map((service) => service.id),
    } : null,
    paths,
    harnessDir: path.resolve(options.harnessDir || defaultHarnessDir()),
    components: resolved.suites.map((suite) => suite.manifest.name),
    checks: resolveRuntimeChecks(resolved, { ports, urlPort: options.urlPort || domain.runtime?.urlPort || 'content' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'created',
    pids: {},
  }
  runtime.rowOverrides = buildRuntimeRowOverrides(resolved, runtime)
  writeJson(paths.runtimeFile, runtime)

  const install = (() => {
    try {
      return installDomain({
        domainInput: options.domainInput,
        profile,
        dshHome: paths.dshHome,
        runPnpm: options.runPnpm === true,
        rowOverrides: runtime.rowOverrides,
      })
    } catch (error) {
      releaseRuntimePorts(storeRoot, id)
      contentStore.removeRuntime(id)
      fs.rmSync(paths.root, { recursive: true, force: true })
      throw error
    }
  })()
  runtime.install = {
    profileDir: install.dir,
    suites: install.suites,
    components: install.components,
    warnings: install.warnings,
  }
  runtime.status = 'installed'
  writeJson(paths.runtimeFile, runtime)

  withFileLock(registryLock(storeRoot), () => {
    const registry = readRegistry(storeRoot)
    registry.runtimes[id] = {
      runtimeId: id,
      name: runtime.name,
      domain: runtime.domain,
      profile,
      ports,
      storeRoot,
      status: runtime.status,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    }
    writeRegistry(storeRoot, registry)
  })
  return runtime
}

export function readRuntime(storeRoot, runtimeId) {
  const file = runtimeFileOf(storeRoot, runtimeId)
  const runtime = readJson(file, null)
  if (!runtime) throw new Error(`runtime 不存在: ${runtimeId} (${file})`)
  return runtime
}

export function saveRuntime(runtime) {
  runtime.updatedAt = new Date().toISOString()
  writeJson(runtime.paths.runtimeFile, runtime)
  withFileLock(registryLock(runtime.storeRoot), () => {
    const registry = readRegistry(runtime.storeRoot)
    registry.runtimes[runtime.runtimeId] = {
      runtimeId: runtime.runtimeId,
      name: runtime.name,
      domain: runtime.domain,
      profile: runtime.profile,
      ports: runtime.ports,
      storeRoot: runtime.storeRoot,
      status: runtime.status,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    }
    writeRegistry(runtime.storeRoot, registry)
  })
  return runtime
}

export function runtimeRunning(runtime) {
  const identity = runtime?.identities?.proxy
  return !!(identity?.marker && processIdentity(runtime?.pids?.proxy)?.marker === identity.marker)
}

export function listRuntimes(storeRoot = defaultRuntimeStoreRoot()) {
  const root = runtimeRootOf(storeRoot)
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return [] }
  return entries
    .map((entry) => readJson(path.join(root, entry.name, RUNTIME_FILE), null))
    .filter(Boolean)
    .map((runtime) => ({ ...runtime, running: runtimeRunning(runtime) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export async function startRuntime(options = {}) {
  const { storeRoot = defaultRuntimeStoreRoot(), runtimeId } = options
  return withAsyncFileLock(path.join(path.resolve(storeRoot), 'locks', `runtime-${runtimeId}.lock`), () => startRuntimeOnce(options))
}

async function startRuntimeOnce({ storeRoot = defaultRuntimeStoreRoot(), runtimeId, harnessDir, dshBin, detached = true, waitMs = 30000 } = {}) {
  const runtime = readRuntime(storeRoot, runtimeId)
  if (runtime.brokerStartupPending || runtime.proxyStartupPending) throw new Error('存在未清理的启动意图；请先停止 runtime')
  if (runtimeRunning(runtime)) {
    if (runtime.services?.manifest && (!runtime.identities?.broker?.marker || processIdentity(runtime.pids?.broker)?.marker !== runtime.identities.broker.marker)) {
      throw new Error('proxy 仍在运行但 broker 身份不可验证；请先停止 runtime')
    }
    return { runtime, alreadyRunning: true }
  }
  if (runtime.brokerStartupPending || runtime.proxyStartupPending || runtime.pids?.proxy || runtime.pids?.broker || runtime.status === 'stop-incomplete') throw new Error('存在未清理的进程记录；请先停止 runtime')
  const proxy = path.join(harnessDir || runtime.harnessDir || defaultHarnessDir(), 'auth-proxy.mjs')
  if (!fs.existsSync(proxy)) throw new Error(`找不到 auth-proxy: ${proxy}`)
  const allPorts = [
    ['harness', runtime.ports?.harness],
    ['dsh', runtime.ports?.dsh],
    ['content', runtime.ports?.content],
    ...(runtime.ports?.broker ? [['broker', runtime.ports.broker]] : []),
    ...Object.entries(runtime.ports?.services || {}).map(([name, port]) => [`services.${name}`, port]),
  ]
  const seenPorts = new Set()
  const portsToReserve = []
  for (const [name, port] of allPorts) {
    if (!Number.isInteger(port) || port <= 0) continue
    if (seenPorts.has(port)) continue
    seenPorts.add(port)
    if (!(await canBind(port))) throw new Error(`runtime 端口 ${name}=${port} 已被占用，启动中止`)
    portsToReserve.push([name, port])
  }
  reservePorts(storeRoot, runtimeId, portsToReserve)
  const discoveryFile = runtime.services?.discovery || path.join(runtime.paths.root, 'services.json')
  const env = {
    ...process.env,
    DSH_HOME: runtime.paths.dshHome,
    DSH_WORKSPACE: runtime.paths.workspace,
    DSH_PROFILE: runtime.profile,
    DSH_UP_PORT: String(runtime.ports.dsh),
    DSH_PROXY_PORT: String(runtime.ports.harness),
    DSH_LOCK_FILE: runtime.paths.lockFile,
    DSH_RUNTIME_FILE: runtime.paths.runtimeFile,
    DSH_RUNTIME_ID: runtime.runtimeId,
    DSH_RUNTIME_ROOT: runtime.paths.root,
    DSH_STORE_ROOT: runtime.storeRoot,
    DSH_STORE_NAMESPACE: runtime.store.namespace,
    DSH_STORE_TOKEN: runtime.store.token,
    DSH_CONTENT_PORT: String(runtime.ports.content),
    DSH_CONTENT_STATE: runtime.paths.contentState,
    DSH_WORK_ID: runtime.workId || 'main',
    DSH_LOG_DIR: runtime.paths.logs,
    DSH_TMP_DIR: runtime.paths.tmp,
    DSH_SESSION_DIR: runtime.paths.sessions,
    DSH_SESSIONS_DIR: runtime.paths.sessions,
    DSH_STORAGES_DIR: runtime.paths.storages,
    DSH_DISCOVERY_FILE: discoveryFile,
    TMPDIR: runtime.paths.tmp,
    TMP: runtime.paths.tmp,
    TEMP: runtime.paths.tmp,
    DSH_DOMAIN: runtime.domain,
  }
  Object.assign(env, runtime.env || {})
  if (dshBin) env.DSH_BIN = dshBin
  if (runtime.model?.baseURL && runtime.model?.baseUrlEnv) env[runtime.model.baseUrlEnv] = runtime.model.baseURL

  /* 服务中间件：runtime 不直接 spawn 业务服务，只拉起 broker；broker 按清单
   * 拉起/守护/登记；停机显式请求 broker 停止其拥有的服务。 */
  if (runtime.services?.manifest) {
    const brokerEntry = path.join(BROKER_DIR, 'server.mjs')
    if (!fs.existsSync(brokerEntry)) throw new Error(`找不到 dsh-service-broker: ${brokerEntry}`)
    const brokerLog = path.join(runtime.paths.logs, 'broker.log')
    // Persist intent before spawn: a crash can otherwise leave an unrecorded
    // broker or service. An interrupted start is not proof of absence.
    runtime.brokerStartupPending = true
    runtime.status = 'starting'
    saveRuntime(runtime)
    const logFd = fs.openSync(brokerLog, 'a')
    try {
      const brokerChild = spawn(process.execPath, [
        brokerEntry,
        '--port', String(runtime.ports.broker),
        '--manifest', runtime.services.manifest,
        '--discovery', discoveryFile,
      ], {
        cwd: runtime.paths.root,
        env,
        stdio: detached ? ['ignore', logFd, logFd] : 'inherit',
        detached: !!detached,
        windowsHide: true,
      })
      // spawn 失败的真实原因必须可见：只改状态不报原因会重演 "进程创建失败" 式盲排
      brokerChild.on('error', (error) => {
        console.error(`[dsh-suite-kit] broker spawn error: ${error?.code ? error.code + ' ' : ''}${error?.message || error}`)
        runtime.lastSpawnError = String(error?.message || error)
      })
      if (!brokerChild.pid) {
        // spawn failed before a process existed, so no broker or service could
        // have been launched. Persist that fact instead of leaving an intent.
        runtime.brokerStartupPending = false
        runtime.status = 'stopped'
        saveRuntime(runtime)
        throw new Error(`服务中间件进程创建失败（日志 ${brokerLog}）`)
      }
      if (detached) brokerChild.unref()
      runtime.pids = { ...(runtime.pids || {}), broker: brokerChild.pid }
      runtime.identities = { ...(runtime.identities || {}), broker: { ...processIdentity(brokerChild.pid), recoveryMarker: recoveryMarker(brokerChild.pid) } }
      saveRuntime(runtime)
      const deadline = Date.now() + Math.min(waitMs || 10000, 15000)
      let brokerReady = false
      while (Date.now() < deadline) {
        if (!pidAlive(brokerChild.pid)) break
        try {
          const res = await fetch(`http://127.0.0.1:${runtime.ports.broker}/healthz`, { signal: AbortSignal.timeout(1000) })
          const health = await res.json()
          const identity = runtime.identities?.broker
          if (res.ok && health?.service === 'dsh-service-broker' && health.pid === brokerChild.pid && identity?.marker && processIdentity(brokerChild.pid)?.marker === identity.marker) { brokerReady = true; break }
        } catch { /* not ready or not our broker */ }
        await sleep(tuning().readyPollMs)
      }
      if (!brokerReady) {
        await stopRuntimeOnce({ storeRoot, runtimeId })
        throw new Error(`服务中间件未就绪（broker ${runtime.ports.broker}，日志 ${brokerLog}）`)
      }
      const discovery = readJson(discoveryFile)
      const rows = discovery?.services
      if (!rows || typeof rows !== 'object' || Array.isArray(rows) ||
          !(runtime.services.ids || []).every((id) => rows[id]?.state === 'running')) {
        throw new Error('broker 启动清单不完整；保留进程和端口，请检查后停止 runtime')
      }
      runtime.brokerStartupPending = false
      saveRuntime(runtime)
    } finally {
      fs.closeSync(logFd)
    }
  }
  runtime.proxyStartupPending = true
  runtime.status = 'starting'
  saveRuntime(runtime)
  const child = spawn(process.execPath, [proxy], {
    cwd: runtime.paths.workspace,
    env,
    stdio: detached ? 'ignore' : 'inherit',
    detached: !!detached,
    windowsHide: true,
  })
  // 同上：dsh 代理 spawn 失败原因必须落到 runtime 状态，不能静默
  child.on('error', (error) => {
    console.error(`[dsh-suite-kit] proxy spawn error: ${error?.code ? error.code + ' ' : ''}${error?.message || error}`)
    runtime.lastSpawnError = String(error?.message || error)
  })
  runtime.pids = { ...(runtime.pids || {}), proxy: child.pid }
  runtime.identities = { ...(runtime.identities || {}), proxy: processIdentity(child.pid) }
  runtime.proxyStartupPending = !child.pid
  runtime.status = child.pid ? 'running' : 'starting'
  runtime.startedAt = new Date().toISOString()
  saveRuntime(runtime)
  if (detached) child.unref()
  let ready = false
  const httpChecks = (runtime.checks || []).filter((check) => check.type === 'http')
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (!pidAlive(child.pid)) break
      /* harness 就绪不能只看 TCP：proxy 先监听、dsh 还在加载时 TCP 已通，
       * 但 GET / 会挂住（PPT 这类重 domain 尤其明显）。以 HTTP 根路径可响应为准。 */
      const harnessUp = await probeHttp(`http://127.0.0.1:${runtime.ports.harness}/`, 1500)
      const checksUp = httpChecks.length === 0
        || (await Promise.all(httpChecks.map((check) => probeHttp(check.url)))).every(Boolean)
      if (harnessUp && checksUp) {
        ready = true
        break
      }
      await sleep(tuning().readyPollMs)
    }
  }
  runtime.ready = ready
  saveRuntime(runtime)
  return { runtime, pid: child.pid, child, alreadyRunning: false, ready }
}

export async function probeHttp(url, timeoutMs = tuning().probeHttpTimeoutMs) {
  let timer = null
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(tuning().canConnectTimeoutMs, () => { socket.destroy(); resolve(false) })
  })
}

// Discovery rows from older brokers do not establish ownership. Never send an
// unqualified stop request or signal a service PID based only on discovery.
async function serviceStopReport(runtime) {
  const borrowed = []
  const unresolved = []
  const file = runtime.services?.discovery
  if (!file || !fs.existsSync(file)) {
    if (runtime.brokerStartupPending) unresolved.push('broker:startup-interrupted')
    if (runtime.services?.manifest && (runtime.pids?.broker || runtime.brokerStartupPending || runtime.startedAt)) unresolved.push('discovery:missing')
    return { borrowed, unresolved }
  }
  let brokerAbsentBeforeRead = false
  if (runtime.brokerStartupPending && Number.isSafeInteger(runtime.pids?.broker) && runtime.pids.broker > 0) {
    try { process.kill(runtime.pids.broker, 0) } catch (error) { brokerAbsentBeforeRead = error.code === 'ESRCH' }
  }
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    return { borrowed, unresolved: [...unresolved, 'discovery:unreadable'] }
  }
  if (!raw?.services || typeof raw.services !== 'object' || Array.isArray(raw.services)) return { borrowed, unresolved: [...unresolved, 'discovery:unreadable'] }
  if (runtime.brokerStartupPending) {
    // Discovery is published after spawn and may lag a keep-alive restart. Even
    // a complete-looking snapshot cannot prove that no unrecorded service exists.
    // Only an empty service manifest and empty discovery establish that no
    // service was launched, once the recorded broker is confirmed absent.
    const absent = (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false
      try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
    }
    const broker = runtime.pids?.broker
    const ids = runtime.services?.ids
    const manifest = readJson(runtime.services?.manifest, null)
    const noServices = Array.isArray(ids) && ids.length === 0 && Array.isArray(manifest?.services) && manifest.services.length === 0 && Object.keys(raw.services).length === 0
    if (!noServices || !brokerAbsentBeforeRead || !runtime.identities?.broker?.marker || runtime.identities.broker.pid !== broker || !absent(broker)) {
      unresolved.push('broker:startup-interrupted')
    }
  }
  let recovered = new Set()
  if (runtime.identities?.broker?.recoveryMarker && runtime.pids?.broker && processAbsent(runtime.pids.broker)) {
    const identity = runtime.identities?.broker
    const report = await recoverServices(file, identity?.pid === runtime.pids.broker ? identity : null)
    recovered = new Set(report.stopped)
    unresolved.push(...report.unresolved)
  }
  for (const [id, row] of Object.entries(raw.services)) {
    if (recovered.has(id)) continue
    if (row?.reused === true || row?.ownership === 'borrowed' || row?.ownership === 'reused') { borrowed.push(id); continue }
    if (row?.state === 'stopped') continue
    const pid = Number(row?.pid)
    if (!Number.isInteger(pid) || pid <= 0) { unresolved.push(`service:${id}:pid-unverified`); continue }
    if (!processAlive(pid)) continue
    const actual = processIdentity(runtime.pids?.broker)
    const trusted = runtime.identities?.broker?.pid === runtime.pids?.broker && runtime.identities?.broker?.marker && actual?.marker === runtime.identities.broker.marker
    let stopped = false
    if (row.ownership === 'owned' && trusted && runtime.ports?.broker) {
      try {
        const headers = { 'Content-Type': 'application/json' }
        const token = runtime.env?.DSH_BROKER_TOKEN || process.env.DSH_BROKER_TOKEN
        if (token) headers['x-broker-token'] = token
        const res = await fetch(`http://127.0.0.1:${runtime.ports.broker}/control/stop`, {
          method: 'POST', headers, body: JSON.stringify({ id }), signal: AbortSignal.timeout(10000),
        })
        const body = await res.json()
        stopped = res.ok && body?.stopped === true
      } catch { /* preserve state */ }
    }
    if (!stopped) unresolved.push(`service:${id}:ownership-unverified-or-stop-failed`)
  }
  if (runtime.identities?.broker?.recoveryMarker && !processAbsent(runtime.pids?.broker)) unresolved.push(...remainingReceipts(file))
  return { borrowed, unresolved }
}

export async function stopRuntime(options = {}) {
  const { storeRoot = defaultRuntimeStoreRoot(), runtimeId } = options
  return withAsyncFileLock(path.join(path.resolve(storeRoot), 'locks', `runtime-${runtimeId}.lock`), () => stopRuntimeOnce(options))
}

async function stopRuntimeOnce({ storeRoot = defaultRuntimeStoreRoot(), runtimeId } = {}) {
  const runtime = readRuntime(storeRoot, runtimeId)
  const { borrowed, unresolved } = await serviceStopReport(runtime)
  if (runtime.proxyStartupPending) unresolved.push('proxy:startup-interrupted')
  const stopped = []
  for (const name of ['broker', 'proxy']) {
    const pid = runtime.pids?.[name]
    if (!pid) continue
    if (name === 'broker' && unresolved.length) continue
    const identity = runtime.identities?.[name]
    if (identity && identity.pid !== pid) { unresolved.push(`${name}:${pid}:identity-mismatch`); continue }
    const result = verifiedKill(identity || { pid })
    if (!result.ok) { unresolved.push(`${name}:${pid}:${result.reason}`); continue }
    for (let i = 0; i < 30 && processAlive(pid); i++) await sleep(tuning().stopPollMs)
    if (processAlive(pid)) unresolved.push(`${name}:${pid}:still-running`)
    else { stopped.push(name); runtime.pids[name] = null }
  }
  runtime.stopResult = { stopped, borrowed, unresolved }
  runtime.status = unresolved.length ? 'stop-incomplete' : 'stopped'
  if (!unresolved.length) {
    runtime.brokerStartupPending = false
    runtime.stoppedAt = new Date().toISOString()
  }
  saveRuntime(runtime)
  if (unresolved.length) throw new Error(`runtime 停止未完成，状态和端口保留: ${unresolved.join(', ')}`)
  releaseRuntimePorts(storeRoot, runtimeId)
  return runtime
}

export function removeRuntime(options = {}) {
  const { storeRoot = defaultRuntimeStoreRoot(), runtimeId } = options
  return withFileLock(path.join(path.resolve(storeRoot), 'locks', `runtime-${runtimeId}.lock`), () => removeRuntimeOnce(options), { timeoutMs: 0 })
}

function removeRuntimeOnce({ storeRoot = defaultRuntimeStoreRoot(), runtimeId, keepStore = false } = {}) {
  let runtime = null
  try { runtime = readRuntime(storeRoot, runtimeId) } catch (error) {
    if (fs.existsSync(runtimeFileOf(storeRoot, runtimeId))) throw error
  }
  if (runtime) {
    if (runtime.brokerStartupPending || runtime.proxyStartupPending || runtime.status === 'stop-incomplete') throw new Error('runtime 有未解决的启动或停止记录，拒绝删除')
    const discovery = runtime.services?.discovery
    if (runtime.services?.manifest && (runtime.startedAt || runtime.pids?.broker) && (!discovery || !fs.existsSync(discovery))) throw new Error('discovery 缺失，拒绝删除 runtime')
    let rows = {}
    if (discovery && fs.existsSync(discovery)) {
      try {
        rows = JSON.parse(fs.readFileSync(discovery, 'utf8')).services
        if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('invalid')
      } catch { throw new Error('discovery 无法读取，拒绝删除 runtime') }
    }
    const unresolved = Object.entries(rows).filter(([, row]) => {
      if (row?.reused === true || row?.ownership === 'borrowed' || row?.ownership === 'reused' || row?.state === 'stopped') return false
      const pid = Number(row?.pid)
      return !Number.isInteger(pid) || pid <= 0 || processAlive(pid)
    }).map(([id]) => `service:${id}`)
    if (runtime.identities?.broker?.recoveryMarker && discovery) unresolved.push(...remainingReceipts(discovery))
    const live = Object.entries(runtime.pids || {}).filter(([, pid]) => processAlive(pid))
    if (live.length || unresolved.length) throw new Error(`runtime 仍有未解决进程；请先停止: ${[...live.map(([name]) => name), ...unresolved].join(', ')}`)
  }
  releaseRuntimePorts(storeRoot, runtimeId)
  if (!keepStore) {
    const store = new WorkspaceManager({ storeRoot })
    store.removeRuntime(runtimeId)
  }
  fs.rmSync(runtimeDirOf(storeRoot, runtimeId), { recursive: true, force: true })
  withFileLock(registryLock(storeRoot), () => {
    const registry = readRegistry(storeRoot)
    delete registry.runtimes[runtimeId]
    writeRegistry(storeRoot, registry)
  })
  return { runtimeId, removed: true }
}

export async function gcRuntimes({ storeRoot = defaultRuntimeStoreRoot(), ttlSec = 0 } = {}) {
  const runtimes = listRuntimes(storeRoot)
  const removed = []
  for (const runtime of runtimes) {
    if (runtime.running) continue
    const age = Date.now() - Date.parse(runtime.createdAt || 0)
    if (ttlSec > 0 && age > ttlSec * 1000) {
      removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
      removed.push(runtime.runtimeId)
    }
  }
  return { removed, checked: runtimes.length }
}

export async function doctorRuntime({ storeRoot = defaultRuntimeStoreRoot(), runtimeId, timeoutMs = 1500 } = {}) {
  const runtime = readRuntime(storeRoot, runtimeId)
  const checks = []
  const health = async (id, url) => {
    let timer = null
    try {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(url, { signal: controller.signal })
      checks.push({ id, ok: res.ok, status: res.status, url })
    } catch (error) {
      checks.push({ id, ok: false, error: String(error.message || error), url })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  await health('harness', `http://127.0.0.1:${runtime.ports.harness}/`)
  if (runtime.services?.brokerPort) {
    await health('broker', `http://127.0.0.1:${runtime.services.brokerPort}/healthz`)
  }
  for (const check of runtime.checks || []) {
    if (check.type === 'http') await health(check.id, check.url)
  }
  const store = new WorkspaceManager({ storeRoot: runtime.storeRoot })
  let namespace = null
  try { namespace = store.namespaces.read(runtime.runtimeId) } catch { /* 忽略 */ }
  checks.push({ id: 'namespace', ok: !!namespace && namespace.status === 'active', runtimeId: runtime.runtimeId })
  const manifest = store.readManifest(runtime.runtimeId, runtime.workId || 'main')
  checks.push({
    id: 'declaration',
    ok: !!manifest?.declaration,
    workId: runtime.workId || 'main',
    files: manifest?.declaration?.files || [],
  })
  checks.push({
    id: 'sessions',
    ok: !!runtime.paths?.sessions && fs.existsSync(runtime.paths.sessions),
    path: runtime.paths?.sessions || '',
  })
  for (const entry of runtime.storage?.files || []) {
    checks.push({ id: `files:${entry.id}`, ok: fs.existsSync(entry.path), path: entry.path, patterns: entry.patterns })
  }
  return { runtimeId, running: runtimeRunning(runtime), checks, ok: checks.every((c) => c.ok) }
}

/** 供 bundle / 外部启动器读取的 runtime 路径与端口。 */
export function runtimePublicInfo(runtime) {
  return {
    runtimeId: runtime.runtimeId,
    name: runtime.name,
    domain: runtime.domain,
    profile: runtime.profile,
    workId: runtime.workId,
    urlPort: runtime.urlPort || 'content',
    bindings: runtime.bindings || [],
    ports: runtime.ports,
    services: runtime.services || null,
    requires: runtime.requires || {},
    scope: runtime.scope || {},
    storage: runtime.storage || null,
    model: runtime.model || null,
    workspaceController: runtime.workspaceController ?? null,
    rootPatch: runtime.rootPatch || null,
    declaration: runtime.declaration || null,
    storeRoot: runtime.storeRoot,
    paths: {
      root: runtime.paths.root,
      dshHome: runtime.paths.dshHome,
      workspaceRoot: runtime.paths.workspaceRoot,
      workspace: runtime.paths.workspace,
      logs: runtime.paths.logs,
      tmp: runtime.paths.tmp,
      sessions: runtime.paths.sessions,
      storages: runtime.paths.storages,
      contentState: runtime.paths.contentState,
      runtimeFile: runtime.paths.runtimeFile,
    },
    harnessUrl: `http://127.0.0.1:${runtime.ports.harness}/`,
    contentUrl: `http://127.0.0.1:${runtime.ports.content}/`,
    running: runtimeRunning(runtime),
    status: runtime.status,
  }
}


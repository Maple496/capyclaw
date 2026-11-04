/**
 * 启动清单解析与校验（自包含）。
 *
 * 刻意不 deep-import dsh-suite-kit / dsh-service-broker：
 * 那两个包没有导出 lib/works-parser、lib/row-audit 等深路径，且插件需要可
 * 独立分发。这里实现的是「管理器视角」的轻量校验（结构、路径、冲突、行覆盖），
 * 深度语义校验仍以 dsh-deploy / dsh-domain validate 为准。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DOMAIN_FILENAMES = ['dsh-domain.json', 'domain.json']

const SPEC_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SCHEMA_VERSION_RE = /^\d+\.\d+\.\d+$/
const SECRET_ENV_RE = /(key|token|secret|password|passwd|credential|api[_-]?key)/i
const ROW_ID_RE = /^\s*-\s+id:\s*(.+?)\s*$/
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)\}/g
const NON_ENV_PLACEHOLDERS = new Set(['PACKAGE_DIR', 'PORT', 'HOST', 'PORT_MAIN'])

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function toPosix(value) {
  return String(value).split(path.sep).join('/')
}

export function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function shortHash(value, length = 10) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length)
}

export function stableManifestId(type, file) {
  return `${type}-${shortHash(path.resolve(String(file)), 10)}`
}

export function relPath(file, cwd = process.cwd()) {
  const rel = path.relative(cwd, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : toPosix(file)
}

function readJson(file) {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text)
}

function safeJson(file) {
  try {
    return { value: readJson(file), error: null }
  } catch (error) {
    return { value: null, error: error.message }
  }
}

function ensureStringArray(value, field, errors) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须是 string[]`)
    return []
  }
  const out = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item) errors.push(`${field}[${index}] 必须是非空字符串`)
    else out.push(item)
  }
  return out
}

export function expandPackageDir(value, base) {
  if (typeof value !== 'string') return value
  return value.replaceAll('${PACKAGE_DIR}', base)
}

/**
 * 路径型 token 的展开：`${PACKAGE_DIR}` 在开头时用 path.join 拼接，
 * 避免 Windows 上出现 `C:\repo/base/server.mjs` 这种混合分隔符。
 */
export function expandPathToken(value, base) {
  if (typeof value !== 'string') return value
  if (value === '${PACKAGE_DIR}') return base
  for (const prefix of ['${PACKAGE_DIR}/', '${PACKAGE_DIR}\\']) {
    if (value.startsWith(prefix)) {
      return path.join(base, value.slice(prefix.length))
    }
  }
  return expandPackageDir(value, base)
}

export function maskEnv(env) {
  if (!isObject(env)) return {}
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_ENV_RE.test(key) && typeof value === 'string' && !value.startsWith('${')
      ? '***'
      : value
  }
  return out
}

export function collectPlaceholders(value, out = new Map()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const name = match[1]
      if (NON_ENV_PLACEHOLDERS.has(name) || /^PORT_/.test(name)) continue
      out.set(name, (out.get(name) || 0) + 1)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, out)
  } else if (isObject(value)) {
    for (const item of Object.values(value)) collectPlaceholders(item, out)
  }
  return out
}

/** 把 ${PORT}/${PORT_X} 换成声明里的固定值；auto 保持原样。 */
export function displayUrl(value, ports) {
  if (typeof value !== 'string') return value
  let out = value
  const main = ports?.main
  if (typeof main === 'number') out = out.replaceAll('${PORT}', String(main))
  for (const [name, port] of Object.entries(ports || {})) {
    if (typeof port !== 'number') continue
    out = out.replaceAll(`\${PORT_${name.toUpperCase()}}`, String(port))
  }
  return out
}

function resolveMaybe(base, value) {
  if (typeof value !== 'string' || !value) return ''
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value)
}

function pushIssue(issues, severity, code, message, extra = {}) {
  issues.push({ severity, code, message, ...extra })
}

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析 broker spec 的 ports：数字（固定）或 "auto"（现场分配）。
 * 缺省视为 main=auto（与 broker 的隐式 main 端口一致）。
 */
export function parseSpecPorts(raw) {
  const issues = []
  const ports = {}
  const fixed = []
  if (raw == null) {
    ports.main = 'auto'
    return { ports, fixed, issues }
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) {
      issues.push({ severity: 'error', code: 'broker-invalid-port', message: `ports 非法: ${raw}` })
      return { ports, fixed, issues }
    }
    ports.main = raw
    fixed.push({ name: 'main', port: raw })
    return { ports, fixed, issues }
  }
  if (!isObject(raw)) {
    issues.push({ severity: 'error', code: 'broker-invalid-port', message: 'ports 必须是对象或正整数' })
    return { ports, fixed, issues }
  }
  for (const [name, value] of Object.entries(raw)) {
    if (value === 'auto') {
      ports[name] = 'auto'
      continue
    }
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) {
      ports[name] = value
      fixed.push({ name, port: value })
      continue
    }
    issues.push({
      severity: 'error',
      code: 'broker-invalid-port',
      message: `ports.${name} 非法: ${JSON.stringify(value)}（正整数或 "auto"）`,
    })
  }
  if (fixed.length === 0 && ports.main === undefined && Object.keys(ports).length === 0) ports.main = 'auto'
  return { ports, fixed, issues }
}

/**
 * 解析 domain/works 的 runtime.ports：数字、{preferred, range} 或 "auto"。
 * preferred 是首选端口，运行时可在 range 内浮动；冲突按 warning 处理。
 */
export function parseDeclaredPorts(raw, field = 'runtime.ports') {
  const issues = []
  const declared = []
  if (raw == null) return { declared, issues }
  if (!isObject(raw)) {
    issues.push({ severity: 'error', code: 'invalid-ports', message: `${field} 必须是对象` })
    return { declared, issues }
  }
  for (const [name, value] of Object.entries(raw)) {
    // services 是「服务名 → 端口」映射（与 dsh-stack-kit 的 ports.services 同语义），
    // 不是 {preferred, range} 端口项；逐项按嵌套键解析。
    if (name === 'services' && isObject(value)) {
      const nested = parseDeclaredPorts(value, `${field}.services`)
      declared.push(...nested.declared)
      issues.push(...nested.issues)
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        issues.push({ severity: 'error', code: 'invalid-ports', message: `${field}.${name} 非法: ${value}` })
      } else {
        declared.push({ name, port: value, mode: 'fixed' })
      }
      continue
    }
    if (value === 'auto' || value === 0) continue
    if (isObject(value)) {
      if (value.preferred === 0 || value.preferred === 'auto') continue
      if (typeof value.preferred === 'number' && Number.isInteger(value.preferred) && value.preferred > 0) {
        declared.push({ name, port: value.preferred, mode: 'preferred', range: value.range })
      } else {
        issues.push({
          severity: 'error',
          code: 'invalid-ports',
          message: `${field}.${name}.preferred 非法: ${JSON.stringify(value.preferred)}`,
        })
      }
      continue
    }
    issues.push({ severity: 'error', code: 'invalid-ports', message: `${field}.${name} 非法: ${JSON.stringify(value)}` })
  }
  return { declared, issues }
}

/* ------------------------------------------------------------------ */
/* broker 服务 spec                                                     */
/* ------------------------------------------------------------------ */

/**
 * 规范化单条 broker 服务 spec。
 * @returns {{ spec, actionSpec, specHash, ports, fixedPorts, issues, warnings, errors }}
 */
export function normalizeServiceSpec(raw, base) {
  const issues = []
  const errors = []
  const warnings = []

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'broker-invalid-spec', '服务项必须是对象')
    return { spec: null, actionSpec: null, specHash: '', ports: {}, fixedPorts: [], issues, errors: ['服务项必须是对象'], warnings }
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) pushIssue(issues, 'error', 'broker-missing-id', '服务缺少 id')
  else if (!SPEC_ID_RE.test(id)) pushIssue(issues, 'error', 'broker-invalid-id', `服务 id 非法: ${id}`)

  let cmd = []
  if (raw.cmd == null) {
    pushIssue(issues, 'error', 'broker-missing-cmd', `服务 ${id || '?'} 缺少 cmd（无法启动）`)
  } else if (!Array.isArray(raw.cmd) || raw.cmd.length === 0) {
    pushIssue(issues, 'error', 'broker-invalid-cmd', `服务 ${id || '?'} 的 cmd 必须是非空数组`)
  } else {
    cmd = raw.cmd.map((item) => String(item))
    if (cmd.some((item) => !item.trim())) pushIssue(issues, 'error', 'broker-invalid-cmd', `服务 ${id || '?'} 的 cmd 含空项`)
  }

  let env = {}
  if (raw.env != null) {
    if (!isObject(raw.env)) {
      pushIssue(issues, 'error', 'broker-invalid-env', `服务 ${id || '?'} 的 env 必须是对象`)
    } else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value !== 'string') {
          pushIssue(issues, 'error', 'broker-invalid-env', `服务 ${id || '?'} 的 env.${key} 必须是字符串`)
        } else {
          env[key] = value
          if (value.includes('${PACKAGE_DIR}')) {
            pushIssue(issues, 'warning', 'broker-env-package-dir',
              `服务 ${id || '?'} 的 env.${key} 含 \${PACKAGE_DIR}；broker 不会在 env 里展开它`)
          }
        }
      }
    }
  }

  const portResult = parseSpecPorts(raw.ports)
  issues.push(...portResult.issues)

  const cwdRaw = typeof raw.cwd === 'string' ? expandPathToken(raw.cwd, base) : ''
  const cwd = cwdRaw ? resolveMaybe(base, cwdRaw) : ''
  const urlRaw = typeof raw.url === 'string' ? expandPackageDir(raw.url, base) : ''
  const healthPath = typeof raw.healthPath === 'string' && raw.healthPath ? raw.healthPath : '/healthz'
  const keepAlive = raw.keepAlive === undefined ? true : !!raw.keepAlive
  const requireErrors = []
  const requires = ensureStringArray(raw.requires, `服务 ${id || '?'} 的 requires`, requireErrors)
  for (const message of requireErrors) {
    pushIssue(issues, 'error', 'broker-invalid-requires', message)
  }
  const derivedErrors = [...new Set(issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message))]
  const derivedWarnings = [...new Set(issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message))]

  const expandedCmd = cmd.map((item) => expandPathToken(item, base))
  const actionSpec = {
    id,
    cmd: expandedCmd,
    env,
    ...(cwd ? { cwd } : {}),
    ports: portResult.ports,
    ...(urlRaw ? { url: urlRaw } : {}),
    healthPath,
    keepAlive,
    ...(requires.length ? { requires } : {}),
    ...(typeof raw.logFile === 'string' ? { logFile: expandPathToken(raw.logFile, base) } : {}),
  }

  const displaySpec = {
    ...actionSpec,
    env: maskEnv(env),
    ...(urlRaw ? { url: displayUrl(urlRaw, portResult.ports) } : {}),
  }

  const hashInput = JSON.stringify({
    id,
    cmd: expandedCmd,
    env,
    cwd,
    ports: portResult.ports,
    url: urlRaw,
    healthPath,
    keepAlive,
    requires,
  })
  const specHash = shortHash(hashInput, 12)

  return {
    spec: displaySpec,
    actionSpec,
    specHash,
    ports: portResult.ports,
    fixedPorts: portResult.fixed,
    issues,
    errors: derivedErrors,
    warnings: derivedWarnings,
  }
}

/* ------------------------------------------------------------------ */
/* broker 清单                                                          */
/* ------------------------------------------------------------------ */

export function parseBrokerManifest(raw, file, options = {}) {
  const dir = path.dirname(file)
  const servicesRaw = Array.isArray(raw) ? raw : raw?.services
  const errors = []
  const warnings = []
  const issues = []
  const services = []

  if (!Array.isArray(servicesRaw)) {
    pushIssue(issues, 'error', 'broker-invalid-manifest', '清单必须顶层是服务数组，或 {services:[...]}')
    return baseRecord('broker', file, options, { errors: ['缺少 services 数组'], warnings, issues, services })
  }

  servicesRaw.forEach((item, index) => {
    const result = normalizeServiceSpec(item, dir)
    issues.push(...result.issues.map((issue) => ({ ...issue, index })))
    const record = {
      key: `${options.id || 'broker'}:${index}`,
      index,
      serviceId: result.spec?.id || `#${index}`,
      manifestId: options.id || '',
      manifestPath: file,
      manifestDir: dir,
      spec: result.spec,
      specHash: result.specHash,
      ports: result.ports,
      fixedPorts: result.fixedPorts,
      requires: result.spec?.requires || [],
      errors: result.errors,
      warnings: result.warnings,
      status: null,
    }
    if (result.actionSpec) {
      Object.defineProperty(record, '_actionSpec', {
        value: result.actionSpec,
        enumerable: false,
        configurable: true,
      })
    }
    services.push(record)
  })

  const byId = new Map()
  for (const service of services) {
    if (!service.serviceId || service.serviceId.startsWith('#')) continue
    if (!byId.has(service.serviceId)) byId.set(service.serviceId, [])
    byId.get(service.serviceId).push(service)
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      pushIssue(issues, 'error', 'broker-duplicate-id', `清单内重复服务 id: ${id}（${group.length} 条）`, { serviceId: id })
    }
  }

  const byPort = new Map()
  for (const service of services) {
    for (const fixed of service.fixedPorts) {
      if (!byPort.has(fixed.port)) byPort.set(fixed.port, [])
      byPort.get(fixed.port).push({ serviceId: service.serviceId, name: fixed.name })
    }
  }
  for (const [port, group] of byPort) {
    if (group.length > 1) {
      pushIssue(issues, 'error', 'broker-duplicate-port',
        `清单内端口 ${port} 被多条服务占用: ${group.map((item) => item.serviceId).join(', ')}`, { port })
    }
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('broker', file, options, { errors, warnings, issues, services })
  record.broker = {
    serviceCount: services.length,
    fixedPorts: [...byPort.keys()].sort((a, b) => a - b),
  }
  record.title = path.basename(file)
  return record
}

/* ------------------------------------------------------------------ */
/* .works 部署清单                                                      */
/* ------------------------------------------------------------------ */

export function parseWorksContent(content) {
  const metaStart = content.indexOf('%%%WORKS-META%%%')
  const codeStart = content.indexOf('%%%WORKS-CODE%%%')
  if (metaStart === -1) throw new Error('缺少 %%%WORKS-META%%% 标记')
  if (codeStart === -1) throw new Error('缺少 %%%WORKS-CODE%%% 标记')
  if (codeStart < metaStart) throw new Error('WORKS-CODE 标记出现在 WORKS-META 之前')
  const metaText = content.substring(metaStart + '%%%WORKS-META%%%'.length, codeStart).trim()
  const codeText = content.substring(codeStart + '%%%WORKS-CODE%%%'.length).trim()
  let meta
  try {
    meta = JSON.parse(metaText)
  } catch (error) {
    throw new Error(`META 段 JSON 解析失败: ${error.message}`)
  }
  let code
  try {
    code = JSON.parse(codeText)
  } catch {
    code = codeText
  }
  return { meta, code }
}

export function parseWorks(text, file, options = {}) {
  const dir = path.dirname(file)
  const errors = []
  const warnings = []
  const issues = []

  let parsed
  try {
    parsed = parseWorksContent(text)
  } catch (error) {
    pushIssue(issues, 'error', 'works-parse-error', error.message)
    return baseRecord('works', file, options, {
      errors: [error.message], warnings, issues, services: [],
      works: { format: 'works', meta: null, code: null, deployment: null, declaredPorts: [] },
      title: path.basename(file),
    })
  }

  const { meta, code } = parsed
  if (!isObject(meta)) {
    pushIssue(issues, 'error', 'works-meta-invalid', 'META 必须是 JSON 对象')
  } else {
    for (const field of ['name', 'brief', 'view']) {
      if (!meta[field]) pushIssue(issues, 'error', 'works-meta-invalid', `META 缺少必需字段: ${field}`)
    }
    if (meta.view != null && !isObject(meta.view)) {
      pushIssue(issues, 'error', 'works-meta-invalid', 'META.view 必须是对象')
    } else if (isObject(meta.view) && (typeof meta.view.kind !== 'string' || !meta.view.kind)) {
      pushIssue(issues, 'error', 'works-meta-invalid', 'META.view.kind 必须是非空字符串')
    }
    if (meta.schema_version != null && !SCHEMA_VERSION_RE.test(String(meta.schema_version))) {
      pushIssue(issues, 'warning', 'works-meta-version', `META.schema_version 建议 x.y.z: ${meta.schema_version}`)
    }
  }

  const viewKind = isObject(meta) && isObject(meta.view) ? meta.view.kind : undefined
  let deployment = null
  let declaredPorts = []

  if (viewKind === 'deployment') {
    if (!isObject(code)) {
      pushIssue(issues, 'error', 'works-code-invalid', '部署类 CODE 段必须是 JSON 对象')
    } else {
      if (!isObject(code.deployment)) {
        pushIssue(issues, 'error', 'works-code-invalid', 'CODE.deployment 缺失或不是对象')
      } else {
        if (typeof code.deployment.source !== 'string' || !code.deployment.source) {
          pushIssue(issues, 'error', 'works-code-invalid', 'CODE.deployment.source 必填')
        }
        if (code.deployment.type != null && code.deployment.type !== 'domain') {
          pushIssue(issues, 'error', 'works-code-invalid', `CODE.deployment.type 暂只支持 domain: ${code.deployment.type}`)
        }
      }
      if (code.runtime != null && !isObject(code.runtime)) {
        pushIssue(issues, 'error', 'works-code-invalid', 'CODE.runtime 必须是对象')
      }
      if (code.launcher != null && !isObject(code.launcher)) {
        pushIssue(issues, 'error', 'works-code-invalid', 'CODE.launcher 必须是对象')
      }
      const portResult = parseDeclaredPorts(code.runtime?.ports, 'CODE.runtime.ports')
      issues.push(...portResult.issues)
      declaredPorts = portResult.declared
      const portNames = new Map()
      for (const item of declaredPorts) {
        if (!portNames.has(item.port)) portNames.set(item.port, [])
        portNames.get(item.port).push(item.name)
      }
      for (const [port, names] of portNames) {
        if (names.length > 1) {
          pushIssue(issues, 'error', 'works-duplicate-port',
            `CODE.runtime.ports 内端口 ${port} 被多个名称占用: ${names.join(', ')}`)
        }
      }

      const source = typeof code.deployment?.source === 'string' ? code.deployment.source : ''
      const sourcePath = source ? path.resolve(dir, source) : ''
      const sourceExists = !!sourcePath && existsSync(sourcePath)
      let domainPath = ''
      if (sourceExists) {
        try {
          if (statSync(sourcePath).isDirectory()) {
            for (const name of DOMAIN_FILENAMES) {
              const candidate = path.join(sourcePath, name)
              if (existsSync(candidate)) { domainPath = candidate; break }
            }
          } else if (DOMAIN_FILENAMES.includes(path.basename(sourcePath))) {
            domainPath = sourcePath
          }
        } catch { /* stat 失败按不存在处理 */ }
      }
      if (!source) {
        // 已在上方记错
      } else if (!sourceExists) {
        pushIssue(issues, 'error', 'works-source-missing',
          `CODE.deployment.source 指向的路径不存在: ${source} → ${sourcePath}`)
      } else if (!domainPath) {
        pushIssue(issues, 'warning', 'works-source-not-domain',
          `CODE.deployment.source 存在但未找到 dsh-domain.json: ${sourcePath}`)
      }
      deployment = {
        source,
        sourcePath,
        sourceExists,
        domainPath,
        type: code.deployment?.type || 'domain',
        autoStart: !!code.deployment?.autoStart,
        autoRestart: !!code.deployment?.autoRestart,
      }
    }
  } else if (viewKind) {
    pushIssue(issues, 'warning', 'works-view-kind', `非部署类作品（view.kind=${viewKind}），只做清单登记`)
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('works', file, options, { errors, warnings, issues, services: [] })
  record.title = (isObject(meta) && typeof meta.name === 'string' && meta.name) || path.basename(file)
  record.works = {
    format: 'works',
    meta: isObject(meta) ? {
      name: meta.name,
      brief: meta.brief,
      tags: meta.tags,
      emoji: meta.emoji,
      view: meta.view,
      capabilities: meta.capabilities,
      requires: meta.requires,
      schema_version: meta.schema_version,
    } : null,
    code: isObject(code) ? {
      deployment: code.deployment,
      runtime: code.runtime,
      launcher: code.launcher,
      metadata: code.metadata,
    } : { raw: typeof code === 'string' ? code : null },
    deployment,
    declaredPorts,
  }
  return record
}

/* ------------------------------------------------------------------ */
/* domain 清单                                                          */
/* ------------------------------------------------------------------ */

function readPatchRowIds(file, cache) {
  if (!file || !existsSync(file)) return []
  const key = path.resolve(file)
  if (cache.has(key)) return cache.get(key)
  let ids = []
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(ROW_ID_RE)
      if (match) ids.push(match[1].replace(/^["']|["']$/g, ''))
    }
  } catch { ids = [] }
  cache.set(key, ids)
  return ids
}

function findSuiteFile(componentPath) {
  if (!componentPath || !existsSync(componentPath)) return ''
  try {
    if (statSync(componentPath).isFile()) return componentPath
    if (!statSync(componentPath).isDirectory()) return ''
  } catch {
    return ''
  }
  const candidate = path.join(componentPath, 'dsh-suite.json')
  return existsSync(candidate) ? candidate : ''
}

function collectComponentRows(componentPath, cache) {
  const rowIds = new Set()
  const packages = []
  const warnings = []
  const errors = []

  let baseDir = componentPath
  let suiteFile = findSuiteFile(componentPath)
  if (suiteFile && path.basename(suiteFile) !== 'dsh-suite.json') {
    // 传入的是具体清单文件
    baseDir = path.dirname(suiteFile)
  }
  if (suiteFile) {
    const loaded = safeJson(suiteFile)
    if (loaded.error) {
      errors.push(`suite 清单解析失败: ${suiteFile}: ${loaded.error}`)
    } else {
      const suite = loaded.value
      if (isObject(suite)) {
        for (const row of Array.isArray(suite.rows) ? suite.rows : []) {
          if (row && typeof row.id === 'string' && row.id) rowIds.add(row.id)
        }
        for (const id of readPatchRowIds(path.join(baseDir, 'cordis.patch.yml'), cache)) rowIds.add(id)
        for (const [name, pkg] of Object.entries(isObject(suite.packages) ? suite.packages : {})) {
          const pkgPath = pkg && typeof pkg.path === 'string'
            ? resolveMaybe(baseDir, pkg.path)
            : path.join(baseDir, 'node_modules', name)
          packages.push({ name, path: pkgPath, exists: existsSync(pkgPath) })
          for (const id of readPatchRowIds(path.join(pkgPath, 'cordis.patch.yml'), cache)) rowIds.add(id)
        }
      } else {
        errors.push(`suite 清单不是对象: ${suiteFile}`)
      }
    }
  } else {
    warnings.push(`组件目录未找到 dsh-suite.json: ${componentPath}`)
    for (const id of readPatchRowIds(path.join(componentPath, 'cordis.patch.yml'), cache)) rowIds.add(id)
  }

  return { rowIds: [...rowIds], packages, warnings, errors }
}

export function parseDomain(raw, file, options = {}) {
  const dir = path.dirname(file)
  const errors = []
  const warnings = []
  const issues = []
  const patchCache = options.patchCache || new Map()

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'domain-invalid', 'domain manifest 必须是 JSON 对象')
    return baseRecord('domain', file, options, {
      errors: ['domain manifest 必须是 JSON 对象'], warnings, issues, services: [],
      domain: { name: null, version: null, components: [], rowRefs: [], rowIds: [], declaredPorts: [] },
      title: path.basename(file),
    })
  }

  if (!NAME_RE.test(raw.name || '')) pushIssue(issues, 'error', 'domain-invalid', 'name 必须是 kebab-case')
  if (!VERSION_RE.test(raw.version || '')) pushIssue(issues, 'error', 'domain-invalid', 'version 必须是 semver')

  const components = []
  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    pushIssue(issues, 'error', 'domain-invalid', 'components 必须是非空数组')
  } else {
    raw.components.forEach((value, index) => {
      if (typeof value !== 'string' || !value) {
        pushIssue(issues, 'error', 'domain-invalid', `components[${index}] 必须是路径字符串`)
        return
      }
      const componentPath = path.resolve(dir, value)
      const exists = existsSync(componentPath)
      if (!exists) {
        pushIssue(issues, 'error', 'domain-component-missing',
          `components[${index}] 路径不存在: ${value} → ${componentPath}`)
      }
      const collected = exists ? collectComponentRows(componentPath, patchCache) : {
        rowIds: [], packages: [], warnings: [`组件不存在，无法读取行声明: ${value}`], errors: [],
      }
      for (const message of collected.warnings) {
        pushIssue(issues, 'warning', 'domain-suite-missing', message)
      }
      for (const message of collected.errors) {
        pushIssue(issues, 'error', 'domain-suite-invalid', message)
      }
      components.push({
        path: value,
        resolved: componentPath,
        exists,
        suiteFile: exists ? (findSuiteFile(componentPath) || '') : '',
        rowIds: collected.rowIds,
        packages: collected.packages,
      })
    })
  }

  const parseErrors = []
  if (raw.baseBundles != null) {
    ensureStringArray(raw.baseBundles, 'baseBundles', parseErrors)
  }
  if (raw.profile != null && !isObject(raw.profile)) {
    pushIssue(issues, 'error', 'domain-invalid', 'profile 必须是对象')
  }

  let declaredPorts = []
  const rowRefs = []
  if (raw.runtime != null) {
    if (!isObject(raw.runtime)) {
      pushIssue(issues, 'error', 'domain-invalid', 'runtime 必须是对象')
    } else {
      if (raw.runtime.driver != null && !['node', 'jobobject', 'docker', 'wsl'].includes(raw.runtime.driver)) {
        pushIssue(issues, 'error', 'domain-invalid', `runtime.driver 非法: ${raw.runtime.driver}`)
      }
      if (raw.runtime.bindings != null) {
        if (!Array.isArray(raw.runtime.bindings)) {
          pushIssue(issues, 'error', 'domain-invalid', 'runtime.bindings 必须是数组')
        } else {
          raw.runtime.bindings.forEach((binding, index) => {
            if (!isObject(binding) || (!binding.row && !binding.package)) {
              pushIssue(issues, 'error', 'domain-invalid', `runtime.bindings[${index}] 必须包含 row 或 package`)
            }
            if (isObject(binding) && typeof binding.row === 'string' && binding.row) {
              rowRefs.push({ id: binding.row, source: `runtime.bindings[${index}].row` })
            }
          })
        }
      }
      for (const key of ['tools', 'services', 'capabilities']) {
        if (raw.runtime.requires?.[key] != null) {
          ensureStringArray(raw.runtime.requires[key], `runtime.requires.${key}`, parseErrors)
        }
      }
      if (raw.runtime.scope != null && !isObject(raw.runtime.scope)) {
        pushIssue(issues, 'error', 'domain-invalid', 'runtime.scope 必须是对象')
      }
      const portResult = parseDeclaredPorts(raw.runtime.ports, 'runtime.ports')
      issues.push(...portResult.issues)
      declaredPorts = portResult.declared
    }
  }

  if (raw.removeRows != null) {
    if (!Array.isArray(raw.removeRows) || raw.removeRows.some((item) => typeof item !== 'string' || !item)) {
      pushIssue(issues, 'error', 'domain-invalid', 'removeRows 必须是 string[]')
    } else {
      for (const id of raw.removeRows) rowRefs.push({ id, source: 'removeRows' })
    }
  }
  if (raw.removeDependencies != null) {
    ensureStringArray(raw.removeDependencies, 'removeDependencies', parseErrors)
  }
  if (raw.rowOverrides != null) {
    if (!isObject(raw.rowOverrides)) {
      pushIssue(issues, 'error', 'domain-invalid', 'rowOverrides 必须是对象')
    } else {
      for (const [id, override] of Object.entries(raw.rowOverrides)) {
        if (!isObject(override)) pushIssue(issues, 'error', 'domain-invalid', `rowOverrides.${id} 必须是对象`)
      }
    }
  }

  const declaredRows = new Set()
  for (const component of components) {
    for (const id of component.rowIds) declaredRows.add(id)
  }
  const missingRows = rowRefs.filter((ref) => !declaredRows.has(ref.id))
  for (const ref of missingRows) {
    pushIssue(issues, 'error', 'domain-row-missing',
      `行引用不存在于组件链: ${ref.id}（${ref.source}）`)
  }

  for (const message of parseErrors) {
    if (!issues.some((issue) => issue.message === message)) {
      pushIssue(issues, 'error', 'domain-invalid', message)
    }
  }

  const portOwners = new Map()
  for (const item of declaredPorts) {
    if (!portOwners.has(item.port)) portOwners.set(item.port, [])
    portOwners.get(item.port).push(item.name)
  }
  for (const [port, names] of portOwners) {
    if (names.length > 1) {
      pushIssue(issues, 'error', 'domain-duplicate-port',
        `runtime.ports 内端口 ${port} 被多个名称占用: ${names.join(', ')}`)
    }
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('domain', file, options, { errors, warnings, issues, services: [] })
  record.title = typeof raw.title === 'string' && raw.title ? raw.title
    : typeof raw.name === 'string' && raw.name ? raw.name : path.basename(file)
  record.domain = {
    name: raw.name,
    version: raw.version,
    title: raw.title,
    components,
    baseBundles: raw.baseBundles || [],
    profile: raw.profile || null,
    rowRefs,
    declaredRows: [...declaredRows],
    missingRows,
    declaredPorts,
    requires: raw.runtime?.requires || {},
  }
  return record
}

/* ------------------------------------------------------------------ */
/* dsh-deploy 的 JSON 部署配置                                          */
/* ------------------------------------------------------------------ */

export function parseDeploymentJson(raw, file, options = {}) {
  const dir = path.dirname(file)
  const errors = []
  const warnings = []
  const issues = []

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'works-code-invalid', '部署配置必须是 JSON 对象')
  } else {
    if (!isObject(raw.deployment)) {
      pushIssue(issues, 'error', 'works-code-invalid', 'deployment 缺失或不是对象')
    } else if (typeof raw.deployment.source !== 'string' || !raw.deployment.source) {
      pushIssue(issues, 'error', 'works-code-invalid', 'deployment.source 必填')
    }
    if (raw.runtime != null && !isObject(raw.runtime)) {
      pushIssue(issues, 'error', 'works-code-invalid', 'runtime 必须是对象')
    }
    if (raw.launcher != null && !isObject(raw.launcher)) {
      pushIssue(issues, 'error', 'works-code-invalid', 'launcher 必须是对象')
    }
  }

  const source = isObject(raw) && isObject(raw.deployment) && typeof raw.deployment.source === 'string'
    ? raw.deployment.source : ''
  const sourcePath = source ? path.resolve(dir, source) : ''
  const sourceExists = !!sourcePath && existsSync(sourcePath)
  let domainPath = ''
  if (sourceExists) {
    try {
      if (statSync(sourcePath).isDirectory()) {
        for (const name of DOMAIN_FILENAMES) {
          const candidate = path.join(sourcePath, name)
          if (existsSync(candidate)) { domainPath = candidate; break }
        }
      } else if (DOMAIN_FILENAMES.includes(path.basename(sourcePath))) {
        domainPath = sourcePath
      }
    } catch { /* ignore */ }
  }
  if (source && !sourceExists) {
    pushIssue(issues, 'error', 'works-source-missing', `deployment.source 指向的路径不存在: ${sourcePath}`)
  } else if (source && !domainPath) {
    pushIssue(issues, 'warning', 'works-source-not-domain', `deployment.source 存在但未找到 dsh-domain.json: ${sourcePath}`)
  }

  const portResult = parseDeclaredPorts(raw?.runtime?.ports, 'runtime.ports')
  issues.push(...portResult.issues)
  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('works', file, options, { errors, warnings, issues, services: [] })
  record.title = (isObject(raw) && (raw.title || raw.name)) || path.basename(file)
  record.works = {
    format: 'json',
    meta: null,
    code: isObject(raw) ? raw : null,
    deployment: source ? {
      source,
      sourcePath,
      sourceExists,
      domainPath,
      type: raw?.deployment?.type || 'domain',
      autoStart: !!raw?.deployment?.autoStart,
      autoRestart: !!raw?.deployment?.autoRestart,
    } : null,
    declaredPorts: portResult.declared,
  }
  return record
}

/* ------------------------------------------------------------------ */
/* launcher 配置                                                        */
/* ------------------------------------------------------------------ */

export function parseLauncher(raw, file, options = {}) {
  const dir = path.dirname(file)
  const errors = []
  const warnings = []
  const issues = []

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'launcher-invalid', 'launcher 配置必须是 JSON 对象')
    return baseRecord('launcher', file, options, {
      errors: ['launcher 配置必须是 JSON 对象'], warnings, issues, services: [],
      launcher: { config: null, resolved: null, state: null },
      title: path.basename(file),
    })
  }

  const resolved = {}
  for (const key of ['harnessDir', 'brokerDir', 'stateDir', 'workspace', 'manifest', 'dshHome']) {
    if (typeof raw[key] === 'string' && raw[key]) resolved[key] = resolveMaybe(dir, raw[key])
    else resolved[key] = ''
  }
  const portKeys = ['dshProxyPort', 'dshUpPort', 'brokerPort']
  for (const key of portKeys) {
    const value = raw[key]
    if (value === undefined || value === null || value === '' || value === 'auto') continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65535) {
      pushIssue(issues, 'error', 'launcher-invalid', `${key} 必须是正整数或 "auto": ${JSON.stringify(value)}`)
    }
  }

  if (!resolved.manifest) pushIssue(issues, 'error', 'launcher-invalid', 'manifest 必填（broker 开机清单）')
  else if (!existsSync(resolved.manifest)) {
    pushIssue(issues, 'error', 'launcher-manifest-missing', `manifest 不存在: ${resolved.manifest}`)
  }
  if (!resolved.harnessDir) pushIssue(issues, 'error', 'launcher-invalid', 'harnessDir 必填')
  else if (!existsSync(path.join(resolved.harnessDir, 'auth-proxy.mjs'))) {
    pushIssue(issues, 'error', 'launcher-path-missing', `harnessDir 下找不到 auth-proxy.mjs: ${resolved.harnessDir}`)
  }
  if (!resolved.brokerDir) pushIssue(issues, 'error', 'launcher-invalid', 'brokerDir 必填')
  else if (!existsSync(path.join(resolved.brokerDir, 'server.mjs'))) {
    pushIssue(issues, 'error', 'launcher-path-missing', `brokerDir 下找不到 server.mjs: ${resolved.brokerDir}`)
  }
  if (!resolved.dshHome) pushIssue(issues, 'warning', 'launcher-invalid', 'dshHome 未配置（首次启动前会创建）')
  else if (!existsSync(resolved.dshHome)) {
    pushIssue(issues, 'warning', 'launcher-dsh-home-missing', `dshHome 尚未创建: ${resolved.dshHome}`)
  }
  if (!resolved.stateDir) pushIssue(issues, 'warning', 'launcher-invalid', 'stateDir 未配置（运行态无法定位）')

  let state = null
  const stateFile = resolved.stateDir ? path.join(resolved.stateDir, 'state.json') : ''
  if (stateFile && existsSync(stateFile)) {
    const loaded = safeJson(stateFile)
    if (loaded.error) pushIssue(issues, 'warning', 'launcher-state-invalid', `state.json 解析失败: ${loaded.error}`)
    else state = loaded.value
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('launcher', file, options, { errors, warnings, issues, services: [] })
  record.title = (typeof raw.name === 'string' && raw.name) || path.basename(file)
  record.launcher = {
    config: raw,
    resolved,
    state,
    stateFile: stateFile || '',
    discoveryFile: state?.discovery
      || (resolved.stateDir ? path.join(resolved.stateDir, 'services.json') : ''),
  }
  return record
}

/* ------------------------------------------------------------------ */
/* profile 激活清单                                                     */
/* ------------------------------------------------------------------ */

export function parseProfile(raw, file, options = {}) {
  const errors = []
  const warnings = []
  const issues = []

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'profile-invalid', 'profile package.json 必须是 JSON 对象')
    return baseRecord('profile', file, options, {
      errors: ['profile package.json 必须是 JSON 对象'], warnings, issues, services: [],
      profile: { name: path.basename(path.dirname(file)), bundles: [], suites: [] },
      title: path.basename(path.dirname(file)),
    })
  }

  const bundles = []
  const rawBundles = raw.dsh?.profile?.bundles
  if (rawBundles != null) {
    if (!Array.isArray(rawBundles)) {
      pushIssue(issues, 'error', 'profile-invalid', 'dsh.profile.bundles 必须是数组')
    } else {
      for (const [index, value] of rawBundles.entries()) {
        if (typeof value !== 'string' || !value) {
          pushIssue(issues, 'error', 'profile-invalid', `dsh.profile.bundles[${index}] 必须是非空字符串`)
        } else {
          bundles.push(value)
        }
      }
    }
  }

  const seen = new Set()
  for (const bundle of bundles) {
    if (seen.has(bundle)) {
      pushIssue(issues, 'warning', 'profile-bundle-duplicate', `bundle 重复声明: ${bundle}`)
    }
    seen.add(bundle)
  }

  const suites = []
  const rawSuites = raw.dshSuiteKit?.suites
  if (rawSuites != null) {
    if (!Array.isArray(rawSuites)) {
      pushIssue(issues, 'warning', 'profile-invalid', 'dshSuiteKit.suites 不是数组')
    } else {
      for (const value of rawSuites) if (typeof value === 'string' && value) suites.push(value)
    }
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const profileName = path.basename(path.dirname(file))
  const record = baseRecord('profile', file, options, { errors, warnings, issues, services: [] })
  record.title = `${profileName} profile`
  record.profile = {
    name: profileName,
    dir: path.dirname(file),
    bundles,
    suites,
    dependencies: isObject(raw.dependencies) ? raw.dependencies : {},
  }
  return record
}

/* ------------------------------------------------------------------ */
/* dsh-stack.json（统一启动清单）                                       */
/* ------------------------------------------------------------------ */

function stackServicePorts(value, field, issues) {
  if (value == null) return {}
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0 && value <= 65535) return { main: value }
    pushIssue(issues, 'error', 'stack-invalid-port', `${field} 非法: ${value}`)
    return {}
  }
  if (!isObject(value)) {
    pushIssue(issues, 'error', 'stack-invalid-port', `${field} 必须是对象或正整数`)
    return {}
  }
  const out = {}
  for (const [name, port] of Object.entries(value)) {
    if (port === 'auto' || (Number.isInteger(port) && port > 0 && port <= 65535)) out[name] = port
    else pushIssue(issues, 'error', 'stack-invalid-port', `${field}.${name} 非法: ${JSON.stringify(port)}`)
  }
  return out
}

export function parseStack(raw, file, options = {}) {
  const dir = path.dirname(file)
  const errors = []
  const warnings = []
  const issues = []

  if (!isObject(raw)) {
    pushIssue(issues, 'error', 'stack-invalid', 'stack 必须是 JSON 对象')
    return baseRecord('stack', file, options, {
      errors: ['stack 必须是 JSON 对象'], warnings, issues, services: [],
      stack: { name: null, profile: null, home: '', profilePackage: '', workspace: '', stateDir: '', manifest: '', bundles: [], services: [], drift: null },
      title: path.basename(file),
    })
  }

  const name = typeof raw.name === 'string' ? raw.name : ''
  const profile = typeof raw.profile === 'string' ? raw.profile : ''
  const homeRaw = typeof raw.home === 'string' ? raw.home : ''
  if (!name) pushIssue(issues, 'error', 'stack-invalid', 'name 必填')
  if (!profile) pushIssue(issues, 'error', 'stack-invalid', 'profile 必填')
  if (!homeRaw) pushIssue(issues, 'error', 'stack-invalid', 'home 必填')

  const home = homeRaw ? path.resolve(dir, homeRaw) : ''
  const profileDir = home && profile ? path.join(home, 'profiles', profile) : ''
  const profilePackage = profileDir ? path.join(profileDir, 'package.json') : ''
  const stateDir = raw.stateDir ? path.resolve(dir, String(raw.stateDir)) : path.resolve(dir, '.dshd', 'state')
  const workspace = raw.workspace ? path.resolve(dir, String(raw.workspace)) : path.resolve(dir, 'workspace')
  const manifest = path.join(stateDir, 'stack-services.json')

  const bundles = []
  const pluginsRaw = raw.plugins
  if (pluginsRaw != null && !isObject(pluginsRaw)) {
    pushIssue(issues, 'error', 'stack-invalid', 'plugins 必须是对象')
  } else {
    const list = pluginsRaw?.bundles
    if (list != null && !Array.isArray(list)) pushIssue(issues, 'error', 'stack-invalid', 'plugins.bundles 必须是数组')
    else for (const [index, entry] of (list || []).entries()) {
      if (typeof entry === 'string') {
        bundles.push(entry)
        continue
      }
      if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name) {
        pushIssue(issues, 'error', 'stack-invalid', `plugins.bundles[${index}] 必须是 string 或 {name,path|version}`)
        continue
      }
      bundles.push(entry.name)
      if (entry.path) {
        const pluginDir = path.resolve(dir, String(entry.path))
        if (!existsSync(path.join(pluginDir, 'package.json'))) {
          pushIssue(issues, 'error', 'stack-plugin-missing', `plugins.bundles[${index}] 的插件目录没有 package.json: ${pluginDir}`)
        }
      }
    }
  }

  const services = []
  const serviceIds = new Set()
  if (raw.services != null && !Array.isArray(raw.services)) {
    pushIssue(issues, 'error', 'stack-invalid', 'services 必须是数组')
  } else for (const [index, service] of (raw.services || []).entries()) {
    if (!isObject(service)) {
      pushIssue(issues, 'error', 'stack-invalid', `services[${index}] 必须是对象`)
      continue
    }
    const id = typeof service.id === 'string' ? service.id : ''
    if (!id) pushIssue(issues, 'error', 'stack-invalid', `services[${index}].id 必填`)
    else if (serviceIds.has(id)) pushIssue(issues, 'error', 'stack-duplicate-id', `stack 内重复服务 id: ${id}`)
    else serviceIds.add(id)
    const hasCmd = Array.isArray(service.cmd)
    const hasPath = typeof service.path === 'string' && service.path
    if (!hasCmd && !hasPath) pushIssue(issues, 'error', 'stack-invalid', `services[${index}] 需要 cmd 或 path`)
    if (hasCmd && hasPath) pushIssue(issues, 'error', 'stack-invalid', `services[${index}] 不能同时有 cmd 和 path`)
    if (hasPath) {
      const script = path.resolve(dir, service.path)
      if (!existsSync(script)) pushIssue(issues, 'error', 'stack-service-missing', `services[${index}].path 不存在: ${script}`)
    }
    services.push({
      id,
      path: hasPath ? path.resolve(dir, service.path) : '',
      cmd: hasCmd ? service.cmd.map((item) => String(item)) : null,
      ports: stackServicePorts(service.ports, `services[${index}].ports`, issues),
    })
  }

  const profileBundles = []
  if (profilePackage) {
    if (!existsSync(profilePackage)) {
      pushIssue(issues, 'warning', 'stack-profile-missing', `生成 profile 尚不存在: ${profilePackage}`)
    } else {
      const loaded = safeJson(profilePackage)
      if (loaded.error) pushIssue(issues, 'warning', 'stack-profile-invalid', `profile package.json 解析失败: ${loaded.error}`)
      else {
        const list = loaded.value?.dsh?.profile?.bundles
        if (Array.isArray(list)) profileBundles.push(...list.filter((item) => typeof item === 'string'))
      }
    }
  }

  if (profileBundles.length) {
    const missing = bundles.filter((name) => !profileBundles.includes(name))
    const extra = profileBundles.filter((name) => !bundles.includes(name))
    if (missing.length || extra.length) {
      pushIssue(issues, 'warning', 'stack-profile-drift',
        `stack 与 profile bundles 不一致：profile 缺 [${missing.join(', ')}]；profile 多 [${extra.join(', ')}]`)
    }
  }

  let generated = null
  if (!existsSync(manifest)) {
    pushIssue(issues, 'warning', 'stack-manifest-missing', `生成的服务清单尚不存在（先 dshd stack apply）: ${manifest}`)
  } else {
    const loaded = safeJson(manifest)
    if (loaded.error) pushIssue(issues, 'warning', 'stack-manifest-invalid', `生成的服务清单解析失败: ${loaded.error}`)
    else generated = loaded.value
  }
  if (generated) {
    const generatedIds = new Set((generated.services || []).map((service) => service.id))
    const missing = services.map((service) => service.id).filter((id) => !generatedIds.has(id))
    const extra = [...generatedIds].filter((id) => !services.some((service) => service.id === id))
    if (missing.length || extra.length) {
      pushIssue(issues, 'warning', 'stack-manifest-drift',
        `stack 与生成服务清单不一致：清单缺 [${missing.join(', ')}]；清单多 [${extra.join(', ')}]`)
    }
    for (const service of services) {
      const row = (generated.services || []).find((item) => item.id === service.id)
      if (!row) continue
      if (JSON.stringify(row.ports || {}) !== JSON.stringify(service.ports || {})) {
        pushIssue(issues, 'warning', 'stack-service-port-drift',
          `服务 ${service.id} 的 ports 与生成清单不一致: ${JSON.stringify(service.ports)} vs ${JSON.stringify(row.ports || {})}`)
      }
    }
  }

  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.message)
    else warnings.push(issue.message)
  }

  const record = baseRecord('stack', file, options, { errors, warnings, issues, services: [] })
  record.title = name || path.basename(file)
  record.stack = {
    name,
    profile,
    home,
    profileDir,
    profilePackage,
    workspace,
    stateDir,
    manifest,
    ports: raw.ports || {},
    bundles,
    install: pluginsRaw?.install !== false,
    services,
    drift: {
      profileBundles,
      generatedServices: generated ? (generated.services || []).map((service) => service.id) : null,
    },
  }
  return record
}

/* ------------------------------------------------------------------ */
/* 基础记录                                                             */
/* ------------------------------------------------------------------ */

function baseRecord(type, file, options, extra) {
  const abs = path.resolve(file)
  return {
    ...extra,
    id: options.id || stableManifestId(type, abs),
    type,
    path: abs,
    relativePath: options.relativePath || relPath(abs),
    title: extra.title || path.basename(file),
    valid: (extra.errors || []).length === 0,
    errors: extra.errors || [],
    warnings: extra.warnings || [],
    issues: extra.issues || [],
    services: extra.services || [],
  }
}

/* ------------------------------------------------------------------ */
/* 形状识别                                                             */
/* ------------------------------------------------------------------ */

export function isStackShape(raw, file = '') {
  if (!isObject(raw)) return false
  const name = path.basename(file).toLowerCase()
  if (name === 'dsh-stack.json' || name.endsWith('-stack.json') || name.endsWith('.stack.json')) return true
  return typeof raw.profile === 'string'
    && raw.home != null
    && isObject(raw.plugins)
    && Array.isArray(raw.services)
}

export function isDiscoveryShape(raw) {
  return isObject(raw)
    && isObject(raw.services)
    && !Array.isArray(raw.services)
    && Object.values(raw.services).every((row) => isObject(row))
}

export function isBrokerManifestShape(raw, file = '') {
  if (isDiscoveryShape(raw)) return false
  const list = Array.isArray(raw) ? raw : (isObject(raw) && Array.isArray(raw.services) ? raw.services : null)
  if (!list) return false
  if (list.length === 0) return /(^|[-_.])services?\.json$/i.test(path.basename(file)) || /manifest/i.test(path.basename(file))
  return list.every((item) => isObject(item)
    && typeof item.id === 'string'
    && (Array.isArray(item.cmd) || item.cmd === undefined)
    && (item.cmd !== undefined || item.ports !== undefined || item.url !== undefined || item.requires !== undefined))
}

export function isDomainShape(raw, file = '') {
  if (!isObject(raw)) return false
  if (DOMAIN_FILENAMES.includes(path.basename(file))) return true
  return typeof raw.name === 'string'
    && Array.isArray(raw.components)
    && (isObject(raw.runtime) || raw.runtime === undefined)
}

export function isLauncherShape(raw, file = '') {
  if (!isObject(raw)) return false
  if (path.basename(file) === 'dshd.config.json') return true
  return typeof raw.manifest === 'string' && raw.manifest
    && ['harnessDir', 'brokerDir', 'dshHome', 'stateDir'].some((key) => typeof raw[key] === 'string')
}

export function isProfileShape(raw, file = '') {
  if (!isObject(raw)) return false
  const inProfiles = /(^|[\\/])profiles[\\/][^\\/]+[\\/]package\.json$/i.test(file)
  return inProfiles && Array.isArray(raw.dsh?.profile?.bundles)
}

export function isDeploymentJsonShape(raw, file = '') {
  if (!isObject(raw)) return false
  if (isLauncherShape(raw, file) || isDomainShape(raw, file) || isProfileShape(raw, file)) return false
  return isObject(raw.deployment) && typeof raw.deployment.source === 'string' && raw.deployment.source.length > 0
}

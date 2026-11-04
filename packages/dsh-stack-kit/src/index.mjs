/**
 * dsh-stack-kit：统一启动清单编译器。
 *
 * 一份 dsh-stack.json 决定：
 *   - DSH_HOME / profile / workspace / stateDir / 端口
 *   - profile 的 dsh.profile.bundles（插件）与 link/registry 依赖
 *   - broker 的服务 spec（独立进程）
 *
 * 编译产物仍是现有契约：
 *   <home>/profiles/<profile>/package.json   （插件激活清单）
 *   <stateDir>/stack-services.json           （broker 服务清单）
 * dsh / broker 不需要认识 dsh-stack.json。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { buildConfigPatches } from './plugin-config.mjs'
import { readManagedBlock, parseManagedBlock, writeManagedBlock } from './patch-block.mjs'

export const STACK_FILENAMES = ['dsh-stack.json']
const PROFILE_RE = /^[a-z0-9][a-z0-9-]*$/
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** kind 缺省：显式优先；有 domain 段按 domain，否则 profile。 */
function stackKind(stack) {
  return stack.kind || (isObject(stack.domain) ? 'domain' : 'profile')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function safeJson(file) {
  try {
    return { value: readJson(file), error: null }
  } catch (error) {
    return { value: null, error: error.message }
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function abs(base, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value)
}

function looksLikePath(value) {
  return typeof value === 'string'
    && (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')
      || /^[A-Za-z]:[\\/]/.test(value) || value.includes('/') || value.includes('\\'))
}

function portOrAuto(value) {
  return value === 'auto' || (Number.isInteger(value) && value > 0 && value <= 65535)
}

function checkPort(value, field, errors) {
  if (value === undefined) return
  if (!portOrAuto(value)) errors.push(`${field} 必须是 1-65535 的整数或 "auto": ${JSON.stringify(value)}`)
}

function toPosix(value) {
  return String(value).split(path.sep).join('/')
}

function normalizeDependencySpec(value, base) {
  if (typeof value === 'string') {
    if (/^(link|file|npm|workspace):/i.test(value)) return value
    if (looksLikePath(value)) return `link:${toPosix(abs(base, value))}`
    return value
  }
  if (isObject(value)) {
    if (typeof value.path === 'string' && value.path) return `link:${toPosix(abs(base, value.path))}`
    if (typeof value.version === 'string' && value.version) return value.version
  }
  return undefined
}

function expandKnown(value, ctx) {
  if (typeof value !== 'string') return value
  let out = value
  // 路径型前缀用 path.join 拼接，避免 Windows 上出现 C:\repo/base 混合分隔符。
  for (const [token, base] of [['${STACK_DIR}', ctx.stackDir], ['${home}', ctx.home]]) {
    for (const sep of ['/', '\\']) {
      if (out.startsWith(token + sep)) {
        out = path.join(base, out.slice(token.length + 1))
        break
      }
    }
  }
  out = out
    .replaceAll('${STACK_DIR}', ctx.stackDir)
    .replaceAll('${home}', ctx.home)
    .replaceAll('${profile}', ctx.profile)
  for (const key of ['broker', 'proxy', 'upstream']) {
    const port = ctx.ports?.[key]
    if (typeof port === 'number') out = out.replaceAll(`\${ports.${key}}`, String(port))
  }
  for (const [id, port] of Object.entries(ctx.ports?.services || {})) {
    if (typeof port === 'number') out = out.replaceAll(`\${ports.services.${id}}`, String(port))
  }
  return out
}

function expandDeep(value, ctx) {
  if (typeof value === 'string') return expandKnown(value, ctx)
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, ctx))
  if (isObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item, ctx)
    return out
  }
  return value
}

function stackSlug(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'stack'
}

export function resolveStackPaths(stack) {
  const dir = stack.dir || path.dirname(stack.path || path.resolve('dsh-stack.json'))
  const kind = stackKind(stack)
  const home = stack.home ? abs(dir, stack.home) : (kind === 'profile' ? path.join(dir, '.dshd', 'home') : '')
  const profile = stack.profile || (kind === 'profile' ? 'web' : '')
  const profileDir = home && profile ? path.join(home, 'profiles', profile) : ''
  const stateDir = abs(dir, stack.stateDir || './.dshd/state')
  const domain = isObject(stack.domain) ? stack.domain : null
  const storeRoot = kind === 'domain'
    ? abs(dir, domain?.storeRoot || path.join(stateDir, 'store'))
    : ''
  const domainSource = kind === 'domain' && domain?.source ? abs(dir, domain.source) : ''
  const runtimeId = kind === 'domain'
    ? (domain?.runtimeId || `rt-stack-${stackSlug(stack.name)}`)
    : ''
  return {
    kind,
    home,
    profile,
    profileDir,
    profilePackage: profileDir ? path.join(profileDir, 'package.json') : '',
    profilePatch: profileDir ? path.join(profileDir, 'cordis.patch.yml') : '',
    stateDir,
    // 空 workspace = "用 dsh/profile 默认"，交给 launcher 的 `|| harnessDir/workspace` 回退。
    // 不能回退成 stackDir/workspace：stack 目录通常没有这个子目录，spawn 的 cwd 会 ENOENT。
    workspace: stack.workspace ? abs(dir, stack.workspace) : '',
    manifest: path.join(stateDir, 'stack-services.json'),
    storeRoot,
    domainSource,
    runtimeId,
    harnessDir: stack.harnessDir ? abs(dir, stack.harnessDir) : '',
    brokerDir: stack.brokerDir ? abs(dir, stack.brokerDir) : '',
  }
}

export function loadStack(file) {
  const absPath = path.resolve(file)
  if (!existsSync(absPath)) throw new Error(`stack 不存在: ${absPath}`)
  const raw = readJson(absPath)
  if (!isObject(raw)) throw new Error(`stack 必须是 JSON 对象: ${absPath}`)
  const dir = path.dirname(absPath)
  const stack = { ...raw, path: absPath, dir }
  stack.kind = stackKind(stack)
  stack.paths = resolveStackPaths(stack)
  return stack
}

export function validateStack(stack) {
  const errors = []
  const warnings = []
  const paths = stack.paths || resolveStackPaths(stack)
  const kind = stackKind(stack)

  if (!['profile', 'domain'].includes(kind)) errors.push(`kind 必须是 profile 或 domain: ${JSON.stringify(kind)}`)
  if (!stack.name || typeof stack.name !== 'string') errors.push('name 必填（string）')
  if (kind === 'profile') {
    if (!stack.profile || typeof stack.profile !== 'string') errors.push('profile 必填（string）')
    else if (!PROFILE_RE.test(stack.profile)) errors.push(`profile 必须是 kebab-case: ${stack.profile}`)
    if (!stack.home || typeof stack.home !== 'string') errors.push('home 必填（DSH_HOME，相对 stack 文件）')
  } else {
    if (stack.home != null && typeof stack.home !== 'string') errors.push('home 必须是 string')
    if (stack.profile != null && typeof stack.profile !== 'string') errors.push('profile 必须是 string')
    if (!isObject(stack.domain)) errors.push('domain 型 stack 必须有 domain 对象')
    else {
      if (typeof stack.domain.source !== 'string' || !stack.domain.source) errors.push('domain.source 必填（domain 目录或 dsh-domain.json）')
      else {
        const source = abs(stack.dir || path.dirname(stack.path || path.resolve('dsh-stack.json')), stack.domain.source)
        if (!existsSync(source)) errors.push(`domain.source 不存在: ${source}`)
        else if (!existsSync(path.join(source, 'dsh-domain.json')) && !existsSync(path.join(source, 'domain.json'))) {
          errors.push(`domain.source 下没有 dsh-domain.json / domain.json: ${source}`)
        }
      }
      for (const key of ['profile', 'runtimeId', 'name', 'storeRoot']) {
        if (stack.domain[key] != null && typeof stack.domain[key] !== 'string') errors.push(`domain.${key} 必须是 string`)
      }
      if (stack.domain.recreate != null && typeof stack.domain.recreate !== 'boolean') errors.push('domain.recreate 必须是 boolean')
      if (stack.domain.requires != null && !isObject(stack.domain.requires)) errors.push('domain.requires 必须是对象')
      if (stack.domain.scope != null && !isObject(stack.domain.scope)) errors.push('domain.scope 必须是对象')
      if (stack.domain.env != null && (!isObject(stack.domain.env) || Object.values(stack.domain.env).some((value) => typeof value !== 'string'))) {
        errors.push('domain.env 必须是 string -> string 对象')
      }
      if (stack.domain.model != null && typeof stack.domain.model !== 'boolean' && !isObject(stack.domain.model)) {
        errors.push('domain.model 必须是 boolean 或对象')
      }
      if (stack.domain.workspaceController != null && typeof stack.domain.workspaceController !== 'boolean' && !isObject(stack.domain.workspaceController)) {
        errors.push('domain.workspaceController 必须是 boolean 或对象')
      }
    }
    if (stack.plugins != null) warnings.push('domain 型 stack 忽略 plugins（插件由 domain/suite 决定）')
    if (stack.services != null) warnings.push('domain 型 stack 忽略 services（服务由 suite services.json 决定）')
  }
  if (stack.workspace != null && typeof stack.workspace !== 'string') errors.push('workspace 必须是 string')
  if (stack.stateDir != null && typeof stack.stateDir !== 'string') errors.push('stateDir 必须是 string')
  if (stack.harnessDir != null && typeof stack.harnessDir !== 'string') errors.push('harnessDir 必须是 string')
  if (stack.brokerDir != null && typeof stack.brokerDir !== 'string') errors.push('brokerDir 必须是 string')
  if (stack.env != null && (!isObject(stack.env) || Object.values(stack.env).some((value) => typeof value !== 'string'))) {
    errors.push('env 必须是 string -> string 对象')
  }
  if (stack.open != null && typeof stack.open !== 'boolean') errors.push('open 必须是 boolean')
  if (paths.profilePackage && existsSync(paths.profilePackage)) {
    const parsed = safeJson(paths.profilePackage)
    if (parsed.error) errors.push(`profile package.json 解析失败: ${parsed.error}`)
  }

  if (stack.ports != null) {
    if (!isObject(stack.ports)) errors.push('ports 必须是对象')
    else {
      for (const key of ['broker', 'proxy', 'upstream', 'content']) checkPort(stack.ports[key], `ports.${key}`, errors)
      if (stack.ports.services != null) {
        if (!isObject(stack.ports.services)) errors.push('ports.services 必须是对象')
        else for (const [id, value] of Object.entries(stack.ports.services)) {
          checkPort(value, `ports.services.${id}`, errors)
        }
      }
    }
  }

  const bundles = kind === 'profile' ? stack.plugins?.bundles : null
  if (kind === 'profile' && stack.plugins != null && !isObject(stack.plugins)) errors.push('plugins 必须是对象')
  if (bundles != null) {
    if (!Array.isArray(bundles)) errors.push('plugins.bundles 必须是数组')
    else {
      bundles.forEach((entry, index) => {
        if (typeof entry === 'string') {
          if (!entry) errors.push(`plugins.bundles[${index}] 不能为空`)
          return
        }
        if (!isObject(entry)) {
          errors.push(`plugins.bundles[${index}] 必须是 string 或 {name,path|version}`)
          return
        }
        if (typeof entry.name !== 'string' || !entry.name) errors.push(`plugins.bundles[${index}].name 必填`)
        if (entry.path != null && typeof entry.path !== 'string') errors.push(`plugins.bundles[${index}].path 必须是 string`)
        if (entry.version != null && typeof entry.version !== 'string') errors.push(`plugins.bundles[${index}].version 必须是 string`)
        if (entry.path != null && entry.version != null) errors.push(`plugins.bundles[${index}] 不能同时有 path 和 version`)
        if (entry.path) {
          const pluginDir = abs(stack.dir, entry.path)
          const pkgFile = path.join(pluginDir, 'package.json')
          if (!existsSync(pkgFile)) {
            errors.push(`plugins.bundles[${index}].path 下没有 package.json: ${pluginDir}`)
          } else {
            const pkg = safeJson(pkgFile).value
            if (pkg?.name && pkg.name !== entry.name) {
              warnings.push(`plugins.bundles[${index}] name=${entry.name} 与 package.json 的 ${pkg.name} 不一致`)
            }
            const patch = pkg?.dsh?.bundle?.patch
            const patches = Array.isArray(patch) ? patch : patch ? [patch] : []
            if (!patches.length) warnings.push(`plugins.bundles[${index}] ${entry.name} 没有 dsh.bundle.patch，加载时会被跳过`)
            for (const rel of patches) {
              if (!existsSync(path.join(pluginDir, rel))) errors.push(`plugins.bundles[${index}] 的 patch 不存在: ${rel}`)
            }
          }
        }
      })
    }
  }

  if (kind === 'profile') for (const key of ['dependencies', 'overrides']) {
    const value = stack.plugins?.[key]
    if (value == null) continue
    if (!isObject(value)) errors.push(`plugins.${key} 必须是对象`)
  }

  const services = kind === 'profile' ? stack.services : null
  if (services != null) {
    if (!Array.isArray(services)) errors.push('services 必须是数组')
    else {
      const ids = new Set()
      services.forEach((service, index) => {
        if (!isObject(service)) {
          errors.push(`services[${index}] 必须是对象`)
          return
        }
        if (typeof service.id !== 'string' || !service.id) errors.push(`services[${index}].id 必填`)
        else if (!ID_RE.test(service.id)) errors.push(`services[${index}].id 非法: ${service.id}`)
        else if (ids.has(service.id)) errors.push(`services[${index}].id 重复: ${service.id}`)
        else ids.add(service.id)

        const hasCmd = Array.isArray(service.cmd)
        const hasPath = typeof service.path === 'string' && service.path
        if (!hasCmd && !hasPath) errors.push(`services[${index}] 需要 cmd 数组或 path`)
        if (hasCmd && hasPath) errors.push(`services[${index}] 不能同时有 cmd 和 path`)
        if (hasCmd) {
          if (service.cmd.length === 0 || service.cmd.some((item) => typeof item !== 'string' || !item)) {
            errors.push(`services[${index}].cmd 必须是非空 string[]`)
          }
        }
        if (hasPath) {
          const script = abs(stack.dir, service.path)
          if (!existsSync(script)) errors.push(`services[${index}].path 不存在: ${script}`)
          if (service.args != null && (!Array.isArray(service.args) || service.args.some((item) => typeof item !== 'string'))) {
            errors.push(`services[${index}].args 必须是 string[]`)
          }
        }
        if (service.ports != null) {
          if (!isObject(service.ports)) errors.push(`services[${index}].ports 必须是对象`)
          else for (const [name, value] of Object.entries(service.ports)) {
            checkPort(value, `services[${index}].ports.${name}`, errors)
          }
        }
        if (service.env != null && (!isObject(service.env) || Object.values(service.env).some((value) => typeof value !== 'string'))) {
          errors.push(`services[${index}].env 必须是 string -> string 对象`)
        }
        if (service.url != null && typeof service.url !== 'string') errors.push(`services[${index}].url 必须是 string`)
        if (service.healthPath != null && typeof service.healthPath !== 'string') errors.push(`services[${index}].healthPath 必须是 string`)
        if (service.keepAlive != null && typeof service.keepAlive !== 'boolean') errors.push(`services[${index}].keepAlive 必须是 boolean`)
        if (service.requires != null && (!Array.isArray(service.requires) || service.requires.some((item) => typeof item !== 'string'))) {
          errors.push(`services[${index}].requires 必须是 string[]`)
        }
      })
    }
  }

  if (paths.harnessDir && !existsSync(paths.harnessDir)) errors.push(`harnessDir 不存在: ${paths.harnessDir}`)
  if (paths.brokerDir && !existsSync(paths.brokerDir)) errors.push(`brokerDir 不存在: ${paths.brokerDir}`)

  return { ok: errors.length === 0, errors, warnings }
}

function compileProfile(stack, paths, warnings) {
  const existingFile = paths.profilePackage
  const existing = existsSync(existingFile) ? safeJson(existingFile).value : null
  const currentDeps = isObject(existing?.dependencies) ? { ...existing.dependencies } : {}
  const dependencies = { ...currentDeps }
  const bundles = []
  const entries = []
  const missingInstalled = []
  const stackDeclared = new Set() // stack 本次声明的依赖名（用于识别历史残留）

  for (const raw of stack.plugins?.bundles || []) {
    if (typeof raw === 'string') {
      bundles.push(raw)
      entries.push({ name: raw, kind: 'string' })
      if (!raw.startsWith('@deepseek-ai/')) {
        const inProfile = existsSync(path.join(paths.profileDir, 'node_modules', raw, 'package.json'))
        if (!inProfile) missingInstalled.push(raw)
      }
      continue
    }
    const name = raw.name
    bundles.push(name)
    if (raw.path) {
      dependencies[name] = normalizeDependencySpec({ path: raw.path }, stack.dir)
      entries.push({ name, kind: 'link', path: abs(stack.dir, raw.path) })
    } else if (raw.version) {
      dependencies[name] = raw.version
      entries.push({ name, kind: 'registry', version: raw.version })
    } else {
      entries.push({ name, kind: 'installed' })
    }
    stackDeclared.add(name)
  }

  for (const [name, spec] of Object.entries(stack.plugins?.dependencies || {})) {
    const normalized = normalizeDependencySpec(spec, stack.dir)
    if (!normalized) {
      warnings.push(`plugins.dependencies.${name} 无法解析，已忽略`)
      continue
    }
    dependencies[name] = normalized
    stackDeclared.add(name)
  }

  // 合并语义保留（不删既有依赖），但 stack 未声明的历史残留必须可见：
  // 失效 link 静默累积会让 pnpm install 反复产生 .ignored_* 并拖慢排查
  for (const name of Object.keys(currentDeps)) {
    if (!stackDeclared.has(name)) {
      const spec = String(currentDeps[name])
      const dead = spec.startsWith('link:') && !existsSync(spec.slice(5))
      warnings.push(`profile 依赖 ${name} 不在 stack 声明中${dead ? '，且其 link 路径已不存在（失效残留，建议删除）' : '（历史残留；如不需要请从 profile package.json 删除）'}`)
    }
  }

  const overrides = {}
  for (const [name, spec] of Object.entries(stack.plugins?.overrides || {})) {
    const normalized = normalizeDependencySpec(spec, stack.dir)
    if (normalized) overrides[name] = normalized
  }

  const packageJson = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        name: `dsh-profile-${stack.profile}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }
  packageJson.dependencies = { ...(isObject(packageJson.dependencies) ? packageJson.dependencies : {}), ...dependencies }
  packageJson.dsh = { ...(isObject(packageJson.dsh) ? packageJson.dsh : {}), profile: { ...(packageJson.dsh?.profile || {}), bundles } }
  if (Object.keys(overrides).length) {
    packageJson.pnpm = { ...(isObject(packageJson.pnpm) ? packageJson.pnpm : {}), overrides: { ...(packageJson.pnpm?.overrides || {}), ...overrides } }
  }

  const beforeText = existing ? JSON.stringify(existing) : ''
  const changed = beforeText !== JSON.stringify(packageJson)
  const dependencyChanged = Object.entries(dependencies)
    .some(([name, spec]) => currentDeps[name] !== spec)
  const missingLinks = entries
    .filter((entry) => entry.kind === 'link')
    .filter((entry) => !existsSync(path.join(paths.profileDir, 'node_modules', entry.name, 'package.json')))
  const installNeeded = stack.plugins?.install !== false && (dependencyChanged || missingLinks.length > 0)
  if (missingInstalled.length) {
    warnings.push(`以下 bundle 未在 profile node_modules 中找到（假定由 dsh 安装提供）: ${missingInstalled.join(', ')}`)
  }

  // 插件配置通道：stack.plugins.configs → profile patch 的受管覆盖行。
  // 先把插件自身默认 config 读出来做深合并（dsh 的覆盖是整键替换，不合并会丢默认值）。
  let configPatches = { rows: [], details: [] }
  const configs = stack.plugins?.configs
  if (Array.isArray(configs) && configs.length) {
    const resolveBundle = (name) => {
      const entry = entries.find((item) => item.name === name)
      if (entry?.kind === 'link' && entry.path) return { dir: entry.path, kind: 'link' }
      const inProfile = path.join(paths.profileDir, 'node_modules', name)
      if (existsSync(path.join(inProfile, 'package.json'))) return { dir: inProfile, kind: 'profile' }
      return null
    }
    configPatches = buildConfigPatches({ configs, resolveBundle })
    const cfgCtx = { stackDir: stack.dir, home: paths.home, profile: stack.profile, ports: stack.ports || {} }
    configPatches.rows = configPatches.rows.map((row) =>
      row.config ? { ...row, config: expandDeep(row.config, cfgCtx) } : row)
  }

  return {
    dir: paths.profileDir,
    packageFile: existingFile,
    patchFile: paths.profilePatch,
    packageJson,
    existing,
    bundles,
    entries,
    dependencies: packageJson.dependencies,
    changed,
    dependencyChanged,
    installNeeded,
    missingLinks: missingLinks.map((entry) => entry.name),
    configPatches,
  }
}

function compileServices(stack, paths, warnings) {
  const ctx = {
    stackDir: stack.dir,
    home: paths.home,
    profile: stack.profile,
    ports: stack.ports || {},
  }
  const services = []
  for (const service of stack.services || []) {
    const ports = service.ports
      ? Object.fromEntries(Object.entries(service.ports).map(([name, value]) => [name, value]))
      : { main: stack.ports?.services?.[service.id] ?? 'auto' }

    let cmd
    if (service.path) {
      const script = abs(stack.dir, service.path)
      const args = (service.args || []).map((item) => expandKnown(item, ctx))
      const hasPort = args.some((item) => item === '--port' || item === '-p' || item.startsWith('--port='))
      if (!hasPort) args.push('--port', '${PORT}')
      cmd = ['node', script, ...args]
    } else {
      cmd = (service.cmd || []).map((item) => expandKnown(item, ctx))
    }

    const env = {}
    for (const [key, value] of Object.entries({ ...(stack.env || {}), ...(service.env || {}) })) {
      env[key] = expandKnown(value, ctx)
    }

    const url = expandKnown(service.url || 'http://127.0.0.1:${PORT}', ctx)
    const cwd = service.cwd ? abs(stack.dir, expandKnown(service.cwd, ctx)) : ''
    const spec = {
      id: service.id,
      cmd,
      env,
      ...(cwd ? { cwd } : {}),
      ports,
      ...(url ? { url } : {}),
      healthPath: service.healthPath || '/healthz',
      keepAlive: service.keepAlive !== false,
      ...(service.requires?.length ? { requires: service.requires.map((item) => expandKnown(item, ctx)) } : {}),
      ...(service.logFile ? { logFile: expandKnown(service.logFile, ctx) } : {}),
    }
    if (JSON.stringify(spec).includes('${ports.')) {
      warnings.push(`服务 ${service.id} 引用了 auto 端口（${'${ports.*}'}）；请给 ports 固定数值，否则 URL 无法在编译期确定`)
    }
    services.push(spec)
  }
  return services
}

export function compileStack(stack) {
  const paths = stack.paths || resolveStackPaths(stack)
  const validation = validateStack({ ...stack, paths })
  if (!validation.ok) {
    return { valid: false, errors: validation.errors, warnings: validation.warnings, stack, paths }
  }
  const warnings = [...validation.warnings]
  const kind = stackKind(stack)
  if (kind === 'domain') {
    const domain = {
      source: paths.domainSource,
      runtimeId: paths.runtimeId,
      storeRoot: paths.storeRoot,
      profile: stack.profile || stack.domain?.profile || '',
      name: stack.domain?.name || stack.name,
      recreate: !!stack.domain?.recreate,
      requires: stack.domain?.requires,
      scope: stack.domain?.scope,
      model: stack.domain?.model,
      workspaceController: stack.domain?.workspaceController,
      env: { ...(stack.domain?.env || {}), ...(stack.env || {}) },
    }
    return {
      valid: true,
      kind,
      errors: [],
      warnings,
      stack,
      paths,
      domain,
      profile: null,
      services: [],
      manifest: null,
      config: {
        kind: 'domain',
        name: stack.name,
        runtimeId: paths.runtimeId,
        storeRoot: paths.storeRoot,
        source: paths.domainSource,
        ports: stack.ports || {},
        env: domain.env,
        open: !!stack.open,
      },
    }
  }
  const profile = compileProfile(stack, paths, warnings)
  const services = compileServices(stack, paths, warnings)
  const manifest = {
    file: paths.manifest,
    content: {
      _generatedBy: 'dsh-stack-kit',
      _stack: stack.path,
      services,
    },
  }
  return {
    valid: true,
    kind,
    errors: [],
    warnings,
    stack,
    paths,
    profile,
    services,
    manifest,
    config: {
      name: stack.name,
      profile: stack.profile,
      home: paths.home,
      workspace: paths.workspace,
      stateDir: paths.stateDir,
      ports: stack.ports || {},
      manifest: paths.manifest,
      env: stack.env || {},
      open: !!stack.open,
    },
  }
}

function serviceMap(services) {
  return new Map((services || []).map((service) => [service.id, service]))
}

function readTextIfExists(file) {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

export function planStack(stack) {
  const compiled = compileStack(stack)
  if (!compiled.valid) return { ...compiled, changes: null }
  const paths = compiled.paths
  if (compiled.kind === 'domain') {
    const runtimeFile = path.join(paths.storeRoot, 'runtimes', paths.runtimeId, 'runtime.json')
    const exists = existsSync(runtimeFile)
    return {
      ...compiled,
      changes: {
        domain: {
          source: paths.domainSource,
          runtimeId: paths.runtimeId,
          storeRoot: paths.storeRoot,
          exists,
          changed: !exists,
        },
      },
    }
  }
  const currentManifest = existsSync(paths.manifest) ? safeJson(paths.manifest).value : null
  const currentServices = currentManifest?.services || []
  const currentBundles = compiled.profile.existing?.dsh?.profile?.bundles || []
  const currentDeps = compiled.profile.existing?.dependencies || {}
  const desiredDeps = compiled.profile.dependencies || {}

  const addedDeps = []
  const updatedDeps = []
  for (const [name, spec] of Object.entries(desiredDeps)) {
    if (!(name in currentDeps)) addedDeps.push(name)
    else if (currentDeps[name] !== spec) updatedDeps.push(name)
  }

  const before = serviceMap(currentServices)
  const after = serviceMap(compiled.services)
  const serviceChanges = []
  const ids = new Set([...before.keys(), ...after.keys()])
  for (const id of ids) {
    const a = before.get(id)
    const b = after.get(id)
    if (!a) serviceChanges.push({ id, change: 'added' })
    else if (!b) serviceChanges.push({ id, change: 'removed' })
    else if (JSON.stringify(a) !== JSON.stringify(b)) serviceChanges.push({ id, change: 'changed' })
  }

  return {
    ...compiled,
    changes: {
      profileBundles: {
        from: currentBundles,
        to: compiled.profile.bundles,
        changed: JSON.stringify(currentBundles) !== JSON.stringify(compiled.profile.bundles),
      },
      dependencies: { added: addedDeps, updated: updatedDeps },
      services: serviceChanges,
      manifest: {
        file: paths.manifest,
        exists: existsSync(paths.manifest),
        changed: JSON.stringify(currentServices) !== JSON.stringify(compiled.services),
      },
      pluginConfigs: {
        file: paths.profilePatch,
        rows: compiled.profile.configPatches?.rows || [],
        changed: JSON.stringify(
          parseManagedBlock(readManagedBlock(readTextIfExists(paths.profilePatch))) || [],
        ) !== JSON.stringify(compiled.profile.configPatches?.rows || []),
      },
      installNeeded: compiled.profile.installNeeded,
    },
  }
}

function runPnpmInstall(dir) {
  // Windows 用 cmd.exe /c 执行 pnpm.cmd；不要用 shell:true + args（Node 会告警未转义）。
  const isWindows = process.platform === 'win32'
  const bin = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'pnpm'
  const args = isWindows ? ['/d', '/s', '/c', 'pnpm install'] : ['install']
  const result = spawnSync(bin, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  })
  if (result.error) throw new Error(`pnpm install 无法执行: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`pnpm install 失败（${result.status}）:\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
}

/**
 * 物化 stack：写 profile package.json / 空 patch（仅在缺失时）/ 生成 broker 清单。
 * @param {object} stack - loadStack() 的返回值
 * @param {{install?: boolean}} options - install=false 时跳过 pnpm install
 */
export function applyStack(stack, options = {}) {
  const plan = planStack(stack)
  if (!plan.valid) {
    const error = new Error(`stack 校验失败:\n- ${plan.errors.join('\n- ')}`)
    error.code = 'STACK_INVALID'
    error.errors = plan.errors
    throw error
  }
  if (plan.kind === 'domain') {
    const error = new Error('domain 型 stack 需要 dshd 创建 runtime：用 `dshd stack apply --stack <file>` 或 `dshd start --stack <file>`')
    error.code = 'DOMAIN_STACK_REQUIRES_LAUNCHER'
    throw error
  }
  const paths = plan.paths
  const install = options.install !== false
  mkdirSync(paths.profileDir, { recursive: true })
  let profileWritten = false
  if (plan.profile.changed) {
    writeJsonAtomic(paths.profilePackage, plan.profile.packageJson)
    profileWritten = true
  }
  // profile patch：有 configs 时写受管区块（保留用户自己写的行）；没有时仅在文件缺失时落空占位。
  const configRows = plan.profile.configPatches?.rows || []
  let patchWritten = false
  if (configRows.length || Array.isArray(stack.plugins?.configs)) {
    const result = writeManagedBlock(paths.profilePatch, configRows)
    patchWritten = result.changed
  } else if (!existsSync(paths.profilePatch)) {
    writeFileSync(paths.profilePatch, '# dsh-stack profile: 插件行由 bundles 提供；本文件是用户覆盖层\n[]\n', 'utf8')
    patchWritten = true
  }
  let installSkipped = false
  if (install && plan.profile.installNeeded) {
    runPnpmInstall(paths.profileDir)
  } else if (!install && plan.profile.installNeeded) {
    installSkipped = true
  }
  let manifestWritten = false
  if (!existsSync(paths.manifest) || plan.changes.manifest.changed) {
    writeJsonAtomic(paths.manifest, plan.manifest.content)
    manifestWritten = true
  }
  return {
    ...plan,
    applied: true,
    profileWritten,
    patchWritten,
    manifestWritten,
    manifestFile: paths.manifest,
    profilePackageFile: paths.profilePackage,
    installSkipped,
  }
}

/** 便于 CLI 打印的简要摘要（不含完整 services/packageJson）。 */
export function summarizePlan(plan) {
  if (!plan.valid) {
    return { valid: false, errors: plan.errors, warnings: plan.warnings }
  }
  if (plan.kind === 'domain') {
    return {
      valid: true,
      kind: 'domain',
      stack: plan.stack.path,
      domain: plan.domain,
      changes: plan.changes,
      warnings: plan.warnings,
    }
  }
  return {
    valid: true,
    kind: 'profile',
    stack: plan.stack.path,
    profile: plan.profile.packageFile,
    bundles: plan.profile.bundles,
    dependenciesAdded: plan.changes?.dependencies?.added || [],
    dependenciesUpdated: plan.changes?.dependencies?.updated || [],
    services: plan.services.map((service) => service.id),
    serviceChanges: plan.changes?.services || [],
    manifest: plan.manifest.file,
    manifestChanged: plan.changes?.manifest?.changed ?? true,
    installNeeded: plan.profile.installNeeded,
    warnings: plan.warnings,
  }
}

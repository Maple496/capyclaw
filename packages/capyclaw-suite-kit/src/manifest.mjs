/**
 * Suite manifest：读取与静态校验。
 *
 * manifest 是组合的唯一真源；cordis.patch.yml 由 rows 生成，不手写。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const SUITE_FILENAMES = ['dsh-suite.json', 'suite.json']
export const ROLES = new Set(['runtime', 'skills', 'provider', 'ui', 'bridge', 'support'])
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RANGE_RE = /^(?:\^|~|>=|<=|>|<|=)?\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function isValidRange(range) {
  if (typeof range !== 'string') return false
  const value = range.trim()
  if (value === '*' || value === 'latest') return true
  return RANGE_RE.test(value)
}

/** 判断 exact 版本是否满足简单 range（^ ~ >= <= > < = 或精确）。 */
export function versionSatisfies(range, version) {
  if (!isValidRange(range) || !VERSION_RE.test(String(version || ''))) return false
  const raw = String(range).trim()
  if (raw === '*' || raw === 'latest') return true
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return false
  const [, op = '=', rawMajor, rawMinor, rawPatch] = match
  const major = Number(rawMajor)
  const minor = Number(rawMinor)
  const patch = Number(rawPatch)
  const [vm, vn, vp] = String(version).split('.').map(Number)
  const cmp = (vm - major) || (vn - minor) || (vp - patch)
  if (op === '^') return cmp >= 0 && vm === major
  if (op === '~') return cmp >= 0 && vm === major && vn === minor
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  return cmp === 0
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 从文件或目录定位 suite manifest。 */
export function findSuiteManifest(input) {
  let abs = resolve(input)
  /* junction/symlink 安装时 components 的相对路径必须以真实目录为基准，
   * 否则 ../../../../packages/* 会解析到 profile 的 node_modules 外面。 */
  try { abs = realpathSync(abs) } catch { /* 不存在时保留原路径，下面给出准确报错 */ }
  if (!existsSync(abs)) throw new Error(`suite 路径不存在: ${abs}`)
  if (statSync(abs).isFile()) return abs
  for (const name of SUITE_FILENAMES) {
    const file = join(abs, name)
    if (existsSync(file)) return file
  }
  throw new Error(`目录里没有 ${SUITE_FILENAMES.join(' / ')}: ${abs}`)
}

export function loadSuiteManifest(input, options = {}) {
  const file = findSuiteManifest(input)
  const dir = dirname(file)
  const raw = readJson(file)
  const components = Array.isArray(raw.components) ? raw.components : []
  if (options.expand === false || !components.length) {
    return { file, dir, manifest: raw }
  }
  const seen = options.seen || new Set()
  if (seen.has(file)) throw new Error(`suite components 循环引用: ${file}`)
  seen.add(file)
  const manifest = {
    ...raw,
    packages: { ...(raw.packages || {}) },
    rows: [],
    checks: [...(raw.checks || [])],
  }
  const rawRows = [...(raw.rows || [])]
  for (const component of components) {
    if (typeof component !== 'string' || !component) throw new Error(`${file}: components 必须是字符串数组`)
    const loaded = loadSuiteManifest(resolve(dir, component), { seen })
    for (const [name, entry] of Object.entries(loaded.manifest.packages || {})) {
      if (manifest.packages[name]) {
        if (manifest.packages[name].version !== entry.version || manifest.packages[name].role !== entry.role) {
          throw new Error(`suite components 包冲突: ${name}（${manifest.name}）`)
        }
        continue
      }
      const path = entry.path ? relative(dir, resolve(loaded.dir, entry.path)) : entry.path
      manifest.packages[name] = { ...entry, path }
    }
    manifest.rows.push(...(loaded.manifest.rows || []))
    manifest.checks.push(...(loaded.manifest.checks || []))
  }
  /* 组件行必须先于本 suite 行：功能插件在 apply 时需要 ctx.* 已就绪。 */
  manifest.rows.push(...rawRows)
  delete manifest.components
  return { file, dir, manifest }
}

/** 取 semver range 的 major；无法判断时返回 null。 */
export function majorOf(range) {
  if (typeof range !== 'string') return null
  if (range.trim() === '*' || range.trim() === 'latest') return null
  const match = /(?:^|[^\d])(\d+)(?:\.\d+)?/.exec(range)
  return match ? Number(match[1]) : null
}

export function validateSuiteManifest(manifest, options = {}) {
  const errors = []
  const warnings = []
  const add = (list, message) => list.push(message)
  const baseDir = options.baseDir || null

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest 必须是 object'], warnings }
  }
  if (!NAME_RE.test(manifest.name || '')) add(errors, 'name 必须是 kebab-case')
  if (!VERSION_RE.test(manifest.version || '')) add(errors, 'version 必须是 semver（如 2.0.0）')
  if (manifest.title != null && typeof manifest.title !== 'string') add(errors, 'title 必须是字符串')
  if (manifest.description != null && typeof manifest.description !== 'string') add(errors, 'description 必须是字符串')
  if (manifest.components != null) {
    if (!Array.isArray(manifest.components) || manifest.components.some((item) => typeof item !== 'string' || !item)) {
      add(errors, 'components 必须是字符串数组')
    }
  }

  const packages = manifest.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages) || Object.keys(packages).length === 0) {
    add(errors, 'packages 必须是非空 object')
  } else {
    for (const [name, pkg] of Object.entries(packages)) {
      if (!name || typeof name !== 'string') add(errors, 'packages 的键必须是包名')
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        add(errors, `packages.${name} 必须是 object`)
        continue
      }
      if (!ROLES.has(pkg.role)) add(errors, `packages.${name}.role 非法: ${pkg.role}`)
      if (typeof pkg.version !== 'string' || !pkg.version) add(errors, `packages.${name}.version 必须是非空字符串`)
      else if (!isValidRange(pkg.version)) add(errors, `packages.${name}.version 不是合法 semver range: ${pkg.version}`)
      if (pkg.path != null && (typeof pkg.path !== 'string' || !pkg.path)) add(errors, `packages.${name}.path 必须是非空字符串`)
      if (baseDir && typeof pkg.path === 'string' && pkg.path) {
        const dir = resolve(baseDir, pkg.path)
        if (!existsSync(join(dir, 'package.json'))) {
          add(errors, `packages.${name}.path 指向的目录没有 package.json: ${dir}`)
        }
      }
      if (pkg.required != null && typeof pkg.required !== 'boolean') add(errors, `packages.${name}.required 必须是 boolean`)
      if (pkg.requires != null) {
        if (typeof pkg.requires !== 'object' || Array.isArray(pkg.requires)) add(errors, `packages.${name}.requires 必须是 object`)
        else for (const [dep, range] of Object.entries(pkg.requires)) {
          if (dep === 'capabilities') {
            if (typeof range !== 'object' || Array.isArray(range)) {
              add(errors, `packages.${name}.requires.capabilities 必须是 object`)
            } else for (const [cap, capRange] of Object.entries(range)) {
              if (typeof capRange !== 'string' || !capRange) add(errors, `packages.${name}.requires.capabilities.${cap} 必须是非空字符串`)
              else if (!isValidRange(capRange)) add(errors, `packages.${name}.requires.capabilities.${cap} 不是合法 semver range: ${capRange}`)
            }
          } else if (typeof range !== 'string' || !range) {
            add(errors, `packages.${name}.requires.${dep} 必须是非空字符串`)
          } else if (!isValidRange(range)) {
            add(errors, `packages.${name}.requires.${dep} 不是合法 semver range: ${range}`)
          }
        }
      }
      if (pkg.provides != null) {
        if (typeof pkg.provides !== 'object' || Array.isArray(pkg.provides)) {
          add(errors, `packages.${name}.provides 必须是 object`)
        } else {
          for (const key of ['tools', 'skills', 'services']) {
            if (pkg.provides[key] != null && (!Array.isArray(pkg.provides[key]) || pkg.provides[key].some((v) => typeof v !== 'string'))) {
              add(errors, `packages.${name}.provides.${key} 必须是 string[]`)
            }
          }
          if (pkg.provides.capabilities != null) {
            if (typeof pkg.provides.capabilities !== 'object' || Array.isArray(pkg.provides.capabilities)) {
              add(errors, `packages.${name}.provides.capabilities 必须是 object`)
            } else for (const [cap, version] of Object.entries(pkg.provides.capabilities)) {
              if (typeof version !== 'string' || !version) add(errors, `packages.${name}.provides.capabilities.${cap} 必须是非空字符串`)
            }
          }
          if (pkg.provides.ports != null && (!Array.isArray(pkg.provides.ports) || pkg.provides.ports.some((v) => !Number.isInteger(v) || v < 1 || v > 65535))) {
            add(errors, `packages.${name}.provides.ports 必须是 1..65535 的整数数组`)
          } else if (Array.isArray(pkg.provides.ports)) {
            const seenPorts = new Set()
            for (const port of pkg.provides.ports) {
              if (seenPorts.has(port)) add(errors, `packages.${name}.provides.ports 重复: ${port}`)
              seenPorts.add(port)
            }
          }
        }
      }
    }
  }

  const rows = manifest.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    add(errors, 'rows 必须是非空数组')
  } else {
    const ids = new Set()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        add(errors, 'rows 的每一项必须是 object')
        continue
      }
      if (!NAME_RE.test(row.id || '')) add(errors, `row.id 非法: ${row.id}`)
      if (ids.has(row.id)) add(errors, `row.id 重复: ${row.id}`)
      ids.add(row.id)
      if (typeof row.name !== 'string' || !row.name) add(errors, `row ${row.id} 缺少 name`)
      if (row.disabled != null && typeof row.disabled !== 'boolean') add(errors, `row ${row.id}.disabled 必须是 boolean`)
      if (row.config != null && (typeof row.config !== 'object' || Array.isArray(row.config))) add(errors, `row ${row.id}.config 必须是 object`)
    }
  }

  if (manifest.checks != null) {
    if (!Array.isArray(manifest.checks)) add(errors, 'checks 必须是数组')
    else {
      const ids = new Set()
      for (const check of manifest.checks) {
        if (!check || typeof check !== 'object' || Array.isArray(check)) {
          add(errors, 'checks 的每一项必须是 object')
          continue
        }
        if (!check.id || ids.has(check.id)) add(errors, `check.id 缺失或重复: ${check.id}`)
        ids.add(check.id)
        if (check.type === 'http') {
          if (typeof check.url !== 'string' || !check.url) add(errors, `check ${check.id} 缺少 url`)
        } else if (check.type === 'contract') {
          if (typeof check.url !== 'string' || !check.url) add(errors, `check ${check.id} 缺少 url`)
          if (typeof check.tool !== 'string' || !check.tool) add(errors, `check ${check.id} 缺少 tool`)
          if (!Number.isInteger(check.major) || check.major < 0) add(errors, `check ${check.id}.major 必须是非负整数`)
        } else {
          add(errors, `check ${check.id} 的 type 非法: ${check.type}`)
        }
      }
    }
  }

  /* 包内 rows 的 name 不一定在 packages 里（可以是官方 mcp-client），只给提示。 */
  if (packages && rows) {
    for (const row of rows) {
      if (row && typeof row.name === 'string' && !packages[row.name]) {
        warnings.push(`row ${row.id} 引用外部包 ${row.name}（不在 packages 里，按已安装处理）`)
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

export function assertValidSuiteManifest(manifest, label = 'suite') {
  const result = validateSuiteManifest(manifest)
  if (!result.ok) throw new Error(`${label} 校验失败:\n- ${result.errors.join('\n- ')}`)
  return result
}

/** 解析 packages.<name>.path 为绝对目录。 */
export function packageDirOf(manifestDir, name, entry) {
  if (!entry || typeof entry.path !== 'string') return null
  return isAbsolute(entry.path) ? entry.path : resolve(manifestDir, entry.path)
}

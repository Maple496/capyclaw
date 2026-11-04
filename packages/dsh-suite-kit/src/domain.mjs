/**
 * Domain Pack：面向“某个工作领域”的组合入口。
 *
 * component = 一个可独立安装的 suite（内部可以再包含 plugin / skills / MCP）
 * domain    = 选择哪些 component 一起启动，以及 base profile / 端口 / 检查
 *
 * 启动时只为该 domain 生成 profile：base + web-app + 选中的 suite；
 * 未选中的插件、skill、MCP 不会进入该 profile。
 */
import fs from 'node:fs'
import path from 'node:path'
import { composeSuites } from './compose.mjs'
import { loadSuiteManifest } from './manifest.mjs'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const DOMAIN_FILENAMES = ['dsh-domain.json', 'domain.json']

export function findDomainManifest(input) {
  const abs = path.resolve(input)
  if (!fs.existsSync(abs)) throw new Error(`domain 路径不存在: ${abs}`)
  if (fs.statSync(abs).isFile()) return abs
  for (const name of DOMAIN_FILENAMES) {
    const file = path.join(abs, name)
    if (fs.existsSync(file)) return file
  }
  throw new Error(`目录里没有 ${DOMAIN_FILENAMES.join(' / ')}: ${abs}`)
}

export function loadDomainManifest(input) {
  const file = findDomainManifest(input)
  return { file, dir: path.dirname(file), manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

export function validateDomainManifest(manifest) {
  const errors = []
  const warnings = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['domain manifest 必须是 object'], warnings }
  }
  if (!NAME_RE.test(manifest.name || '')) errors.push('name 必须是 kebab-case')
  if (!VERSION_RE.test(manifest.version || '')) errors.push('version 必须是 semver')
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    errors.push('components 必须是非空数组')
  } else for (const component of manifest.components) {
    if (typeof component !== 'string' || !component) errors.push('components 必须是路径字符串数组')
  }
  if (manifest.baseBundles != null && (!Array.isArray(manifest.baseBundles) || manifest.baseBundles.some((v) => typeof v !== 'string'))) {
    errors.push('baseBundles 必须是 string[]')
  }
  if (manifest.profile != null && (typeof manifest.profile !== 'object' || Array.isArray(manifest.profile))) {
    errors.push('profile 必须是 object')
  }
  if (manifest.runtime != null) {
    if (typeof manifest.runtime !== 'object' || Array.isArray(manifest.runtime)) {
      errors.push('runtime 必须是 object')
    } else {
      if (manifest.runtime.driver != null && !['node', 'jobobject', 'docker', 'wsl'].includes(manifest.runtime.driver)) {
        errors.push(`runtime.driver 非法: ${manifest.runtime.driver}`)
      }
      for (const key of ['requires', 'scope']) {
        if (manifest.runtime[key] != null && (typeof manifest.runtime[key] !== 'object' || Array.isArray(manifest.runtime[key]))) {
          errors.push(`runtime.${key} 必须是 object`)
        }
      }
      if (manifest.runtime.bindings != null) {
        if (!Array.isArray(manifest.runtime.bindings)) errors.push('runtime.bindings 必须是数组')
        else for (const [index, binding] of manifest.runtime.bindings.entries()) {
          if (!binding || typeof binding !== 'object' || (!binding.row && !binding.package)) {
            errors.push(`runtime.bindings[${index}] 必须包含 row 或 package`)
          }
        }
      }
      for (const key of ['tools', 'services', 'capabilities']) {
        const list = manifest.runtime.requires?.[key]
        if (list != null && (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))) {
          errors.push(`runtime.requires.${key} 必须是 string[]`)
        }
      }
      const scope = manifest.runtime.scope
      if (scope != null) {
        if (scope.sessions != null && (typeof scope.sessions !== 'object' || Array.isArray(scope.sessions))) {
          errors.push('runtime.scope.sessions 必须是 object')
        }
        if (scope.files != null) {
          if (!Array.isArray(scope.files)) errors.push('runtime.scope.files 必须是数组')
          else for (const [index, entry] of scope.files.entries()) {
            if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
              errors.push(`runtime.scope.files[${index}].path 必须是非空字符串`)
            }
          }
        }
      }
    }
  }
  for (const key of ['removeRows', 'removeDependencies']) {
    if (manifest[key] != null && (!Array.isArray(manifest[key]) || manifest[key].some((v) => typeof v !== 'string'))) {
      errors.push(`${key} 必须是 string[]`)
    }
  }
  if (manifest.rowOverrides != null) {
    if (typeof manifest.rowOverrides !== 'object' || Array.isArray(manifest.rowOverrides)) {
      errors.push('rowOverrides 必须是 object')
    } else for (const [id, override] of Object.entries(manifest.rowOverrides)) {
      if (!override || typeof override !== 'object' || Array.isArray(override)) {
        errors.push(`rowOverrides.${id} 必须是 object`)
      } else if (override.config != null && (typeof override.config !== 'object' || Array.isArray(override.config))) {
        errors.push(`rowOverrides.${id}.config 必须是 object`)
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 解析 domain → suites → 组合结果。 */
export function resolveDomain(input) {
  const loaded = loadDomainManifest(input)
  const validation = validateDomainManifest(loaded.manifest)
  if (!validation.ok) throw new Error(`domain 校验失败:\n- ${validation.errors.join('\n- ')}`)
  const suites = loaded.manifest.components.map((component) => {
    const target = path.isAbsolute(component) ? component : path.resolve(loaded.dir, component)
    return loadSuiteManifest(target)
  })
  const composed = composeSuites(suites)
  if (!composed.ok) throw new Error(`domain 组合冲突:\n- ${composed.errors.join('\n- ')}`)
  const overrides = loaded.manifest.rowOverrides || {}
  const rows = composed.rows.map((row) => {
    const override = overrides[row.id]
    if (!override) return row
    return {
      ...row,
      ...override,
      config: override.config !== undefined ? override.config : row.config,
    }
  })
  return { ...loaded, suites, composed: { ...composed, rows } }
}


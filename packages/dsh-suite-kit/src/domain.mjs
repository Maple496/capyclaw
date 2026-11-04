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
import { fileURLToPath } from 'node:url'
import { composeSuites, renderCordisPatch } from './compose.mjs'
import { loadSuiteManifest, validateSuiteManifest } from './manifest.mjs'
import { defaultDshHome, installSuites, profileDirOf } from './profile.mjs'

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

/** 生成 profile 最后一层的 row 覆盖（用于换端口、换 URL）。 */
export function renderRowOverrides(overrides) {
  const lines = ['# 由 dsh-domain 生成：domain row overrides', '']
  for (const [id, override] of Object.entries(overrides || {})) {
    lines.push(`- id: ${id}`)
    if (override.disabled !== undefined) lines.push(`  disabled: ${override.disabled ? 'true' : 'false'}`)
    if (override.config !== undefined) lines.push(`  config: ${JSON.stringify(override.config)}`)
  }
  return lines.join('\n') + '\n'
}

function applyRowOverrides(rows, overrides) {
  return rows.map((row) => {
    const override = overrides[row.id]
    if (!override) return row
    return {
      ...row,
      ...override,
      config: override.config !== undefined ? override.config : row.config,
    }
  })
}

/** 生成/更新该 domain 的专用 profile，只包含 base + 选中的 suite。 */
export function installDomain(options) {
  const resolved = resolveDomain(options.domainInput)
  const domain = resolved.manifest
  const overrides = {
    ...(domain.rowOverrides || {}),
    ...(options.rowOverrides || {}),
  }
  const rows = applyRowOverrides(resolved.composed.rows, overrides)
  const dshHome = options.dshHome || defaultDshHome()
  const profile = options.profile || domain.profile?.name || `domain-${domain.name}`
  const dir = profileDirOf(dshHome, profile)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: domain.baseBundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }, null, 2) + '\n')
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# domain profile: 组件行由各 suite bundle 提供\n[]\n')
  }

  const plan = installSuites({
    suiteInputs: resolved.suites.map((suite) => suite.dir),
    profile,
    dshHome,
    dryRun: options.dryRun,
    runPnpm: options.runPnpm,
    removeDependencies: options.removeDependencies || domain.removeDependencies,
    removeRows: options.removeRows || domain.removeRows,
  })
  if (!options.dryRun) {
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    current.dshDomain = {
      name: domain.name,
      version: domain.version,
      components: resolved.suites.map((suite) => suite.manifest.name),
      capabilities: resolved.composed.capabilities,
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n')
    const patchPath = path.join(dir, 'cordis.patch.yml')
    if (fs.existsSync(patchPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(patchPath, `${patchPath}.bak-${stamp}`)
    }
    fs.writeFileSync(patchPath, overrides && Object.keys(overrides).length
      ? renderRowOverrides(overrides)
      : '# domain profile: 组件行由各 suite bundle 提供\n[]\n')
  }
  return {
    ...plan,
    profile,
    domain: domain.name,
    profileMeta: domain.profile || {},
    components: resolved.suites.map((s) => s.manifest.name),
    composed: { ...resolved.composed, rows },
    rowOverrides: overrides,
  }
}

function copyPackage(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (file) => {
      const base = path.basename(file)
      if (['node_modules', '.git', '.relay-instance.lock', 'test', 'tests', '__tests__', 'examples', 'bench'].includes(base)) return false
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`stageDomain 不允许 symlink: ${file}`)
      return true
    },
  })
}

/** 只把选中组件复制成可带走的 domain pack，并附带 suite-kit。 */
export function stageDomain(options) {
  const resolved = resolveDomain(options.domainInput)
  const outDir = path.resolve(options.outDir)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, 'components'), { recursive: true })

  const copied = new Set()
  for (const suite of resolved.suites) {
    copyPackage(suite.dir, path.join(outDir, 'components', suite.manifest.name))
    const copiedManifest = path.join(outDir, 'components', suite.manifest.name, 'dsh-suite.json')
    if (fs.existsSync(copiedManifest)) {
      /* staged 使用展开后的 manifest：components 已经变成 components/<pkg> 物理目录。 */
      const copy = JSON.parse(JSON.stringify(loadSuiteManifest(suite.dir).manifest))
      copy.$schema = '../../kit/suite.schema.json'
      delete copy.components
      for (const [name, pkg] of Object.entries(copy.packages || {})) {
        if (pkg && pkg.path) pkg.path = `../${name}`
      }
      fs.writeFileSync(copiedManifest, JSON.stringify(copy, null, 2) + '\n')
    }
    copied.add(suite.manifest.name)
  }
  for (const pkg of resolved.composed.packages) {
    if (!pkg.entry.path) continue
    const src = path.resolve(pkg.dir, pkg.entry.path)
    if (copied.has(pkg.name)) continue
    copyPackage(src, path.join(outDir, 'components', pkg.name))
    copied.add(pkg.name)
  }

  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  copyPackage(kitRoot, path.join(outDir, 'kit'))

  /* runtime.mjs 依赖 dsh-plugin-kit 的对象仓库/中间层；放在与 kit 同级，
   * 保持 ../../dsh-plugin-kit 的相对路径在 staged bundle 里成立。 */
  const pluginKitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-plugin-kit')
  copyPackage(pluginKitRoot, path.join(outDir, 'dsh-plugin-kit'))
  const runtimeKitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-runtime-kit')
  copyPackage(runtimeKitRoot, path.join(outDir, 'dsh-runtime-kit'))
  /* runtime 启动 suite services.json 时按 ../../dsh-service-broker 找中间件；
   * staged domain 必须自带这一份，否则打包后 startRuntime 找不到 broker。 */
  const brokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-service-broker')
  copyPackage(brokerRoot, path.join(outDir, 'dsh-service-broker'))

  const domain = {
    ...resolved.manifest,
    $schema: './kit/domain.schema.json',
    components: resolved.suites.map((suite) => `./components/${suite.manifest.name}`),
  }
  fs.writeFileSync(path.join(outDir, 'domain.json'), JSON.stringify(domain, null, 2) + '\n')
  fs.writeFileSync(path.join(outDir, 'domain.lock.json'), JSON.stringify(resolved.composed, null, 2) + '\n')
  fs.writeFileSync(path.join(outDir, 'install.mjs'), `#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { installDomain } from './kit/src/index.mjs'
const profile = process.env.DSH_PROFILE || 'domain-${domain.name}'
const plan = installDomain({ domainInput: fileURLToPath(new URL('./domain.json', import.meta.url)), profile })
console.log(JSON.stringify(plan, null, 2))
`)
  fs.writeFileSync(path.join(outDir, 'README.md'), `# ${domain.title || domain.name} 领域包

只包含该领域需要的组件；安装到独立 profile：

\`\`\`bash
node install.mjs
dsh --profile domain-${domain.name} --port ${domain.profile?.port || 3080} --no-open
\`\`\`
`)
  return { outDir, domain: domain.name, components: [...copied], composed: resolved.composed }
}

export function domainPatch(domainInput) {
  const resolved = resolveDomain(domainInput)
  return renderCordisPatch(resolved.composed.rows)
}

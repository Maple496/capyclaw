/**
 * 多 suite 组合：合并 packages / rows / checks，检测冲突并生成 patch。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isValidRange, majorOf, validateSuiteManifest, versionSatisfies } from './manifest.mjs'

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const deepEqual = (a, b) => stable(a) === stable(b)

function unique(list) {
  return [...new Set(list)]
}

function mergeProvides(target, source) {
  for (const key of ['tools', 'skills', 'services', 'ports']) {
    if (!source?.[key]) continue
    target[key] = unique([...(target[key] || []), ...source[key]])
  }
  if (source?.capabilities) {
    target.capabilities = { ...(target.capabilities || {}), ...source.capabilities }
  }
  return target
}

/**
 * @param {{file:string,dir:string,manifest:object}[]} suites
 * @param {{allowOverride?:boolean}} [options]
 */
export function composeSuites(suites, options = {}) {
  const errors = []
  const warnings = []
  const packages = new Map()
  const rows = new Map()
  const checks = new Map()
  const ports = new Map()
  const tools = new Map()
  const capabilities = new Map()

  for (const suite of suites) {
    const { manifest, dir, file } = suite
    const validation = validateSuiteManifest(manifest)
    warnings.push(...validation.warnings.map((w) => `${manifest.name}: ${w}`))
    if (!validation.ok) {
      errors.push(...validation.errors.map((e) => `${manifest.name}: ${e}`))
      continue
    }

    for (const [name, entry] of Object.entries(manifest.packages)) {
      const current = packages.get(name)
      if (!current) {
        packages.set(name, { name, entry: { ...entry }, suite: manifest.name, dir, file })
      } else {
        if (current.entry.version !== entry.version) {
          errors.push(`包 ${name} 版本冲突: ${current.suite}=${current.entry.version} vs ${manifest.name}=${entry.version}`)
        }
        if (current.entry.role !== entry.role) {
          errors.push(`包 ${name} role 冲突: ${current.suite}=${current.entry.role} vs ${manifest.name}=${entry.role}`)
        }
        if (current.entry.path && entry.path) {
          const currentPath = resolve(current.dir, current.entry.path)
          const nextPath = resolve(dir, entry.path)
          if (currentPath !== nextPath) {
            errors.push(`包 ${name} 路径冲突: ${current.suite}=${currentPath} vs ${manifest.name}=${nextPath}`)
          }
        }
        for (const [dep, range] of Object.entries(entry.requires || {})) {
          if (current.entry.requires?.[dep] && current.entry.requires[dep] !== range) {
            errors.push(`包 ${name} 对 ${dep} 的 requires 冲突`)
          }
          current.entry.requires = { ...(current.entry.requires || {}), [dep]: range }
        }
        mergeProvides(current.entry.provides ||= {}, entry.provides)
      }
      for (const port of entry.provides?.ports || []) {
        const owner = ports.get(port)
        if (owner && owner !== name) errors.push(`端口 ${port} 冲突: ${owner} vs ${name}`)
        else ports.set(port, name)
      }
      for (const tool of entry.provides?.tools || []) {
        const owner = tools.get(tool)
        if (owner && owner !== name) errors.push(`工具名 ${tool} 冲突: ${owner} vs ${name}`)
        else tools.set(tool, name)
      }
      for (const [cap, version] of Object.entries(entry.provides?.capabilities || {})) {
        const owner = capabilities.get(cap)
        if (owner && !majorCompatible(owner.version, version)) {
          errors.push(`能力 ${cap} 版本冲突: ${owner.package}=${owner.version} vs ${name}=${version}`)
        } else if (!owner) {
          capabilities.set(cap, { package: name, version })
        }
      }
    }

    for (const row of manifest.rows) {
      const current = rows.get(row.id)
      if (!current) {
        rows.set(row.id, { row: { ...row }, suite: manifest.name })
        continue
      }
      const same = current.row.name === row.name
        && current.row.disabled === row.disabled
        && deepEqual(current.row.config, row.config)
      if (same) continue
      if (options.allowOverride) {
        warnings.push(`row ${row.id} 被 ${manifest.name} 覆盖（原 ${current.suite}）`)
        rows.set(row.id, { row: { ...row }, suite: manifest.name })
      } else {
        errors.push(`row ${row.id} 冲突: ${current.suite} 与 ${manifest.name} 定义了不同的 name/config`)
      }
    }

    for (const check of manifest.checks || []) {
      const current = checks.get(check.id)
      if (!current) checks.set(check.id, { check: { ...check }, suite: manifest.name })
      else if (deepEqual(current.check, check)) continue
      else errors.push(`check ${check.id} 冲突: ${current.suite} vs ${manifest.name}`)
    }
  }

  /* requires 必须能在组合里解析，或由调用方声明 external。 */
  for (const { name, entry, suite } of packages.values()) {
    for (const dep of Object.keys(entry.requires || {})) {
      if (dep === 'capabilities') {
        for (const [cap, range] of Object.entries(entry.requires.capabilities)) {
          const provider = capabilities.get(cap)
          if (!provider) {
            errors.push(`${suite}: 包 ${name} 需要能力 ${cap}@${range}，但组合里没有提供者`)
          } else if (!majorCompatible(provider.version, range)) {
            errors.push(`${suite}: 包 ${name} 需要能力 ${cap}@${range}，提供者 ${provider.package}@${provider.version} 不兼容`)
          }
        }
      } else if (!packages.has(dep)) {
        warnings.push(`${suite}: 包 ${name} 依赖 ${dep}，但组合里没有声明该包（按外部已安装处理）`)
      }
    }
  }

  /* 不同包的 wildcard 工具面重叠只告警，精确重名已经报错。 */
  const wildcardOwners = [...packages.values()]
    .filter(({ entry }) => (entry.provides?.tools || []).some((tool) => tool.includes('*')))
    .map(({ name }) => name)
  if (wildcardOwners.length > 1) {
    warnings.push(`多个包声明通配工具面: ${wildcardOwners.join(', ')}（请确认 MCP serverName 不冲突）`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rows: [...rows.values()].map(({ row, suite }) => ({ ...row, _suite: suite })),
    checks: [...checks.values()].map(({ check, suite }) => ({ ...check, _suite: suite })),
    capabilities: [...capabilities.entries()].map(([capability, info]) => ({ capability, ...info })),
  }
}

/** 生成 cordis.patch.yml（YAML；config 用 JSON 内联，避免 YAML 引号坑）。 */
export function renderCordisPatch(rows, { header = true } = {}) {
  const lines = []
  if (header) {
    lines.push('# 由 @capyclaw/suite-kit 生成；改 dsh-suite.json 后重跑 compose。', '')
  }
  lines.push('- insert:')
  for (const row of rows) {
    lines.push(`    - id: ${row.id}`)
    lines.push(`      name: ${JSON.stringify(row.name)}`)
    if (row.disabled !== undefined) lines.push(`      disabled: ${row.disabled ? 'true' : 'false'}`)
    if (row.config !== undefined) lines.push(`      config: ${JSON.stringify(row.config)}`)
  }
  return lines.join('\n') + '\n'
}

export function composeToDir(suites, outDir) {
  const result = composeSuites(suites)
  mkdirSync(outDir, { recursive: true })
  if (result.ok) writeFileSync(join(outDir, 'cordis.patch.yml'), renderCordisPatch(result.rows))
  writeFileSync(join(outDir, 'suite-compose.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

/** 版本范围兼容：优先用精确版本对 range 求解，无法判断时退回 major 比较。 */
export function majorCompatible(left, right) {
  const a = String(left || '').trim()
  const b = String(right || '').trim()
  if (a === '*' || b === '*' || a === 'latest' || b === 'latest') return true
  if (!isValidRange(a) || !isValidRange(b)) return false
  const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  if (exact.test(a) && !exact.test(b)) return versionSatisfies(b, a)
  if (exact.test(b) && !exact.test(a)) return versionSatisfies(a, b)
  const majorA = majorOf(a)
  const majorB = majorOf(b)
  return majorA != null && majorB != null && majorA === majorB
}

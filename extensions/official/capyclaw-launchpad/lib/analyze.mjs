/**
 * 跨清单分析：把单文件校验结果汇总成一份「启动清单视图」。
 *
 * 严重度约定（避免把仓库现状误报成故障）：
 * - 同一清单内重复 id / 固定端口冲突：error（broker 会静默合并或抢占）
 * - 跨清单同名服务 / 同端口：warning（多地声明可能是有意的替代部署）
 * - 命令路径不存在、works source 不存在、domain 行覆盖缺失：error
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { collectPlaceholders } from './parse.mjs'

const SECRET_PLACEHOLDER_SKIP = new Set(['PACKAGE_DIR'])
const PATH_EXT_RE = /\.(mjs|js|cjs|py|exe|cmd|bat|ps1)$/i

function canonical(file) {
  const abs = path.resolve(file)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function addIssue(issues, severity, code, message, extra = {}) {
  issues.push({ severity, code, message, ...extra })
}

function looksLikePath(token) {
  const text = String(token || '')
  if (!text || text.startsWith('-')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false
  if (text.includes('/') || text.includes('\\')) return true
  return PATH_EXT_RE.test(text)
}

function sortManifests(manifests) {
  const order = { stack: 0, broker: 1, works: 2, domain: 3, launcher: 4, profile: 5 }
  return [...manifests].sort((a, b) => {
    const diff = (order[a.type] ?? 9) - (order[b.type] ?? 9)
    return diff || String(a.relativePath).localeCompare(String(b.relativePath))
  })
}

function dedupeIssues(issues) {
  const seen = new Set()
  const out = []
  for (const issue of issues) {
    const key = [
      issue.severity, issue.code, issue.message,
      issue.manifestId || '', issue.serviceId || '', issue.path || '',
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(issue)
  }
  return out
}

function collectManifestIssues(manifests, issues) {
  for (const manifest of manifests) {
    for (const issue of manifest.issues || []) {
      let serviceId = issue.serviceId
      if (!serviceId && Number.isInteger(issue.index)) {
        serviceId = manifest.services?.[issue.index]?.serviceId
      }
      addIssue(issues, issue.severity || 'error', issue.code || 'manifest-issue', issue.message, {
        manifestId: manifest.id,
        manifestType: manifest.type,
        path: manifest.path,
        ...(serviceId ? { serviceId } : {}),
        ...(issue.port != null ? { port: issue.port } : {}),
      })
    }
  }
}

function analyzeServiceIds(services, issues) {
  const groups = new Map()
  for (const service of services) {
    if (!groups.has(service.serviceId)) groups.set(service.serviceId, [])
    groups.get(service.serviceId).push(service)
  }
  for (const [serviceId, group] of groups) {
    if (group.length < 2) continue
    const manifestIds = new Set(group.map((service) => service.manifestId))
    if (manifestIds.size < 2) continue // 同清单重复已由 parse 报 error
    const hashes = new Set(group.map((service) => service.specHash))
    const sameSpec = hashes.size === 1
    addIssue(issues, 'warning',
      sameSpec ? 'cross-manifest-duplicate-id' : 'cross-manifest-id-conflict',
      sameSpec
        ? `同名服务 ${serviceId} 在多份清单重复声明（规格相同）`
        : `同名服务 ${serviceId} 在多份清单声明了不同规格，启动时必须用 --manifest 指定`,
      {
        serviceId,
        manifests: group.map((service) => ({
          id: service.manifestId,
          path: service.manifestPath,
          specHash: service.specHash,
        })),
      })
  }
}

function analyzePorts(services, deployments, domains, issues) {
  const owners = new Map()
  function add(port, owner) {
    if (!Number.isInteger(port) || port <= 0) return
    if (!owners.has(port)) owners.set(port, [])
    owners.get(port).push(owner)
  }

  for (const service of services) {
    for (const fixed of service.fixedPorts || []) {
      add(fixed.port, {
        kind: 'service',
        id: service.serviceId,
        manifestId: service.manifestId,
        manifestPath: service.manifestPath,
        mode: 'fixed',
        name: fixed.name,
      })
    }
  }
  for (const manifest of deployments) {
    for (const item of manifest.works?.declaredPorts || []) {
      add(item.port, {
        kind: 'works',
        id: manifest.title,
        manifestId: manifest.id,
        manifestPath: manifest.path,
        mode: item.mode,
        name: item.name,
      })
    }
  }
  for (const manifest of domains) {
    for (const item of manifest.domain?.declaredPorts || []) {
      add(item.port, {
        kind: 'domain',
        id: manifest.domain?.name || manifest.title,
        manifestId: manifest.id,
        manifestPath: manifest.path,
        mode: item.mode,
        name: item.name,
      })
    }
  }

  for (const [port, group] of owners) {
    if (group.length < 2) continue
    const manifestIds = new Set(group.map((owner) => owner.manifestId))
    if (manifestIds.size < 2) continue // 同清单冲突已由 parse 报
    const uniqueOwners = new Set(group.map((owner) => `${owner.kind}:${owner.id}:${owner.manifestId}`))
    if (uniqueOwners.size < 2) continue
    const allFixed = group.every((owner) => owner.mode === 'fixed')
    addIssue(issues, 'warning', 'cross-manifest-port-conflict',
      `端口 ${port} 在多份清单被占用${allFixed ? '' : '（含 preferred，运行时可浮动）'}`,
      { port, owners: group })
  }
}

function analyzeCommandPaths(services, issues) {
  for (const service of services) {
    const spec = service._actionSpec || service.spec
    if (!spec) continue
    // suite 组成清单（dsh-suite.json 同目录的 services.json）的 ${PACKAGE_DIR} 指向
    // 安装态目录，源码仓库里必然不存在——路径缺失降级为 warning，不算 error。
    const suiteAdjacent = service.manifestPath
      && existsSync(path.join(path.dirname(service.manifestPath), 'dsh-suite.json'))
    for (const [index, token] of (spec.cmd || []).entries()) {
      if (String(token).includes('${')) continue
      // 只检查可执行文件/脚本：首参，或带脚本扩展名的参数。
      // `--dir <path>` 这类运行时目录可能由服务自己创建，不能当缺失命令。
      const isExecutable = index === 0
      const isScript = PATH_EXT_RE.test(String(token))
      if (!isExecutable && !isScript) continue
      if (!looksLikePath(token)) continue
      const candidates = []
      if (path.isAbsolute(token)) candidates.push(path.normalize(token))
      else {
        candidates.push(path.resolve(service.manifestDir, token))
        candidates.push(path.resolve(process.cwd(), token))
      }
      const hit = candidates.find((candidate) => existsSync(candidate))
      if (!hit) {
        if (suiteAdjacent) {
          addIssue(issues, 'warning', 'broker-cmd-install-state-path',
            `服务 ${service.serviceId} 的 cmd 指向安装态路径（源码态不存在，属正常）: ${token}`,
            {
              serviceId: service.serviceId,
              manifestId: service.manifestId,
              path: service.manifestPath,
              token,
            })
          continue
        }
        addIssue(issues, 'error', 'broker-missing-command-path',
          `服务 ${service.serviceId} 的 cmd 路径不存在: ${token}`,
          {
            serviceId: service.serviceId,
            manifestId: service.manifestId,
            path: service.manifestPath,
            token,
            candidates,
          })
        continue
      }
      try {
        if (statSync(hit).isDirectory()) {
          addIssue(issues, 'warning', 'broker-command-is-directory',
            `服务 ${service.serviceId} 的 cmd 指向目录而不是文件: ${hit}`,
            { serviceId: service.serviceId, manifestId: service.manifestId, path: service.manifestPath })
        }
      } catch { /* stat 失败按存在处理 */ }
    }
    if (spec.cwd && !existsSync(spec.cwd)) {
      addIssue(issues, 'error', 'broker-cwd-missing',
        `服务 ${service.serviceId} 的 cwd 不存在: ${spec.cwd}`,
        { serviceId: service.serviceId, manifestId: service.manifestId, path: service.manifestPath })
    }
  }
}

function analyzeRequires(manifests, issues) {
  for (const manifest of manifests) {
    if (manifest.type !== 'broker') continue
    const ids = new Set((manifest.services || []).map((service) => service.serviceId))
    for (const service of manifest.services || []) {
      for (const dep of service.requires || []) {
        if (ids.has(dep)) continue
        addIssue(issues, 'error', 'broker-dangling-requires',
          `服务 ${service.serviceId} 依赖 ${dep}，但同清单没有声明（broker 只在同批内解析 requires）`,
          {
            serviceId: service.serviceId,
            manifestId: manifest.id,
            path: manifest.path,
            requires: dep,
          })
      }
    }
  }
}

function analyzeEnv(services, issues) {
  for (const service of services) {
    const spec = service._actionSpec || service.spec
    if (!spec) continue
    const placeholders = collectPlaceholders({
      cmd: spec.cmd,
      env: spec.env,
      url: spec.url,
      cwd: spec.cwd,
    })
    for (const [name] of placeholders) {
      if (SECRET_PLACEHOLDER_SKIP.has(name)) continue
      if (process.env[name] !== undefined) continue
      addIssue(issues, 'warning', 'broker-env-missing',
        `服务 ${service.serviceId} 引用的环境变量 ${name} 当前未设置（broker 会展开为空串）`,
        {
          serviceId: service.serviceId,
          manifestId: service.manifestId,
          path: service.manifestPath,
          variable: name,
        })
    }
  }
}

function linkWorksToDomains(deployments, domains) {
  const byPath = new Map(domains.map((manifest) => [canonical(manifest.path), manifest]))
  for (const manifest of deployments) {
    const domainPath = manifest.works?.deployment?.domainPath
    if (!domainPath) continue
    const domain = byPath.get(canonical(domainPath))
    if (domain) {
      manifest.works.deployment.domainId = domain.id
      manifest.works.deployment.domainRelativePath = domain.relativePath
    }
  }
}

function linkLaunchersToManifests(launchers, brokerManifests) {
  const byPath = new Map(brokerManifests.map((manifest) => [canonical(manifest.path), manifest]))
  for (const launcher of launchers) {
    const manifestPath = launcher.launcher?.resolved?.manifest
    if (!manifestPath) continue
    const broker = byPath.get(canonical(manifestPath))
    if (broker) {
      launcher.launcher.activeManifestId = broker.id
      launcher.launcher.activeManifestRelativePath = broker.relativePath
    }
  }
}

function analyzeProfiles(profiles, dshHome, issues) {
  for (const manifest of profiles) {
    const profile = manifest.profile
    if (!profile) continue
    for (const bundle of profile.bundles || []) {
      if (bundle.startsWith('@deepseek-ai/')) continue
      const candidates = []
      if (profile.dir) candidates.push(path.join(profile.dir, 'node_modules', bundle, 'package.json'))
      if (dshHome) candidates.push(path.join(dshHome, 'node_modules', bundle, 'package.json'))
      if (candidates.length && candidates.some((candidate) => existsSync(candidate))) continue
      addIssue(issues, 'warning', 'profile-bundle-missing',
        `profile ${profile.name} 的 bundle ${bundle} 在 node_modules 中未找到`,
        { manifestId: manifest.id, path: manifest.path, bundle })
    }
  }
}

function analyzeDomainPackages(domains, issues) {
  const seen = new Set()
  for (const manifest of domains) {
    for (const component of manifest.domain?.components || []) {
      for (const pkg of component.packages || []) {
        if (!pkg.path || pkg.exists) continue
        const key = `${manifest.id}:${pkg.path}`
        if (seen.has(key)) continue
        seen.add(key)
        addIssue(issues, 'warning', 'domain-package-missing',
          `domain ${manifest.domain?.name || manifest.title} 的组件包不存在: ${pkg.name} → ${pkg.path}`,
          { manifestId: manifest.id, path: manifest.path, package: pkg.name })
      }
    }
  }
}

function summarize(manifests, services, issues, scanResult) {
  const byType = { stack: 0, broker: 0, works: 0, domain: 0, launcher: 0, profile: 0 }
  for (const manifest of manifests) byType[manifest.type] = (byType[manifest.type] || 0) + 1
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length
  return {
    manifests: manifests.length,
    services: services.length,
    stacks: byType.stack,
    deployments: byType.works,
    domains: byType.domain,
    launchers: byType.launcher,
    profiles: byType.profile,
    brokerManifests: byType.broker,
    errors,
    warnings,
    byType,
    scan: {
      filesScanned: scanResult.filesScanned,
      truncated: scanResult.truncated,
      skipped: scanResult.skipped.length,
      rootsSource: scanResult.rootsSource,
    },
  }
}

/**
 * @param {object} scanResult - scan() 的返回值
 * @returns {object} inventory
 */
export function analyze(scanResult) {
  const manifests = sortManifests(scanResult.manifests || [])
  const services = []
  const issues = []

  for (const manifest of manifests) {
    if (manifest.type !== 'broker') continue
    for (const service of manifest.services || []) {
      service.manifestId = manifest.id
      service.manifestType = manifest.type
      service.manifestRelativePath = manifest.relativePath
      services.push(service)
    }
  }

  const stacks = manifests.filter((manifest) => manifest.type === 'stack')
  const deployments = manifests.filter((manifest) => manifest.type === 'works')
  const domains = manifests.filter((manifest) => manifest.type === 'domain')
  const launchers = manifests.filter((manifest) => manifest.type === 'launcher')
  const profiles = manifests.filter((manifest) => manifest.type === 'profile')
  const brokerManifests = manifests.filter((manifest) => manifest.type === 'broker')

  for (const error of scanResult.errors || []) {
    addIssue(issues, 'error', error.code || 'scan-error', error.message, { path: error.path })
  }
  if (scanResult.truncated) {
    addIssue(issues, 'warning', 'scan-truncated',
      `扫描达到文件上限，结果可能不完整（已扫描 ${scanResult.filesScanned} 个候选文件）`)
  }

  collectManifestIssues(manifests, issues)
  analyzeServiceIds(services, issues)
  analyzePorts(services, deployments, domains, issues)
  analyzeCommandPaths(services, issues)
  analyzeRequires(brokerManifests, issues)
  analyzeEnv(services, issues)
  linkWorksToDomains(deployments, domains)
  linkLaunchersToManifests(launchers, brokerManifests)
  analyzeProfiles(profiles, scanResult.dshHome, issues)
  analyzeDomainPackages(domains, issues)

  const deduped = dedupeIssues(issues)
  const summary = summarize(manifests, services, deduped, scanResult)

  return {
    generatedAt: new Date().toISOString(),
    roots: scanResult.roots,
    dshHome: scanResult.dshHome,
    manifests,
    services,
    stacks,
    deployments,
    domains,
    launchers,
    profiles,
    issues: deduped,
    summary,
  }
}

/* ------------------------------------------------------------------ */
/* 引用解析（CLI/API 用）                                               */
/* ------------------------------------------------------------------ */

function notFound(kind, ref, candidates = []) {
  const error = new Error(`${kind}不存在: ${ref}${candidates.length ? `\n候选:\n- ${candidates.join('\n- ')}` : ''}`)
  error.code = 'NOT_FOUND'
  error.candidates = candidates
  return error
}

function ambiguous(kind, ref, candidates = []) {
  const error = new Error(`${kind}不唯一: ${ref}\n候选:\n- ${candidates.join('\n- ')}`)
  error.code = 'AMBIGUOUS'
  error.candidates = candidates
  return error
}

/** 解析清单引用：id / 相对路径 / basename / 唯一后缀。 */
export function resolveManifestRef(inventory, ref) {
  if (ref && typeof ref === 'object' && ref.id) return ref
  const text = String(ref || '').trim()
  const posixText = text.replaceAll('\\', '/')
  if (!text) throw notFound('清单', text)
  const manifests = inventory.manifests || []
  let matches = manifests.filter((manifest) => manifest.id === text)
  if (matches.length === 1) return matches[0]
  matches = manifests.filter((manifest) => manifest.relativePath === text
    || manifest.relativePath === posixText
    || manifest.path === text)
  if (matches.length === 1) return matches[0]
  matches = manifests.filter((manifest) => path.basename(manifest.path) === text)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw ambiguous('清单', text, matches.map((manifest) => `${manifest.id}  ${manifest.relativePath}`))
  }
  const lower = posixText.toLowerCase()
  matches = manifests.filter((manifest) => manifest.relativePath.toLowerCase().endsWith(lower))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw ambiguous('清单', text, matches.map((manifest) => `${manifest.id}  ${manifest.relativePath}`))
  }
  throw notFound('清单', text, manifests.map((manifest) => `${manifest.id}  ${manifest.relativePath}`))
}

/**
 * 解析服务引用。
 * @returns {{ service, matches }}
 */
export function resolveServiceRef(inventory, serviceId, manifestRef) {
  let pool = inventory.services || []
  if (manifestRef) {
    const manifest = resolveManifestRef(inventory, manifestRef)
    pool = pool.filter((service) => service.manifestId === manifest.id)
  }
  let matches = pool.filter((service) => service.id === serviceId)
  if (matches.length === 0) matches = pool.filter((service) => service.serviceId === serviceId)
  if (matches.length === 0) {
    throw notFound('服务', serviceId, pool.map((service) => `${service.serviceId}  ${service.manifestRelativePath}`))
  }
  if (matches.length === 1) return { service: matches[0], matches }
  const hashes = new Set(matches.map((service) => service.specHash))
  if (hashes.size > 1) {
    throw ambiguous('服务', serviceId, matches.map((service) => `${service.manifestId}  ${service.manifestRelativePath}`))
  }
  return { service: matches[0], matches }
}

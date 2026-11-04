/**
 * 启动清单扫描：把仓库/DSH_HOME 里散落的四类清单收成一份记录。
 *
 * 只读：不写文件、不跟随 symlink、不进入 node_modules / 产物目录。
 * 识别顺序是「形状优先、文件名辅助」——同名文件在不同项目里含义不同，
 * 先看 JSON 结构再决定按哪一类解析。
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  isBrokerManifestShape,
  isDeploymentJsonShape,
  isDiscoveryShape,
  isDomainShape,
  isLauncherShape,
  isProfileShape,
  isStackShape,
  parseBrokerManifest,
  parseDeploymentJson,
  parseDomain,
  parseLauncher,
  parseProfile,
  parseStack,
  parseWorks,
  relPath,
  stableManifestId,
} from './parse.mjs'

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_EXCLUDES = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'archives', 'bundles', 'dist', 'release',
  '.dshd', '.dshd-test', '.zcode', 'logs', 'data',
  'coverage', '.cache', '.tmp', '__pycache__', '.venv', 'venv',
  // 测试夹具不是生产启动清单；显式 --roots 指到夹具目录时仍可扫描。
  'fixtures',
])

const TYPE_ORDER = { stack: 0, broker: 1, works: 2, domain: 3, launcher: 4, profile: 5 }

export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 从 start 向上找仓库根：有 workspaces 的 package.json 或 CHAIN_CONTRACTS.md。 */
export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start)
  while (true) {
    const pkgFile = path.join(dir, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
        if (pkg && (pkg.workspaces || pkg.name === 'deepseekharness-dev-root')) return dir
      } catch { /* 坏 package.json 继续向上 */ }
    }
    if (existsSync(path.join(dir, 'CHAIN_CONTRACTS.md'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

/** 解析 --roots / LAUNCHPAD_ROOTS / 自动探测。 */
export function resolveRoots(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  let raw = options.roots
  let source = 'flag'
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    const env = process.env.LAUNCHPAD_ROOTS
    if (env) {
      raw = env
      source = 'env'
    } else {
      raw = [findRepoRoot(cwd) || findRepoRoot(PACKAGE_DIR) || cwd]
      source = 'auto'
    }
  }
  const list = Array.isArray(raw)
    ? raw
    : String(raw).split(',').map((item) => item.trim()).filter(Boolean)
  const roots = []
  const seen = new Set()
  for (const item of list) {
    const abs = path.isAbsolute(item) ? path.normalize(item) : path.resolve(cwd, item)
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(abs)
  }
  return { roots, source }
}

function canonical(file) {
  const abs = path.resolve(file)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

async function fileKey(file) {
  try { return canonical(await realpath(file)) } catch { return canonical(file) }
}

function isProfilePackagePath(file) {
  return /(^|[\\/])profiles[\\/][^\\/]+[\\/]package\.json$/i.test(path.normalize(file))
}

function isCandidateName(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.works')) return true
  if (lower === 'dsh-domain.json' || lower === 'domain.json') return true
  if (lower === 'dshd.config.json') return true
  if (lower.includes('stack') && lower.endsWith('.json')) return true
  // 示例/模板不是生产启动清单（README 指向它们，但不应出现在运行态视图里）
  if (lower.endsWith('.example.json') || lower.endsWith('.sample.json') || lower.endsWith('.template.json')) return false
  if (lower.endsWith('.services.json') || lower === 'services.json') return true
  if (lower.includes('services') && lower.endsWith('.json')) return true
  if (lower.includes('manifest') && lower.endsWith('.json')) return true
  if (lower.endsWith('.config.json')) return true
  if (lower.includes('deploy') && lower.endsWith('.json')) return true
  return false
}

function invalidRecord(type, file, message, options = {}) {
  const abs = path.resolve(file)
  const id = options.id || stableManifestId(type, abs)
  const record = {
    id,
    type,
    path: abs,
    relativePath: options.relativePath || relPath(abs),
    title: path.basename(file),
    valid: false,
    errors: [message],
    warnings: [],
    issues: [{ severity: 'error', code: `${type}-parse-error`, message }],
    services: [],
  }
  if (type === 'broker') record.broker = { serviceCount: 0, fixedPorts: [] }
  if (type === 'works') record.works = { format: path.extname(file).slice(1), meta: null, code: null, deployment: null, declaredPorts: [] }
  if (type === 'domain') record.domain = { name: null, version: null, components: [], rowRefs: [], declaredRows: [], missingRows: [], declaredPorts: [] }
  if (type === 'launcher') record.launcher = { config: null, resolved: null, state: null, stateFile: '', discoveryFile: '' }
  if (type === 'profile') record.profile = { name: path.basename(path.dirname(file)), dir: path.dirname(file), bundles: [], suites: [], dependencies: {} }
  if (type === 'stack') record.stack = {
    name: null, profile: null, home: '', profilePackage: '', workspace: '', stateDir: '',
    manifest: '', bundles: [], services: [], drift: null,
  }
  return record
}

function classifyJson(raw, file) {
  if (isDiscoveryShape(raw)) return '' // 运行态 discovery，不是启动清单
  if (isStackShape(raw, file)) return 'stack'
  if (isProfileShape(raw, file)) return 'profile'
  if (isLauncherShape(raw, file)) return 'launcher'
  if (isDomainShape(raw, file)) return 'domain'
  if (isBrokerManifestShape(raw, file)) return 'broker'
  if (isDeploymentJsonShape(raw, file)) return 'works'
  return ''
}

function parseByType(type, data, file, options) {
  switch (type) {
    case 'broker': return parseBrokerManifest(data, file, options)
    case 'works': return typeof data === 'string'
      ? parseWorks(data, file, options)
      : parseDeploymentJson(data, file, options)
    case 'domain': return parseDomain(data, file, options)
    case 'launcher': return parseLauncher(data, file, options)
    case 'profile': return parseProfile(data, file, options)
    case 'stack': return parseStack(data, file, options)
    default: return null
  }
}

function inferTypeFromName(file) {
  const name = path.basename(file).toLowerCase()
  if (name === 'dsh-domain.json' || name === 'domain.json') return 'domain'
  if (name === 'dshd.config.json' || name.endsWith('.config.json')) return 'launcher'
  if (name.includes('stack') && name.endsWith('.json')) return 'stack'
  if (name === 'package.json') return 'profile'
  if (name.includes('deploy')) return 'works'
  if (name.includes('services') || name.includes('manifest')) return 'broker'
  return ''
}

async function inspectFile(file, state, options) {
  const key = await fileKey(file)
  if (state.seen.has(key)) return
  state.seen.add(key)

  let info
  try {
    info = await stat(file)
  } catch (error) {
    state.errors.push({ code: 'scan-stat-failed', message: `无法读取文件信息: ${file}: ${error.message}`, path: file })
    return
  }
  if (info.size > state.maxFileSize) {
    state.skipped.push({ file, reason: `file-too-large (${info.size} bytes)` })
    return
  }

  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    state.errors.push({ code: 'scan-read-failed', message: `无法读取文件: ${file}: ${error.message}`, path: file })
    return
  }

  state.filesScanned += 1
  const relativePath = relPath(file, state.cwd)
  const isWorks = file.toLowerCase().endsWith('.works')
  if (isWorks) {
    const id = stableManifestId('works', file)
    const record = parseWorks(text, file, { id, relativePath })
    state.manifests.push(record)
    return
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const type = inferTypeFromName(file)
    if (type) {
      const id = stableManifestId(type, file)
      state.manifests.push(invalidRecord(type, file,
        `JSON 解析失败: ${error.message}`, { id, relativePath }))
    } else {
      state.skipped.push({ file, reason: 'invalid-json' })
    }
    return
  }

  const type = classifyJson(raw, file)
  if (!type) {
    state.skipped.push({ file, reason: 'not-a-launch-manifest' })
    return
  }
  const id = stableManifestId(type, file)
  const record = parseByType(type, raw, file, { id, relativePath })
  if (record) state.manifests.push(record)
}

async function walk(root, state, depth = 0) {
  if (state.filesScanned >= state.maxFiles) {
    state.truncated = true
    return
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    state.errors.push({ code: 'scan-root-unreadable', message: `无法读取目录: ${root}: ${error.message}`, path: root })
    return
  }
  for (const entry of entries) {
    if (state.filesScanned >= state.maxFiles) {
      state.truncated = true
      return
    }
    if (entry.isSymbolicLink()) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDES.has(entry.name.toLowerCase())) continue
      if (depth >= state.maxDepth) {
        state.skipped.push({ file: full, reason: 'max-depth' })
        continue
      }
      await walk(full, state, depth + 1)
      continue
    }
    if (!entry.isFile()) continue

    const lower = entry.name.toLowerCase()
    const profilePackage = lower === 'package.json' && isProfilePackagePath(full)
    if (!profilePackage && !isCandidateName(entry.name)) continue
    await inspectFile(full, state, { profilePackage })
  }
}

async function scanProfiles(dshHome, state) {
  if (!dshHome) return
  const profilesDir = path.join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return
  let entries
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    state.errors.push({ code: 'scan-profiles-unreadable', message: `无法读取 profiles 目录: ${profilesDir}: ${error.message}`, path: profilesDir })
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(profilesDir, entry.name, 'package.json')
    if (!existsSync(file)) continue
    const key = await fileKey(file)
    if (state.seen.has(key)) continue
    state.seen.add(key)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      state.errors.push({ code: 'scan-read-failed', message: `无法读取 profile: ${file}: ${error.message}`, path: file })
      continue
    }
    state.filesScanned += 1
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      const id = stableManifestId('profile', file)
      state.manifests.push(invalidRecord('profile', file,
        `JSON 解析失败: ${error.message}`, { id, relativePath: `profiles/${entry.name}/package.json` }))
      continue
    }
    if (!isProfileShape(raw, file)) {
      state.skipped.push({ file, reason: 'profile-without-dsh.profile.bundles' })
      continue
    }
    const id = stableManifestId('profile', file)
    state.manifests.push(parseProfile(raw, file, {
      id,
      relativePath: `profiles/${entry.name}/package.json`,
    }))
  }
}

/**
 * 扫描入口。
 * @returns {{ roots, dshHome, manifests, filesScanned, truncated, skipped, errors }}
 */
export async function scan(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  const { roots, source } = resolveRoots({ ...options, cwd })
  const dshHome = path.resolve(options.dshHome || defaultDshHome())
  const state = {
    cwd,
    maxDepth: options.maxDepth ?? 8,
    maxFiles: options.maxFiles ?? 20000,
    maxFileSize: options.maxFileSize ?? 1024 * 1024,
    manifests: [],
    filesScanned: 0,
    truncated: false,
    skipped: [],
    errors: [],
    seen: new Set(),
  }

  for (const root of roots) {
    if (!existsSync(root)) {
      state.errors.push({ code: 'scan-root-missing', message: `扫描根不存在: ${root}`, path: root })
      continue
    }
    await walk(root, state)
  }

  if (options.includeProfiles !== false) await scanProfiles(dshHome, state)

  state.manifests.sort((a, b) => {
    const typeDiff = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
    if (typeDiff) return typeDiff
    return String(a.relativePath).localeCompare(String(b.relativePath))
  })

  return {
    roots,
    rootsSource: source,
    dshHome,
    manifests: state.manifests,
    filesScanned: state.filesScanned,
    truncated: state.truncated,
    skipped: state.skipped,
    errors: state.errors,
  }
}

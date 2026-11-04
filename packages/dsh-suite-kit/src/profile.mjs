/**
 * 安装 / doctor：把 suite 装进 DSH profile，并验证组合是否真的工作。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { composeSuites, renderCordisPatch } from './compose.mjs'
import { loadSuiteManifest, validateSuiteManifest } from './manifest.mjs'
import { resolvePackageSpec } from './artifacts.mjs'

export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function profileDirOf(dshHome, profile) {
  return path.join(path.resolve(dshHome), 'profiles', profile)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function backup(file) {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(file, `${file}.bak-${stamp}`)
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function packageVersionOf(dir, entry) {
  const target = entry?.path ? path.resolve(dir, entry.path) : null
  const manifest = target ? readJsonSafe(path.join(target, 'package.json')) : null
  return {
    version: manifest?.version || entry?.version || '',
    apiVersion: manifest?.dsh?.apiVersion || null,
    dir: target,
  }
}

function buildCompositionLock({ profile, dir, suites, composed }) {
  const packages = {}
  for (const pkg of composed.packages) {
    const info = packageVersionOf(pkg.dir, pkg.entry)
    packages[pkg.name] = {
      version: info.version,
      range: pkg.entry?.version || '',
      role: pkg.entry?.role || '',
      apiVersion: info.apiVersion,
      suite: pkg.suite || '',
    }
  }
  return {
    version: 1,
    profile,
    suites: suites.map(({ manifest }) => ({ name: manifest.name, version: manifest.version })),
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
  }
}

function majorOf(version) {
  const match = /^(\d+)/.exec(String(version || ''))
  return match ? match[1] : ''
}

function diffCompositionLocks(previous, next) {
  if (!previous) return []
  const changes = []
  const names = new Set([...Object.keys(previous.packages || {}), ...Object.keys(next.packages || {})])
  for (const name of [...names].sort()) {
    const before = previous.packages?.[name]
    const after = next.packages?.[name]
    if (!before) changes.push({ type: 'added', name, version: after.version })
    else if (!after) changes.push({ type: 'removed', name, version: before.version })
    else if (before.version !== after.version || before.range !== after.range || before.role !== after.role) {
      changes.push({ type: 'updated', name, from: before.version, to: after.version })
    }
    if (before && after && before.apiVersion && after.apiVersion && majorOf(before.apiVersion) !== majorOf(after.apiVersion)) {
      changes.push({ type: 'api-major', name, from: before.apiVersion, to: after.apiVersion })
    }
  }
  const suiteNames = new Set([
    ...(previous.suites || []).map((suite) => suite.name),
    ...(next.suites || []).map((suite) => suite.name),
  ])
  for (const name of [...suiteNames].sort()) {
    const before = (previous.suites || []).find((suite) => suite.name === name)
    const after = (next.suites || []).find((suite) => suite.name === name)
    if (!before) changes.push({ type: 'suite-added', name, version: after.version })
    else if (!after) changes.push({ type: 'suite-removed', name, version: before.version })
    else if (before.version !== after.version) changes.push({ type: 'suite-updated', name, from: before.version, to: after.version })
  }
  return changes
}

function validateSuiteLock(suite, composed) {
  const file = path.join(suite.dir, 'composition.lock.json')
  const lock = readJsonSafe(file)
  if (!lock) return { file, ok: true, warnings: [] }
  const warnings = []
  if (lock.suite !== suite.manifest.name) {
    warnings.push(`${suite.manifest.name}: composition.lock 的 suite=${lock.suite} 与 manifest 不一致`)
  }
  if (String(lock.suiteVersion) !== String(suite.manifest.version)) {
    warnings.push(`${suite.manifest.name}: composition.lock 版本 ${lock.suiteVersion} 与 manifest ${suite.manifest.version} 不一致`)
  }
  const byName = new Map((composed?.packages || []).map((pkg) => [pkg.name, pkg]))
  for (const [name, locked] of Object.entries(lock.packages || {})) {
    const pkg = byName.get(name)
    if (!pkg) { warnings.push(`${suite.manifest.name}: composition.lock 引用了不存在的包 ${name}`); continue }
    const actual = packageVersionOf(pkg.dir, pkg.entry)
    if (locked.version && actual.version && locked.version !== actual.version) {
      warnings.push(`${suite.manifest.name}: ${name} lock 版本 ${locked.version} ≠ 实际 ${actual.version}`)
    }
    if (locked.apiVersion && actual.apiVersion && majorOf(locked.apiVersion) !== majorOf(actual.apiVersion)) {
      warnings.push(`${suite.manifest.name}: ${name} lock API major ${locked.apiVersion} ≠ 实际 ${actual.apiVersion}`)
    }
  }
  return { file, ok: warnings.length === 0, lock, warnings }
}

function samePath(left, right) {
  try { return fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase() } catch { return false }
}

function linkDir(target, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    const stat = fs.lstatSync(dest)
    if (stat.isSymbolicLink()) {
      if (samePath(dest, target)) return false
      fs.rmSync(dest, { recursive: true, force: true })
    } else if (stat.isDirectory()) {
      let name = ''
      try { name = readJson(path.join(dest, 'package.json')).name } catch { /* 非包目录 */ }
      if (name !== path.basename(dest)) {
        throw new Error(`${dest} 是真实目录且不是同名包，拒绝覆盖`)
      }
      fs.rmSync(dest, { recursive: true, force: true })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.symlinkSync(target, dest, 'junction')
  return true
}

/** 从 insert 块中按 entry 删除指定 row，保留同块内其它 row。 */
function filterInsertBlock(block, wanted) {
  const header = block[0]
  const entries = []
  let current = []
  for (const line of block.slice(1)) {
    if (/^\s+- id:\s*/.test(line)) {
      if (current.length) entries.push(current)
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) entries.push(current)
  if (!entries.length) return block
  const kept = entries.filter((entry) => {
    const hit = /^\s+- id:\s*([^\s#]+)\s*$/.exec(entry[0])
    return !hit || !wanted.has(hit[1])
  })
  if (!kept.length) return []
  return [header, ...kept.flat()]
}

/** 从 profile patch 里移除指定 row 的顶层块（用于旧版单装迁移）。 */
export function stripPatchRows(text, ids) {
  const wanted = new Set(ids || [])
  if (!wanted.size) return text
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^- insert:\s*$/.test(line)) {
      let j = i + 1
      const block = [line]
      while (j < lines.length) {
        const next = lines[j]
        if (next.trim() !== '' && !/^\s/.test(next)) break
        block.push(next)
        j++
      }
      out.push(...filterInsertBlock(block, wanted))
      i = j - 1
      continue
    }
    const hit = /^- id:\s*([^\s#]+)\s*$/.exec(line)
    if (hit && wanted.has(hit[1])) {
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) j++
      i = j - 1
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function runPnpm(profileDir) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm install --ignore-scripts --reporter=silent'],
      { cwd: profileDir, stdio: 'inherit' })
    : spawnSync('pnpm', ['install', '--ignore-scripts', '--reporter=silent'],
      { cwd: profileDir, stdio: 'inherit' })
  return result.status === 0
}

/**
 * @param {{
 *   suiteInputs: string[],
 *   profile?: string,
 *   dshHome?: string,
 *   dryRun?: boolean,
 *   runPnpm?: boolean,
 *   removeDependencies?: string[],
 *   packageSpecs?: string[],
 *   rollbackTo?: string,
 *   artifactRoot?: string
 * }} options
 */
export function installSuites(options) {
  const profile = options.profile || process.env.DSH_PROFILE || 'web'
  const dshHome = options.dshHome || defaultDshHome()
  const dir = profileDirOf(dshHome, profile)
  const manifestPath = path.join(dir, 'package.json')
  const patchPath = path.join(dir, 'cordis.patch.yml')
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到 profile: ${dir}`)

  const suites = options.suiteInputs.map((input) => loadSuiteManifest(input))
  const composed = composeSuites(suites)
  if (!composed.ok) throw new Error('suite 组合冲突:\n- ' + composed.errors.join('\n- '))

  const overrides = []
  const applyOverride = (spec) => {
    const meta = resolvePackageSpec(spec, { root: options.artifactRoot })
    const pkg = composed.packages.find((item) => item.name === meta.name)
    if (!pkg) throw new Error(`artifact 覆盖失败: suite 组合里没有包 ${meta.name}`)
    pkg.entry = { ...pkg.entry, path: meta.dir, version: meta.version }
    pkg.artifact = meta
    overrides.push({ name: meta.name, version: meta.version, dir: meta.dir })
    return meta
  }
  if (options.rollbackTo) {
    const target = path.resolve(options.rollbackTo)
    const targetLock = readJsonSafe(target)
    if (!targetLock?.packages) throw new Error(`rollback 锁文件不可读或缺少 packages: ${target}`)
    for (const [name, meta] of Object.entries(targetLock.packages)) {
      if (!meta?.version) continue
      try { applyOverride(`${name}@${meta.version}`) }
      catch (error) { throw new Error(`rollback ${name}@${meta.version} 失败: ${error.message}`) }
    }
  }
  for (const spec of options.packageSpecs || []) applyOverride(spec)

  const compositionLockPath = path.join(dir, 'dsh-composition.lock.json')
  const previousLock = readJsonSafe(compositionLockPath)
  const compositionLock = buildCompositionLock({ profile, dir, suites, composed })
  const lockChanges = diffCompositionLocks(previousLock, compositionLock)
  const suiteLockResults = suites.map((suite) => validateSuiteLock(suite, composed))
  const lockWarnings = []
  for (const change of lockChanges) {
    if (change.type === 'api-major') {
      lockWarnings.push(`公共插件 ${change.name} API major ${change.from} → ${change.to}；请确认消费者已升级`)
    }
  }
  for (const result of suiteLockResults) lockWarnings.push(...result.warnings)

  const legacy = new Set(options.removeDependencies || [])
  const manifest = readJson(manifestPath)
  manifest.dependencies ||= {}
  manifest.dsh ||= {}
  manifest.dsh.profile ||= {}
  const previous = manifest.dshSuiteKit?.managedPackages || []
  for (const name of previous) delete manifest.dependencies[name]
  for (const name of manifest.dshSuiteKit?.suites || []) {
    delete manifest.dependencies[name]
  }
  for (const name of legacy) delete manifest.dependencies[name]

  for (const suite of suites) {
    manifest.dependencies[suite.manifest.name] = `link:${suite.dir.replace(/\\/g, '/')}`
  }

  const managedPackages = composed.packages
    .filter(({ entry }) => entry.path)
    .map(({ name }) => name)
  const suiteNames = suites.map(({ manifest: m }) => m.name)
  const bundles = (manifest.dsh.profile.bundles || [])
    .filter((name) => !previous.includes(name))
    .filter((name) => !(manifest.dshSuiteKit?.suites || []).includes(name))
    .filter((name) => !legacy.has(name))
  for (const name of suiteNames) if (!bundles.includes(name)) bundles.push(name)
  manifest.dsh.profile.bundles = bundles
  manifest.dshSuiteKit = {
    version: 1,
    suites: suiteNames,
    managedPackages,
    updatedAt: new Date().toISOString(),
  }

  const plan = {
    profile,
    dir,
    suites: suiteNames,
    bundles,
    dependencies: Object.keys(manifest.dependencies),
    managedPackages,
    warnings: [...composed.warnings, ...lockWarnings],
    dryRun: !!options.dryRun,
    lock: compositionLock,
    lockPath: compositionLockPath,
    lockChanges,
    suiteLocks: suiteLockResults.map((result) => ({ file: result.file, ok: result.ok })),
    overrides,
    rollbackTo: options.rollbackTo ? path.resolve(options.rollbackTo) : null,
  }
  if (options.dryRun) return plan

  backup(manifestPath)
  backup(patchPath)
  backup(compositionLockPath)
  writeJson(manifestPath, manifest)
  writeJson(compositionLockPath, compositionLock)
  const writtenLock = readJsonSafe(compositionLockPath)
  if (!writtenLock || JSON.stringify(writtenLock) !== JSON.stringify(compositionLock)) {
    throw new Error(`组合锁写入校验失败: ${compositionLockPath}`)
  }
  if (options.removeRows?.length && fs.existsSync(patchPath)) {
    const before = fs.readFileSync(patchPath, 'utf8')
    const after = stripPatchRows(before, options.removeRows)
    if (after !== before) fs.writeFileSync(patchPath, after)
  }

  if (options.runPnpm !== false) {
    if (!runPnpm(dir)) plan.warnings.push('pnpm install 未成功；junction 仍会建立，但 lockfile 可能不是最新')
  }

  const linked = []
  for (const suite of suites) {
    linkDir(suite.dir, path.join(dir, 'node_modules', suite.manifest.name))
    linked.push(suite.manifest.name)
  }
  for (const packageInfo of composed.packages) {
    const target = packageInfo.entry.path
      ? path.resolve(packageInfo.dir, packageInfo.entry.path)
      : null
    if (!target) continue
    linkDir(target, path.join(dir, 'node_modules', packageInfo.name))
    linked.push(packageInfo.name)
  }
  plan.linked = linked
  return plan
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: response.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

async function checkHttp(check, timeoutMs) {
  try {
    const response = await fetchJson(check.url, { method: check.method || 'GET' }, check.timeoutMs || timeoutMs)
    const wantStatus = check.expectStatus ?? 200
    if (response.status !== wantStatus) {
      return { id: check.id, ok: false, detail: `HTTP ${response.status}，期望 ${wantStatus}` }
    }
    if (check.expectBody) {
      for (const [key, value] of Object.entries(check.expectBody)) {
        if (JSON.stringify(response.body?.[key]) !== JSON.stringify(value)) {
          return { id: check.id, ok: false, detail: `body.${key}=${JSON.stringify(response.body?.[key])}，期望 ${JSON.stringify(value)}` }
        }
      }
    }
    return { id: check.id, ok: true, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { id: check.id, ok: false, detail: String(error.message || error) }
  }
}

async function checkContract(check, timeoutMs) {
  const timeout = check.timeoutMs || timeoutMs
  try {
    const init = await fetchJson(check.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {} },
      }),
    }, timeout)
    if (init.status !== 200) return { id: check.id, ok: false, detail: `initialize HTTP ${init.status}` }
    const call = await fetchJson(check.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: check.tool, arguments: {} },
      }),
    }, timeout)
    if (call.status !== 200) return { id: check.id, ok: false, detail: `tools/call HTTP ${call.status}` }
    const text = call.body?.result?.content?.[0]?.text
    if (call.body?.result?.isError) return { id: check.id, ok: false, detail: String(text || '工具返回 isError') }
    const payload = JSON.parse(text)
    const major = Number(String(payload.contractVersion || '').split('.')[0])
    if (major !== check.major) {
      return { id: check.id, ok: false, detail: `contractVersion=${payload.contractVersion}，期望 major ${check.major}` }
    }
    return { id: check.id, ok: true, detail: `contractVersion=${payload.contractVersion}` }
  } catch (error) {
    return { id: check.id, ok: false, detail: String(error.message || error) }
  }
}

/**
 * @param {{profile?: string, dshHome?: string, dshBin?: string, timeoutMs?: number}} [options]
 */
export async function doctor(options = {}) {
  const profile = options.profile || process.env.DSH_PROFILE || 'web'
  const dshHome = options.dshHome || defaultDshHome()
  const dir = profileDirOf(dshHome, profile)
  const manifestPath = path.join(dir, 'package.json')
  const errors = []
  const warnings = []
  const checks = []

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: [`找不到 profile: ${dir}`], warnings, checks }
  }
  const manifest = readJson(manifestPath)
  const suiteNames = manifest.dshSuiteKit?.suites
    || (manifest.dsh?.profile?.bundles || []).filter((name) => name.startsWith('dsh-') && name.includes('suite'))
  if (!suiteNames.length) warnings.push('profile 没有 dshSuiteKit.suites，按 bundle 名称猜测 suite')

  const suites = []
  for (const name of suiteNames) {
    const packageDir = path.join(dir, 'node_modules', name)
    if (!fs.existsSync(packageDir)) {
      errors.push(`suite ${name} 未安装（缺少 node_modules/${name}）`)
      continue
    }
    try {
      const loaded = loadSuiteManifest(packageDir)
      const validation = validateSuiteManifest(loaded.manifest, { baseDir: loaded.dir })
      if (!validation.ok) errors.push(...validation.errors.map((e) => `${name}: ${e}`))
      const generated = composeSuites([loaded])
      if (generated.ok) {
        const expected = renderCordisPatch(generated.rows)
        const patchFile = path.join(packageDir, 'cordis.patch.yml')
        if (!fs.existsSync(patchFile) || fs.readFileSync(patchFile, 'utf8') !== expected) {
          errors.push(`${name}: cordis.patch.yml 与 dsh-suite.json 生成结果不一致，请重跑 compose`)
        }
      }
      suites.push(loaded)
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
    }
  }

  if (suites.length) {
    const composed = composeSuites(suites)
    errors.push(...composed.errors)
    warnings.push(...composed.warnings)
    for (const pkg of composed.packages) {
      if (!pkg.entry.path) continue
      const target = path.resolve(pkg.dir, pkg.entry.path)
      if (!fs.existsSync(path.join(target, 'package.json'))) {
        errors.push(`包 ${pkg.name} 不存在或不是包: ${target}`)
      }
    }
    for (const check of composed.checks) {
      checks.push(check.type === 'contract'
        ? await checkContract(check, options.timeoutMs || 3000)
        : await checkHttp(check, options.timeoutMs || 3000))
    }
  }

  if (options.dshBin) {
    const bin = path.resolve(options.dshBin)
    const result = spawnSync(bin, ['--profile', profile, '--dump-config'], {
      cwd: dshHome,
      env: { ...process.env, DSH_HOME: dshHome },
      encoding: 'utf8',
      timeout: 30000,
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) {
      warnings.push(`dsh --dump-config 失败: ${(result.stderr || result.stdout || '').slice(0, 300)}`)
    } else {
      const ids = [...result.stdout.matchAll(/^- id: (.+)$/gm)].map((m) => m[1].trim())
      const counts = new Map()
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1)
      for (const [id, count] of counts) {
        if (count > 1) errors.push(`组合后 row.id 重复: ${id} × ${count}`)
      }
    }
  }

  return { ok: errors.length === 0 && checks.every((c) => c.ok), errors, warnings, checks }
}

export function formatReport(report) {
  const lines = []
  for (const check of report.checks || []) lines.push(`${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`)
  for (const warning of report.warnings || []) lines.push(`! ${warning}`)
  for (const error of report.errors || []) lines.push(`✗ ${error}`)
  lines.push(report.ok ? '✓ suite doctor 通过' : '✗ suite doctor 未通过')
  return lines.join('\n')
}

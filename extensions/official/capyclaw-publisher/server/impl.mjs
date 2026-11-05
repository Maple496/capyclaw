/**
 * @capyclaw/publisher 业务实现：发布引擎。
 *
 * 逐条移植自插件工程仓库的 scripts/publish-to-npm.mjs（发布主流程/闸门/顺序/漂移/复核）
 * 与 tools/capyclaw-plugin-release 的 publishGateErrors + discoverPlugins（发现集判定），
 * 行为保持对齐：仓库侧脚本删除后，这里是唯一实现。
 *
 * 与原脚本的差异（有意为之）：
 *   - root（要发布的仓库 checkout）是调用参数，不再是模块常量；
 *   - npm view / npm pack 的缓存挂在每次调用的 context 上（服务进程长驻，避免跨调用串味）；
 *   - 新增轻量 pack 闸（npm pack --dry-run 断言 package.json/main/patch 必在包内），
 *     顶替原 scripts/verify-publishable.mjs 的核心保护。
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validatePlugin } from '@capyclaw/plugin-validator'

/** 支撑库目录（相对仓库根）：纯库/独立服务，无 dsh.bundle，插件发现集不收，显式清单维护。
 *  可用 DSH_PUBLISHER_LIBS（JSON 数组，相对 root 的路径）覆盖。 */
export const DEFAULT_SUPPORT_LIBS = [
  'packages/capyclaw-plugin-kit',
  'packages/capyclaw-document-workbench',
  'packages/capyclaw-host-shell',
  'extensions/bridges/ppt-bridge/capyclaw-skills-service',
]

/** 与原脚本一致的失败状态集（其余视为通过或跳过）。 */
export const FAILURE_STATUSES = [
  'missing-dir', 'gate-failed', 'invalid', 'pack-incomplete',
  'test-failed', 'publish-failed', 'publish-corrupted', 'version-drift', 'order-blocked',
]

/* ────────────────────────── 发现集与闸门（移植） ────────────────────────── */

/** 发布闸：验证器不管、但分发必需的项。返回错误串数组。
 *  （移植自 tools/capyclaw-plugin-release/lib/index.mjs publishGateErrors） */
export function publishGateErrors(pkg, srcDir) {
  const errors = []
  if (pkg.private === true) {
    errors.push('package.json 标记了 private: true——不能发布到 npm；确认它是否属于对外分发件')
  }
  if (!pkg.publishConfig?.access) {
    errors.push('缺少 publishConfig.access（作用域包默认 restricted，需显式 public）')
  }
  const enginesDsh = pkg.engines?.dsh
  if (typeof enginesDsh !== 'string' || !enginesDsh.trim()) {
    errors.push('缺少 engines.dsh（消费方无法判断兼容的 dsh 运行时版本）')
  }
  const patch = pkg.dsh?.bundle?.patch
  const patches = Array.isArray(patch) ? patch : patch ? [patch] : []
  if (!patches.length) errors.push('缺少 dsh.bundle.patch（dsh 不会把这个包当作 profile 层加载）')
  for (const rel of patches) {
    if (!fs.existsSync(path.join(srcDir, rel))) errors.push(`dsh.bundle.patch 指向的文件不存在: ${rel}`)
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, range] of Object.entries(deps)) {
      if (/^(link|file):/.test(String(range))) {
        errors.push(`${field}.${name} 是源码树本地路径（${range}）——分发件必须走版本范围`)
      }
    }
  }
  return errors
}

/** 库发布闸：插件闸管不了的分发必需项。返回错误串数组。（移植自 publish-to-npm.mjs） */
export function libraryGateErrors(pkg) {
  const errors = []
  if (pkg.private === true) errors.push('package.json 标记了 private: true')
  if (pkg.name.startsWith('@') && !pkg.publishConfig?.access) {
    errors.push('缺少 publishConfig.access（作用域包默认 restricted，需显式 public）')
  }
  if (!pkg.license) errors.push('缺少 license 声明')
  if (!pkg.version) errors.push('缺少 version')
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, range] of Object.entries(deps)) {
      if (/^(link|file):/.test(String(range))) {
        errors.push(`${field}.${name} 是源码树本地路径（${range}）——分发件必须走版本范围`)
      }
    }
  }
  return errors
}

/** 插件扫码根目录 + 包名形态。（移植自 plugin-release；发布闸用不到 suite 校验器注入） */
const PLUGIN_BASES = ['packages', 'extensions/official', 'extensions/bridges', 'extensions/bridges/*/plugin']
const PUBLISHABLE_NAME = /^((@[\w.-]+\/)?dsh-[\w.-]+|@capyclaw\/[\w.-]+)$/

/** 找出 root 下所有**可发布**的插件目录（过得了发布闸的才算）。未就绪的落 lastSkipped。 */
export function discoverPlugins({ root, includeNotReady = false } = {}) {
  const out = []
  const skipped = []
  const seen = new Set()
  const visit = (dir) => {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const publishable = PUBLISHABLE_NAME.test(pkg.name || '')
          && (pkg.dsh?.bundle || pkg.dsh?.client || pkg.dsh?.suite)
        if (publishable && !seen.has(pkg.name)) {
          seen.add(pkg.name)
          const reasons = publishGateErrors(pkg, dir)
          if (reasons.length) skipped.push({ dir, name: pkg.name, reasons })
          else out.push(dir)
        }
      } catch { /* 坏 package.json 由验证器报，不在这里中断扫描 */ }
    }
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (['node_modules', '.git', 'dist', 'archive', 'test'].includes(entry.name)) continue
      visit(path.join(dir, entry.name))
    }
  }
  for (const base of PLUGIN_BASES) {
    const dir = path.join(root, base)
    if (fs.existsSync(dir)) visit(dir)
  }
  out.sort()
  discoverPlugins.lastSkipped = skipped.sort((a, b) => a.name.localeCompare(b.name))
  return includeNotReady ? [...out, ...skipped.map((s) => s.dir)].sort() : out
}

export function pkgOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

/* ────────────────────────── npm 调用（每次调用一个 context） ────────────────────────── */

/** npm 直调（node npm-cli.js，不走 shell）：含空格的临时/用户目录不会被拆词。 */
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
function rawNpmRun(args, options = {}) {
  if (fs.existsSync(NPM_CLI)) {
    return spawnSync(process.execPath, [NPM_CLI, ...args], { encoding: 'utf8', stdio: 'pipe', ...options })
  }
  return spawnSync('npm', args, { encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', ...options })
}

function createNpmContext() {
  /** npm view 结果缓存：同一次运行里同一 specifier 只查一次。 */
  const viewCache = new Map()
  const npmView = (spec, field) => {
    const key = `${spec}|${field}`
    if (!viewCache.has(key)) viewCache.set(key, rawNpmRun(['view', spec, field]))
    return viewCache.get(key)
  }
  const alreadyPublished = (name, version) => {
    const r = npmView(`${name}@${version}`, 'version')
    if (r.status !== 0) return false
    return String(r.stdout).trim() === version
  }
  /** registry 上已发布 tarball 的 sha1（拿不到返回 null，网络闪断降级为警告）。 */
  const npmShasumOf = (name, version) => {
    const r = npmView(`${name}@${version}`, 'dist.shasum')
    if (r.status !== 0) return null
    return String(r.stdout).trim() || null
  }
  /** 本地 npm pack 产物的 sha1（npm pack 确定性：同内容同哈希）。结果按目录缓存。 */
  const localShasumCache = new Map()
  const localShasumOf = (dir) => {
    if (localShasumCache.has(dir)) return localShasumCache.get(dir)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-sha-'))
    try {
      const pack = rawNpmRun(['pack', '--pack-destination', tmp], { cwd: dir })
      if (pack.status !== 0) return null
      const tgz = path.join(tmp, String(pack.stdout).trim().split(/\r?\n/).pop())
      const sha = crypto.createHash('sha1').update(fs.readFileSync(tgz)).digest('hex')
      localShasumCache.set(dir, sha)
      return sha
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  return { rawNpmRun, npmView, alreadyPublished, npmShasumOf, localShasumOf }
}

/** 发布顺序闸：待发包的 @capyclaw 依赖闭包，每一项必须 registry 可解析或在同批发布。
 *  拦截「只发 suite 不发依赖」这类顺序手滑（发布成功 ≠ 用户能装上）。 */
export function orderGate(pkg, localMap, batch, npm) {
  const errors = []
  const warnings = []
  const seen = new Set([pkg.name])
  const queue = [pkg]
  while (queue.length) {
    const cur = queue.shift()
    const deps = { ...(cur.dependencies || {}), ...(cur.peerDependencies || {}), ...(cur.optionalDependencies || {}) }
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@capyclaw/') || seen.has(name)) continue
      seen.add(name)
      const local = localMap.get(name)
      if (local) queue.push(local.pkg) /* 闭包继续沿本仓包展开 */
      const resolvable = npm.npmView(`${name}@${range}`, 'version')
      if (resolvable.status === 0) continue /* ① registry 已可解析 */
      if (batch.has(name)) {
        warnings.push(`${name}@${range} registry 暂不可解析，依赖同批发布（确认批次包含它）`)
      } else {
        errors.push(`${name}@${range} 在 registry 上不可解析，且不在本次发布批次——先发布 ${name}（或加入批次），否则用户安装本包会 404/ETARGET`)
      }
    }
  }
  return { errors, warnings }
}

/** 密钥/本机信息扫描模式：打包产物里出现任何一种都拒绝发布。
 *  （移植自原 scripts/verify-publishable.mjs 的 tarball 逐文件扫描。
 *  认证令牌字段的模式用拼接构造，注释里也不写整串，
 *  否则扫描器会把自己的源码当成泄漏（自噬假阳性）。） */
const AUTH_TOKEN_RE = new RegExp('_auth' + 'Token', 'i')
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, 'API key 形态（sk-…）'],
  [/npm_[A-Za-z0-9]{20,}/, 'npm token 形态（npm_…）'],
  [AUTH_TOKEN_RE, 'npmrc 认证令牌字段'],
  [/[A-Za-z]:\\Users\\/i, '本机绝对路径（盘符:\\Users\\）'],
  [/\/(home|Users)\/[A-Za-z0-9._-]+\//, '本机绝对路径（/home/ / /Users/）'],
]

/** 扫描目录内全部文本文件，返回命中的密钥/本机信息描述串。 */
export function scanDirForSecrets(root) {
  const hits = []
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      let text = null
      try { text = fs.readFileSync(file, 'utf8') } catch { continue } /* 二进制/不可读跳过 */
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${label}`)
      }
    }
  }
  walk(root)
  return [...new Set(hits)]
}

/** 轻量 pack 闸：① npm pack --dry-run 断言分发必需文件真的会进包；
 *  ② 真实 pack + 解包 + 逐文件扫密钥/本机信息（凭据绝不上 npm）。
 *  （顶替原 verify-publishable 的核心断言；干净目录安装级检查不在这里重复。） */
export function packGateErrors(pkg, dir, npm) {
  const mustHave = ['package.json']
  if (pkg.main) mustHave.push(String(pkg.main).replace(/^\.\//, ''))
  const patch = pkg.dsh?.bundle?.patch
  for (const rel of Array.isArray(patch) ? patch : patch ? [patch] : []) {
    mustHave.push(String(rel).replace(/^\.\//, ''))
  }
  if (pkg.dsh?.client) mustHave.push('client/client.js')
  if (pkg.dsh?.suite) mustHave.push(String(pkg.dsh.suite).replace(/^\.\//, ''))
  const r = npm.rawNpmRun(['pack', '--dry-run', '--json'], { cwd: dir })
  if (r.status !== 0) return [`npm pack --dry-run 失败: ${String(r.stderr || r.stdout || '').trim().slice(0, 200)}`]
  let packed = []
  try {
    const parsed = JSON.parse(String(r.stdout))
    packed = (Array.isArray(parsed) ? parsed[0]?.files : parsed?.files)?.map((f) => f.path) || []
  } catch {
    return ['npm pack --dry-run 输出不可解析']
  }
  const errors = mustHave.filter((f) => !packed.includes(f)).map((f) => `分发必需文件未进包: ${f}`)

  /* 真实 pack + 解包 + 密钥扫描：发布产物里不该有任何凭据/本机信息。 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-scan-'))
  try {
    const pack = npm.rawNpmRun(['pack', '--pack-destination', tmp], { cwd: dir })
    if (pack.status !== 0) return [...errors, 'npm pack 失败（无法做密钥扫描）']
    const tgz = String(pack.stdout).trim().split(/\r?\n/).pop()
    const extract = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { cwd: tmp, encoding: 'utf8' })
    if (extract.status !== 0) return [...errors, 'tarball 解包失败（无法做密钥扫描）']
    const extracted = path.join(tmp, 'package')
    if (fs.existsSync(extracted)) {
      for (const hit of scanDirForSecrets(extracted)) errors.push(`密钥/本机信息进包: ${hit}`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return errors
}

/** 发布预检：npm 凭据状态（ambient：宿主已登录或 NODE_AUTH_TOKEN）。 */
export function npmWhoami() {
  const r = rawNpmRun(['whoami'])
  if (r.status !== 0) {
    return { ok: false, hint: 'npm whoami 失败——在宿主机 npm login，或设置 NODE_AUTH_TOKEN' }
  }
  return { ok: true, user: String(r.stdout).trim() }
}

/* ────────────────────────── 主流程（移植） ────────────────────────── */

/** 单包发布流程（插件与库共用）。返回结果记录。 */
async function publishOne(dir, { kind, localMap, batch, only, tag, skipTests, dryRun, npm, log }) {
  const pkg = pkgOf(dir)
  const label = `${pkg.name}@${pkg.version}`
  if (only && pkg.name !== only) return null

  const gate = kind === 'lib' ? libraryGateErrors(pkg) : publishGateErrors(pkg, dir)
  if (gate.length) {
    log(`✗ ${label} — 发布闸未过`)
    for (const item of gate) log(`    - ${item}`)
    return { label, status: 'gate-failed', detail: gate }
  }

  if (kind === 'plugin') {
    const validation = await validatePlugin(dir)
    if (!validation.valid) {
      log(`✗ ${label} — 插件校验未过`)
      for (const item of validation.errors) log(`    - [${item.rule}] ${item.message}`)
      return { label, status: 'invalid', detail: validation.errors.map((e) => e.message) }
    }
  }

  if (npm.alreadyPublished(pkg.name, pkg.version)) {
    /* 同版本漂移闸：npm pack 确定性 ⇒ 本地 sha1 == registry dist.shasum 当且仅当内容一致。 */
    const remoteSha = npm.npmShasumOf(pkg.name, pkg.version)
    const localSha = remoteSha ? npm.localShasumOf(dir) : null
    if (remoteSha && localSha && remoteSha !== localSha) {
      log(`✗ ${label} — 同版本内容漂移：registry ${remoteSha.slice(0, 8)} ≠ 本地 ${localSha.slice(0, 8)}`)
      log('    npm 不允许同版本重发，请 bump 版本后再发布')
      return { label, status: 'version-drift', detail: `shasum ${localSha} != ${remoteSha}` }
    }
    if (!remoteSha) log(`! ${label} — 无法获取 registry shasum（网络？），跳过漂移对比`)
    log(`· ${label} — registry 上已存在，跳过`)
    return { label, status: 'skipped-exists' }
  }

  /* pack 闸只对「真要发布」的包跑（真实 pack + 解包扫描很重，已发布的包由漂移闸把关）。 */
  if (kind === 'plugin') {
    const packErrors = packGateErrors(pkg, dir, npm)
    if (packErrors.length) {
      log(`✗ ${label} — pack 闸未过`)
      for (const item of packErrors) log(`    - ${item}`)
      return { label, status: 'pack-incomplete', detail: packErrors }
    }
  }

  /* 发布顺序闸（发布成功 ≠ 用户能装上）：依赖闭包须 registry 可解析或同批发布。 */
  const order = orderGate(pkg, localMap, batch, npm)
  if (order.errors.length) {
    log(`✗ ${label} — 发布顺序闸未过（发布后用户 npm install 会失败）`)
    for (const item of order.errors) log(`    - ${item}`)
    return { label, status: 'order-blocked', detail: order.errors }
  }
  for (const w of order.warnings) log(`! ${label} — ${w}`)

  if (!skipTests && pkg.scripts?.test) {
    const t = npm.rawNpmRun(['test'], { cwd: dir })
    if (t.status !== 0) {
      log(`✗ ${label} — npm test 失败，跳过发布`)
      return { label, status: 'test-failed', detail: (t.stdout || '') + (t.stderr || '') }
    }
  }

  if (dryRun) {
    log(`→ ${label} — 待发布（dry run${tag !== 'latest' ? `，dist-tag=${tag}` : ''}）`)
    return { label, status: 'would-publish' }
  }

  const access = pkg.publishConfig?.access || 'public'
  const expectedSha = npm.localShasumOf(dir)
  const pub = npm.rawNpmRun(['publish', '--access', access, '--tag', tag], { cwd: dir })
  if (pub.status !== 0) {
    log(`✗ ${label} — npm publish 失败`)
    log(String(pub.stderr || pub.stdout || '').trim().slice(0, 500))
    return { label, status: 'publish-failed', detail: (pub.stdout || '') + (pub.stderr || '') }
  }
  /* 发布后复核：registry 收到的 tarball 必须与本地 pack 逐字节一致（shasum）。 */
  let remoteSha = null
  for (let i = 0; i < 5 && !remoteSha; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
    remoteSha = npm.npmShasumOf(pkg.name, pkg.version)
  }
  if (remoteSha && expectedSha && remoteSha !== expectedSha) {
    log(`✗ ${label} — 发布后复核失败：registry ${remoteSha.slice(0, 8)} ≠ 本地 ${expectedSha.slice(0, 8)}（registry 可能收到脏产物，bump 后重发）`)
    return { label, status: 'publish-corrupted', detail: `shasum ${remoteSha} != ${expectedSha}` }
  }
  if (!remoteSha) log(`! ${label} — 发布后复核降级：registry shasum 暂不可见（副本延迟），请稍后人工核对`)
  log(`✓ ${label} — 已发布${tag !== 'latest' ? `（dist-tag=${tag}）` : ''}`)
  return { label, status: 'published' }
}

/** 解析工作区 root：参数 → DSH_PUBLISHER_ROOT。 */
export function resolveRoot(root) {
  const resolved = root || process.env.DSH_PUBLISHER_ROOT
  if (!resolved) return { error: '缺少工作区路径：传工具参数 root，或设置 DSH_PUBLISHER_ROOT' }
  const abs = path.resolve(resolved)
  if (!fs.existsSync(path.join(abs, 'package.json'))) return { error: `不是插件工程工作区（缺 package.json）: ${abs}` }
  return { root: abs }
}

/** 统一发布主流程：发现集 → 批次 → 先库后插件逐包过闸 →（dryRun ? 预演 : 真发布）。 */
export async function runPublish(options = {}) {
  const {
    only, tag = 'latest', skipTests = false, dryRun = true, libs, log = console.log,
  } = options
  const rootRes = resolveRoot(options.root)
  if (rootRes.error) return { ok: false, error: rootRes.error }
  const root = rootRes.root

  const supportLibs = Array.isArray(libs) && libs.length ? libs : DEFAULT_SUPPORT_LIBS
  const npm = createNpmContext()

  const results = []
  const libDirs = supportLibs.map((rel) => path.join(root, rel))
  for (const dir of libDirs) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      results.push({ label: dir, status: 'missing-dir', detail: [`支撑库目录缺失: ${dir}`] })
    }
  }
  const pluginDirs = discoverPlugins({ root })
  const usableLibDirs = libDirs.filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
  if (!usableLibDirs.length && !pluginDirs.length) {
    return { ok: false, root, error: '没有可发布的包（全部被发布闸拦下）', results, summary: {} }
  }

  log(`模式: ${dryRun ? 'DRY RUN（execute 才会真正发布）' : '执行发布'}${tag !== 'latest' ? `，dist-tag=${tag}` : ''}`)
  log(`候选: ${usableLibDirs.length} 个支撑库 + ${pluginDirs.length} 个插件\n`)

  /* 本次发布批次 = 候选中 registry 上尚不存在同名版本的包（顺序闸据此放行同批依赖）。 */
  const localMap = new Map()
  for (const dir of [...usableLibDirs, ...pluginDirs]) {
    const pkg = pkgOf(dir)
    localMap.set(pkg.name, { pkg, dir })
  }
  const batch = new Set(
    [...usableLibDirs, ...pluginDirs]
      .map((dir) => pkgOf(dir))
      .filter((pkg) => !only || pkg.name === only)
      .filter((pkg) => !npm.alreadyPublished(pkg.name, pkg.version))
      .map((pkg) => pkg.name),
  )

  const shared = { localMap, batch, only, tag, skipTests, dryRun, npm, log }
  // 先库后插件：plugin-kit 等支撑库必须先上 registry，插件发布时依赖才可解析
  for (const dir of usableLibDirs) results.push(await publishOne(dir, { kind: 'lib', ...shared }))
  for (const dir of pluginDirs) results.push(await publishOne(dir, { kind: 'plugin', ...shared }))

  const done = results.filter(Boolean)
  const summary = done.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1
    return acc
  }, {})
  log(`\n汇总: ${JSON.stringify(summary)}`)

  return { ok: !done.some((r) => FAILURE_STATUSES.includes(r.status)), root, results: done, summary }
}

/** 契约探针实现。 */
export function capabilities() {
  return {
    contractVersion: '1.0.0',
    tools: ['publisher_whoami', 'publisher_preview', 'publisher_execute', 'publisher_capabilities'],
    defaults: { port: 39700, tag: 'latest' },
  }
}

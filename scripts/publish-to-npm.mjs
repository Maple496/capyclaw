#!/usr/bin/env node
/**
 * 统一发布到 npm：插件 + 支撑库走同一条命令。
 *
 * 设计：
 *   - 复用 tools/capyclaw-plugin-release 的同一套判定（插件校验 + 发布闸 + 包名白名单），
 *     不再自己维护一份扫描列表，避免两条发布路径的清单不一致。
 *   - 支撑库（纯库/独立服务，无 dsh.bundle，进不了插件闸）用 SUPPORT_LIBS 显式清单
 *     + 库发布闸；历史上它们靠 PUBLISHING.md 里的手动命令发布，最易漏发。
 *   - 发布顺序固定为「先库后插件」：@capyclaw/plugin-kit 必须先于消费它的插件上 registry。
 *   - 只发布**原始包目录**（依赖交给 npm 从 registry 解析）；
 *     带 vendored 依赖的 staged 副本只用于 zip 分发，不走 npm。
 *   - 默认 dry-run；显式 --execute 才真正 publish。
 *   - --tag <dist-tag> 透传 npm publish --tag（默认 latest），与 release-index 的
 *     --channel 语义对应：channel=stable ↔ latest，channel=next ↔ next。
 *
 * 用法：
 *   node scripts/publish-to-npm.mjs [--dry-run|--execute] [--skip-tests] [--only <name>] [--tag <dist-tag>]
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { discoverPlugins, publishGateErrors } from '../tools/capyclaw-plugin-release/lib/index.mjs'
import { validatePlugin } from '../tools/capyclaw-plugin-validator/lib/index.mjs'
import { ROOT, SUPPORT_LIBS, pkgOf } from './lib/publish-set.mjs'

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const execute = hasFlag('--execute') && !hasFlag('--dry-run')
const skipTests = hasFlag('--skip-tests')
const only = valueOf('--only')
const tag = valueOf('--tag') || 'latest'

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    ...options,
  })
}

/** npm 直调（node npm-cli.js，不走 shell）：含空格的临时/用户目录不会被拆词。 */
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmRun = (args, options = {}) => (fs.existsSync(NPM_CLI)
  ? spawnSync(process.execPath, [NPM_CLI, ...args], { encoding: 'utf8', stdio: 'pipe', ...options })
  : run('npm', args, options))

/** npm view 结果缓存：同一次运行里同一 specifier 只查一次
 *  （批次构建 + 逐包发布 + 顺序闸原本会对同一 name@version 反复网络往返）。 */
const viewCache = new Map()
function npmView(spec, field) {
  const key = `${spec}|${field}`
  if (!viewCache.has(key)) viewCache.set(key, npmRun(['view', spec, field]))
  return viewCache.get(key)
}

function alreadyPublished(name, version) {
  const r = npmView(`${name}@${version}`, 'version')
  if (r.status !== 0) return false
  return String(r.stdout).trim() === version
}

/** registry 上已发布 tarball 的 sha1（拿不到返回 null，网络闪断降级为警告）。 */
function npmShasumOf(name, version) {
  const r = npmView(`${name}@${version}`, 'dist.shasum')
  if (r.status !== 0) return null
  return String(r.stdout).trim() || null
}

/** 本地 npm pack 产物的 sha1（npm pack 确定性：同内容同哈希，可与 dist.shasum 对比）。
 *  结果按目录缓存，避免同一次运行重复 pack。 */
const localShasumCache = new Map()
function localShasumOf(dir) {
  if (localShasumCache.has(dir)) return localShasumCache.get(dir)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-sha-'))
  try {
    const pack = npmRun(['pack', '--pack-destination', tmp], { cwd: dir })
    if (pack.status !== 0) return null
    const tgz = path.join(tmp, String(pack.stdout).trim().split(/\r?\n/).pop())
    const sha = crypto.createHash('sha1').update(fs.readFileSync(tgz)).digest('hex')
    localShasumCache.set(dir, sha)
    return sha
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** 本仓全部可发布包：npm 名 → { pkg, dir }（支撑库 + 插件）。 */
function localPackageMap() {
  const map = new Map()
  const dirs = [
    ...SUPPORT_LIBS.map((rel) => path.join(ROOT, rel)),
    ...discoverPlugins(),
  ]
  for (const dir of dirs) map.set(pkgOf(dir).name, { pkg: pkgOf(dir), dir })
  return map
}

/** 发布顺序闸：待发包的 @capyclaw 依赖闭包，每一项必须满足其一——
 *  ① registry 上已有满足 range 的版本（npm view name@range 可解析）；
 *  ② 在本次发布批次里（同批上 registry）。
 *  拦截「只发 canvas-suite 不发 document-workbench」这类顺序手滑：
 *  发布成功 ≠ 用户能装上（依赖 404/ETARGET 时 npm install 直接失败）。
 *  返回 { errors, warnings }。 */
function orderGate(pkg, localMap, batch) {
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
      const resolvable = npmView(`${name}@${range}`, 'version')
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

/** 库发布闸：插件闸管不了的分发必需项。返回错误串数组。 */
function libraryGateErrors(pkg) {
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

/** 单包发布流程（插件与库共用）。返回结果记录。 */
async function publishOne(dir, { kind, localMap, batch }) {
  const pkg = pkgOf(dir)
  const label = `${pkg.name}@${pkg.version}`
  if (only && pkg.name !== only) return null

  const gate = kind === 'lib' ? libraryGateErrors(pkg) : publishGateErrors(pkg, dir)
  if (gate.length) {
    console.log(`✗ ${label} — 发布闸未过`)
    for (const item of gate) console.log(`    - ${item}`)
    return { label, status: 'gate-failed', detail: gate }
  }

  if (kind === 'plugin') {
    const validation = await validatePlugin(dir)
    if (!validation.valid) {
      console.log(`✗ ${label} — 插件校验未过`)
      for (const item of validation.errors) console.log(`    - [${item.rule}] ${item.message}`)
      return { label, status: 'invalid', detail: validation.errors.map((e) => e.message) }
    }
  }

  if (alreadyPublished(pkg.name, pkg.version)) {
    /* 同版本漂移闸：npm pack 确定性 ⇒ 本地 sha1 == registry dist.shasum 当且仅当内容一致。
     * 不一致 = 同版本号发了不同内容（npm 禁止重发同版本），必须 bump 才能发布。 */
    const remoteSha = npmShasumOf(pkg.name, pkg.version)
    const localSha = remoteSha ? localShasumOf(dir) : null
    if (remoteSha && localSha && remoteSha !== localSha) {
      console.log(`✗ ${label} — 同版本内容漂移：registry ${remoteSha.slice(0, 8)} ≠ 本地 ${localSha.slice(0, 8)}`)
      console.log('    npm 不允许同版本重发，请 bump 版本后再发布')
      return { label, status: 'version-drift', detail: `shasum ${localSha} != ${remoteSha}` }
    }
    if (!remoteSha) console.log(`! ${label} — 无法获取 registry shasum（网络？），跳过漂移对比`)
    console.log(`· ${label} — registry 上已存在，跳过`)
    return { label, status: 'skipped-exists' }
  }

  /* 发布顺序闸（发布成功 ≠ 用户能装上）：依赖闭包须 registry 可解析或同批发布。 */
  const order = orderGate(pkg, localMap, batch)
  if (order.errors.length) {
    console.log(`✗ ${label} — 发布顺序闸未过（发布后用户 npm install 会失败）`)
    for (const item of order.errors) console.log(`    - ${item}`)
    return { label, status: 'order-blocked', detail: order.errors }
  }
  for (const w of order.warnings) console.log(`! ${label} — ${w}`)

  if (!skipTests && pkg.scripts?.test) {
    const t = npmRun(['test'], { cwd: dir })
    if (t.status !== 0) {
      console.log(`✗ ${label} — npm test 失败，跳过发布`)
      return { label, status: 'test-failed', detail: (t.stdout || '') + (t.stderr || '') }
    }
  }

  if (!execute) {
    console.log(`→ ${label} — 待发布（dry run${tag !== 'latest' ? `，dist-tag=${tag}` : ''}）`)
    return { label, status: 'would-publish' }
  }

  const access = pkg.publishConfig?.access || 'public'
  const expectedSha = localShasumOf(dir)
  const pub = npmRun(['publish', '--access', access, '--tag', tag], { cwd: dir })
  if (pub.status !== 0) {
    console.log(`✗ ${label} — npm publish 失败`)
    console.log(String(pub.stderr || pub.stdout || '').trim().slice(0, 500))
    return { label, status: 'publish-failed', detail: (pub.stdout || '') + (pub.stderr || '') }
  }
  /* 发布后复核：registry 收到的 tarball 必须与本地 pack 逐字节一致（shasum）。
   * 捕获「发布窗口内源码/锁被并发改写，脏产物上了 registry」的静默污染。 */
  let remoteSha = null
  for (let i = 0; i < 5 && !remoteSha; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
    remoteSha = npmShasumOf(pkg.name, pkg.version)
  }
  if (remoteSha && expectedSha && remoteSha !== expectedSha) {
    console.log(`✗ ${label} — 发布后复核失败：registry ${remoteSha.slice(0, 8)} ≠ 本地 ${expectedSha.slice(0, 8)}（registry 可能收到脏产物，bump 后重发）`)
    return { label, status: 'publish-corrupted', detail: `shasum ${remoteSha} != ${expectedSha}` }
  }
  if (!remoteSha) console.log(`! ${label} — 发布后复核降级：registry shasum 暂不可见（副本延迟），请稍后人工核对`)
  console.log(`✓ ${label} — 已发布${tag !== 'latest' ? `（dist-tag=${tag}）` : ''}`)
  return { label, status: 'published' }
}

async function main() {
  const libDirs = SUPPORT_LIBS.map((rel) => path.join(ROOT, rel)).filter((dir) => {
    if (fs.existsSync(path.join(dir, 'package.json'))) return true
    console.error(`支撑库目录缺失: ${dir}`)
    process.exitCode = 1
    return false
  })
  const pluginDirs = discoverPlugins()
  if (!libDirs.length && !pluginDirs.length) {
    console.error('没有可发布的包（全部被发布闸拦下）')
    process.exitCode = 1
    return
  }

  console.log(`模式: ${execute ? '执行发布' : 'DRY RUN（加 --execute 才会真正发布）'}${tag !== 'latest' ? `，dist-tag=${tag}` : ''}`)
  console.log(`候选: ${libDirs.length} 个支撑库 + ${pluginDirs.length} 个插件\n`)

  /* 本次发布批次 = 候选中 registry 上尚不存在同名版本的包（顺序闸据此放行同批依赖）。 */
  const localMap = localPackageMap()
  const batch = new Set(
    [...libDirs, ...pluginDirs]
      .map((dir) => pkgOf(dir))
      .filter((pkg) => !only || pkg.name === only)
      .filter((pkg) => !alreadyPublished(pkg.name, pkg.version))
      .map((pkg) => pkg.name),
  )

  const results = []
  // 先库后插件：plugin-kit 等支撑库必须先上 registry，插件发布时依赖才可解析
  for (const dir of libDirs) results.push(await publishOne(dir, { kind: 'lib', localMap, batch }))
  for (const dir of pluginDirs) results.push(await publishOne(dir, { kind: 'plugin', localMap, batch }))

  const done = results.filter(Boolean)
  const summary = done.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1
    return acc
  }, {})
  console.log('\n汇总:', JSON.stringify(summary))

  const failed = done.filter((r) => ['gate-failed', 'invalid', 'test-failed', 'publish-failed', 'publish-corrupted', 'version-drift', 'order-blocked'].includes(r.status))
  if (failed.length) {
    console.error(`\n${failed.length} 个包未发布：${failed.map((f) => f.label).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('发布脚本异常:', error.message)
  process.exitCode = 1
})

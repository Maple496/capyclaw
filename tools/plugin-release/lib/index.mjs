/**
 * DSH 插件发布工具（生产中心侧）。
 *
 * 职责：把 extensions/ 里的插件变成可分发的 zip，并把一批 zip 组织成一个
 * 「源」（index.json + plugins/*.zip）。源本身可以整体再打成一个 zip，
 * 便于一次性传播——消费方只需要知道源的地址，不需要知道生产中心存在。
 *
 * 三步：
 *   releasePlugin(plugin)  → dist/plugins/<name>-<version>.zip
 *   buildIndex(dist)       → dist/index.json
 *   packSource(dist)       → dsh-plugin-source-<stamp>.zip（单一文件）
 *
 * 发布闸 = 插件验证器（tools/plugin-validator）+ 分发必需项：
 *   - engines.dsh 声明兼容运行时（消费方据此判断能不能装）
 *   - dsh.bundle.patch 指向的文件真实存在（否则 dsh 启动会静默跳过）
 *   - 依赖里不许有 link:/file:（分发件不能依赖源码树位置）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { validatePlugin } from '../../plugin-validator/lib/index.mjs'
import { stagePlugin, setManifestValidators } from '@capyclaw/plugin-kit/packaging/pack'
import { writeZipFromDir } from '@capyclaw/plugin-kit/packaging/zip'
import { validateSuiteManifest } from '../../../packages/dsh-suite-kit/src/manifest.mjs'
import { validateDomainManifest } from '../../../packages/dsh-suite-kit/src/domain.mjs'

// 打包时的 suite/domain 语义校验由发布工具注入（plugin-kit 自身不依赖 suite-kit，
// 以保证它作为独立 npm 包可安装）。
setManifestValidators({ validateSuiteManifest, validateDomainManifest })

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '../../..')
export const DEFAULT_OUT = path.join(REPO_ROOT, 'dist')

/** 发布闸：验证器不管、但分发必需的项。返回错误串数组。 */
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

/** 插件扫码根目录（仓库内真实存在的插件位置）。 */
const PLUGIN_BASES = ['extensions/official', 'extensions/suites', 'extensions/bridges', 'extensions/flow', 'extensions/llm-config']

/** 可发布的包名形态：dsh-<name> / @org/dsh-<name> / 已发布作用域 @capyclaw/<name>。 */
const PUBLISHABLE_NAME = /^((@[\w.-]+\/)?dsh-[\w.-]+|@capyclaw\/[\w.-]+)$/

/** 包名 → 可能的目录名候选。
 *  `@capyclaw/port-sidebar` 在磁盘上是 `capyclaw-port-sidebar`，要能对上；
 *  裸名 `port-sidebar` 也要能命中 `capyclaw-port-sidebar`。 */
function dirNameCandidates(name) {
  const out = new Set([name])
  if (name.startsWith('@') && name.includes('/')) {
    const [scope, base] = name.slice(1).split('/')
    out.add(`${scope}-${base}`)  // @capyclaw/x → capyclaw-x
    out.add(base)                // 也容忍裸目录名
  }
  if (name.startsWith('dsh-')) out.add(name.slice(4))
  else if (!name.startsWith('@')) {
    out.add(`dsh-${name}`)
    out.add(`capyclaw-${name}`)  // 官方插件改名后的落位
  }
  return [...out]
}

/** 目录名/包名 → 插件目录。支持直接给路径，也支持给包名（含 @scope/name）。 */
export function resolvePluginDir(nameOrPath, { root = REPO_ROOT } = {}) {
  // `@scope/name` 里的斜杠属于包名，不是路径分隔符
  const isScopedPkg = /^@[\w.-]+\/[\w.-]+$/.test(nameOrPath)
  const looksLikePath = !isScopedPkg && (/[\\/]/.test(nameOrPath) || nameOrPath.startsWith('.'))
  if (looksLikePath) {
    const abs = path.resolve(root, nameOrPath)
    if (!fs.existsSync(path.join(abs, 'package.json'))) {
      throw new Error(`不是插件目录（缺 package.json）: ${abs}`)
    }
    return abs
  }
  const candidates = dirNameCandidates(nameOrPath)
  for (const base of PLUGIN_BASES) {
    for (const candidate of candidates) {
      const dir = path.join(root, base, candidate)
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    }
  }
  throw new Error(`找不到插件: ${nameOrPath}（已查找 ${PLUGIN_BASES.join(' / ')}，候选目录名 ${candidates.join(' / ')}）`)
}

/** 找出本仓所有**可发布**的插件目录（过得了发布闸的才算）。
 *  未就绪的插件（缺 engines.dsh / link: 依赖 / 没 patch）不进清单——
 *  `release --all` 不该被半成品插件永久染红；它们仍可用 `release <路径>`
 *  单独发布并看到具体原因。 */
export function discoverPlugins({ root = REPO_ROOT, includeNotReady = false } = {}) {
  const out = []
  const skipped = []
  const bases = PLUGIN_BASES
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
  for (const base of bases) {
    const dir = path.join(root, base)
    if (fs.existsSync(dir)) visit(dir)
  }
  out.sort()
  discoverPlugins.lastSkipped = skipped.sort((a, b) => a.name.localeCompare(b.name))
  return includeNotReady ? [...out, ...skipped.map((s) => s.dir)].sort() : out
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let read
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** 在仓里找某个包名对应的源码目录（workspace 包），找不到返回 undefined。 */
function workspacePackageDir(name, { root }) {
  const candidates = [
    path.join(root, 'packages', name),
    path.join(root, 'extensions/official', name),
    path.join(root, 'extensions/suites', name),
    path.join(root, 'node_modules', name),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** 收集要随包内置的依赖（裸导入在独立安装目录里必须能解析到）。 */
function collectVendors(pkg, { root, vendor = true }) {
  if (!vendor) return []
  const found = new Map()
  const queue = Object.keys(pkg.dependencies || {})
  while (queue.length) {
    const name = queue.shift()
    if (found.has(name)) continue
    const dir = workspacePackageDir(name, { root })
    if (!dir) continue // 外部 npm 包：消费方侧由运行时依赖解析，不在发布闸范围
    const depPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    found.set(name, dir)
    for (const dep of Object.keys(depPkg.dependencies || {})) {
      if (!found.has(dep)) queue.push(dep)
    }
  }
  return [...found.entries()].map(([name, dir]) => ({ name, dir }))
}

function copyVendor(srcDir, destDir) {
  const skip = new Set(['node_modules', '.git', 'test', 'dist', 'coverage', '__pycache__', '.cache'])
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const s = path.join(from, entry.name)
      const d = path.join(to, entry.name)
      if (entry.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d) }
      else if (entry.isFile()) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d) }
    }
  }
  copy(srcDir, destDir)
}

/** 发布单个插件 → { outFile, pkg }。先过规范闸，再过发布闸。 */
export async function releasePlugin(nameOrPath, { out = DEFAULT_OUT, root = REPO_ROOT, vendor = true } = {}) {
  const srcDir = resolvePluginDir(nameOrPath, { root })
  const validation = await validatePlugin(srcDir)
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `- [${e.rule}] ${e.message}`).join('\n')
    throw new Error(`${path.basename(srcDir)} 未通过插件规范验证:\n${detail}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  const gateErrors = publishGateErrors(pkg, srcDir)
  if (gateErrors.length) {
    throw new Error(`${pkg.name}@${pkg.version} 未通过发布闸:\n${gateErrors.map((e) => `- ${e}`).join('\n')}`)
  }

  const outDir = path.join(out, 'plugins')
  fs.mkdirSync(outDir, { recursive: true })
  // @scope/name 里的 / 不能在文件名里出现，否则会落到子目录、索引扫不到
  const flatName = pkg.name.startsWith('@')
    ? pkg.name.slice(1).replace('/', '-')
    : pkg.name
  const target = path.join(outDir, `${flatName}-${pkg.version}.zip`)
  const staging = path.join(out, `.stage-${flatName}-${process.pid}`)
  try {
    const staged = stagePlugin({ srcDir, destDir: staging })
    const vendors = collectVendors(pkg, { root, vendor })
    for (const item of vendors) copyVendor(item.dir, path.join(staging, 'node_modules', item.name))
    writeZipFromDir(staging, target)
    return { outFile: target, pkg, files: staged.files, vendored: vendors.map((v) => v.name) }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// ZIP 读：已收敛到 dsh-plugin-kit/src/zip.mjs 单一真源；此处仅保留原导出签名。
// ---------------------------------------------------------------------------

export { listZipEntryNames, readZipEntryBuffer } from '@capyclaw/plugin-kit/packaging/zip'
import { readZipEntryBuffer as _readZipEntryBuffer } from '@capyclaw/plugin-kit/packaging/zip'

/** 从 ZIP 读单个条目的原始字节（本地文件路径版）。 */
export function readZipEntry(zipFile, entryName) {
  return _readZipEntryBuffer(zipFile, entryName, zipFile)
}


// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

function parseSemver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text || ''))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

/** semver 升序比较（预发布 < 正式；预发布按点段数字/字典比较）。 */
export function compareVersions(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return String(a).localeCompare(String(b))
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] - y[key]
  }
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) { if (+p !== +q) return +p - +q; continue }
    if (pn) return -1
    if (qn) return 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** 扫 dist/plugins/*.zip，重建 dist/index.json。 */
export function buildIndex(distDir = DEFAULT_OUT, { channel = 'stable' } = {}) {
  const pluginsDir = path.join(distDir, 'plugins')
  const entries = []
  if (fs.existsSync(pluginsDir)) {
    for (const file of fs.readdirSync(pluginsDir).sort()) {
      if (!file.toLowerCase().endsWith('.zip')) continue
      const zipFile = path.join(pluginsDir, file)
      const raw = readZipEntry(zipFile, 'package.json')
      if (!raw) continue
      let pkg
      try { pkg = JSON.parse(raw.toString('utf8')) } catch { continue }
      if (!pkg.name || !pkg.version) continue
      entries.push({
        name: pkg.name,
        version: pkg.version,
        title: pkg.meta?.title || pkg.name,
        description: pkg.meta?.description || pkg.description || '',
        category: pkg.dsh?.category || '',
        platform: pkg.dsh?.platform || '',
        bundle: Boolean(pkg.dsh?.bundle),
        client: Boolean(pkg.dsh?.client),
        dsh: pkg.engines?.dsh || '',
        file: `plugins/${file}`,
        sha256: sha256File(zipFile),
        size: fs.statSync(zipFile).size,
      })
    }
  }
  entries.sort((a, b) => a.name === b.name ? compareVersions(b.version, a.version) : a.name.localeCompare(b.name))
  const latest = new Map()
  for (const entry of entries) if (!latest.has(entry.name)) latest.set(entry.name, entry.version)
  for (const entry of entries) entry.latest = latest.get(entry.name) === entry.version

  const index = {
    schema: 1,
    channel,
    generatedAt: new Date().toISOString(),
    plugins: entries,
  }
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(distDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  return index
}

/** 把整个源目录打成一个可传播的单一文件（zip 落在源目录之外，避免自包含）。 */
export function packSource(distDir = DEFAULT_OUT, { outFile } = {}) {
  if (!fs.existsSync(path.join(distDir, 'index.json'))) buildIndex(distDir)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  // 默认落在 <源上一层>/release/，不污染仓根、也不会被下次 buildIndex 扫到
  const target = outFile || path.join(path.dirname(distDir), 'release', `dsh-plugin-source-${stamp}.zip`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const files = writeZipFromDir(distDir, target)
  return { outFile: target, files: files.length }
}

// ---------------------------------------------------------------------------
// 源读取（消费方语义的参考实现；生产中心自测与 CLI 复用）
// ---------------------------------------------------------------------------

export function readIndex(distDir = DEFAULT_OUT) {
  const file = path.join(distDir, 'index.json')
  if (!fs.existsSync(file)) throw new Error(`源缺少 index.json: ${distDir}`)
  const index = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (index.schema !== 1 || !Array.isArray(index.plugins)) {
    throw new Error(`index.json 形状不合法（schema 必须是 1，plugins 必须是数组）: ${file}`)
  }
  return index
}

/** 在索引里选版本：显式版本优先，否则取 latest。 */
export function pickEntry(index, name, version) {
  const candidates = index.plugins.filter((p) => p.name === name)
  if (!candidates.length) throw new Error(`源里没有插件: ${name}`)
  if (version) {
    const hit = candidates.find((p) => p.version === version)
    if (!hit) throw new Error(`源里没有 ${name}@${version}`)
    return hit
  }
  return candidates.find((p) => p.latest) || candidates[0]
}

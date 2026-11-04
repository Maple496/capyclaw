#!/usr/bin/env node
/**
 * 死代码扫描 v2（import 图解析，输出供人工复核）：
 *
 *   - 解析全仓 .mjs 的 import 说明符（静态 import / 动态 import() / require），
 *     相对路径 resolve 到真实文件，裸包名映射到 packages/<name>；
 *   - 入口集合 = package.json 的 bin/main + scripts.test 文件清单 + root scripts；
 *   - 零引用文件 = 不在入口集合、也没有任何 import 边指向它的文件；
 *   - 零引用导出 = 符号在自身文件之外从未出现（桶文件跳过）。
 *
 * 扫描范围排除 vendored/生成物：extensions（独立 git 仓库）、core-harness、bundles、
 * release、archives、node_modules、dist、build、coverage、results。
 *
 * 用法：node scripts/scan-dead-code.mjs [--json out.json] [--include-examples]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INCLUDE_EXAMPLES = process.argv.includes('--include-examples')

const SCAN_ROOTS = ['packages', 'scripts', 'tools', 'evolution']
const EXCLUDE_PATH_PARTS = [
  path.join('extensions'),
  path.join('apps'),
  path.join('out'),
  path.join('bundles'),
  path.join('archives'),
]
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'results'])

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (EXCLUDE_PATH_PARTS.some((part) => full.includes(part))) continue
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      if (!INCLUDE_EXAMPLES && entry.name === 'examples') continue
      walk(full, files)
    } else if (entry.isFile() && full.endsWith('.mjs')) {
      files.push(full)
    }
  }
  return files
}

const files = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO, root)))
const fileSet = new Set(files.map((file) => path.resolve(file)))

const contents = new Map()
for (const file of files) {
  try { contents.set(path.resolve(file), fs.readFileSync(file, 'utf8')) } catch { contents.set(path.resolve(file), '') }
}

/* ------------------------------------------------------------ 入口集合 */
const entryFiles = new Set()
const pkgDirs = []
function collectPkgDirs(dir, depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (EXCLUDE_PATH_PARTS.some((part) => full.includes(part))) continue
    if (EXCLUDE_DIRS.has(entry.name) || entry.name === 'examples') continue
    if (fs.existsSync(path.join(full, 'package.json'))) pkgDirs.push(full)
    collectPkgDirs(full, depth + 1)
  }
}
for (const root of ['packages', 'tools']) {
  const rootDir = path.join(REPO, root)
  if (fs.existsSync(path.join(rootDir, 'package.json'))) pkgDirs.push(rootDir)
  collectPkgDirs(rootDir)
}
const packageMainByName = new Map()
for (const pkgDir of pkgDirs) {
  const pkgFile = path.join(pkgDir, 'package.json')
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { continue }
  if (pkg.name && typeof pkg.main === 'string') {
    packageMainByName.set(pkg.name, path.resolve(pkgDir, pkg.main))
  }
  if (typeof pkg.main === 'string') entryFiles.add(path.resolve(pkgDir, pkg.main))
  // exports map 指向的文件是公共 API（外部消费者），视为入口
  const collectExports = (value) => {
    if (typeof value === 'string' && value.endsWith('.mjs')) entryFiles.add(path.resolve(pkgDir, value))
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collectExports(item)
  }
  collectExports(pkg.exports)
  for (const binPath of Object.values(pkg.bin || {})) {
    entryFiles.add(path.resolve(pkgDir, binPath))
  }
  // npm scripts 的显式 .mjs 清单视为入口（create/pack/test 等所有脚本）
  for (const script of Object.values(pkg.scripts || {})) {
    for (const part of String(script).split(/\s+/)) {
      if (part.endsWith('.mjs') && !part.startsWith('--')) {
        entryFiles.add(path.resolve(pkgDir, part))
      }
    }
  }
}
// root scripts 里的入口
try {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  for (const script of Object.values(rootPkg.scripts || {})) {
    for (const part of String(script).split(/\s+/)) {
      if (part.endsWith('.mjs')) entryFiles.add(path.resolve(REPO, part))
    }
  }
} catch { /* 忽略 */ }

/* ------------------------------------------------------------ import 图 */
const SPEC_RE = /(?:from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g

function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec)
    const candidates = [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]
    for (const candidate of candidates) {
      if (fileSet.has(path.resolve(candidate))) return path.resolve(candidate)
    }
    return null
  }
  // 裸包名（可能带子路径）
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  const mapped = packageMainByName.get(name)
  return mapped ? path.resolve(mapped) : null
}

const importedBy = new Map() // target -> Set(importer)
for (const file of files) {
  const text = contents.get(path.resolve(file)) || ''
  let match
  while ((match = SPEC_RE.exec(text)) !== null) {
    const spec = match[1] || match[2] || match[3]
    const target = resolveSpecifier(file, spec)
    if (!target) continue
    if (!importedBy.has(target)) importedBy.set(target, new Set())
    importedBy.get(target).add(path.resolve(file))
  }
}

/* ------------------------------------------------------- 零引用文件 */
const deadFiles = []
for (const file of files) {
  const abs = path.resolve(file)
  const rel = path.relative(REPO, abs).replace(/\\/g, '/')
  if (rel.includes('/test/') || rel.includes('/bin/') || rel.startsWith('scripts/') || rel.startsWith('evolution/')) continue
  if (rel.endsWith('/index.mjs')) continue
  if (entryFiles.has(abs)) continue
  if (importedBy.has(abs) && importedBy.get(abs).size > 0) continue
  deadFiles.push(rel)
}

/* ------------------------------------------------------- 零引用导出 */
// barrel（index.mjs 的 export *）承担公共契约：其目标模块的导出视为公共 API
const barrelTargets = new Set()
for (const [abs, text] of contents) {
  if (!abs.endsWith('index.mjs')) continue
  const re = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(text)) !== null) {
    const target = resolveSpecifier(abs, match[1])
    if (target) barrelTargets.add(target)
  }
}

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm
const deadExports = []
for (const file of files) {
  const abs = path.resolve(file)
  const rel = path.relative(REPO, abs).replace(/\\/g, '/')
  if (rel.includes('/test/') || rel.includes('/bin/') || rel.endsWith('/index.mjs') || rel.startsWith('scripts/')) continue
  if (entryFiles.has(abs)) continue // 公共 API 模块：导出由外部消费者使用，无法静态判定
  if (barrelTargets.has(abs)) continue // 由 barrel 重新导出：公共契约的一部分
  const text = contents.get(abs)
  let match
  while ((match = EXPORT_RE.exec(text)) !== null) {
    const name = match[1]
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    let referenced = false
    for (const [otherAbs, otherText] of contents) {
      if (otherAbs === abs) continue
      if (re.test(otherText)) { referenced = true; break }
    }
    if (!referenced) deadExports.push({ file: rel, name })
  }
}

/* ---------------------------------------------------------------- 输出 */
console.log(`\n=== 死代码扫描 v2（${files.length} 个 .mjs，import 图解析）===`)
console.log(`\n零引用文件（${deadFiles.length}）:`)
for (const file of deadFiles) console.log(`  ✗ ${file}`)
if (!deadFiles.length) console.log('  （无）')

console.log(`\n零引用导出（${deadExports.length}）:`)
for (const item of deadExports) console.log(`  ✗ ${item.file} → ${item.name}`)
if (!deadExports.length) console.log('  （无）')

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex >= 0) {
  const out = process.argv[jsonIndex + 1]
  fs.writeFileSync(out, JSON.stringify({ scanned: files.length, deadFiles, deadExports }, null, 2))
  console.log(`\n已写入 ${out}`)
}

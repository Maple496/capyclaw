#!/usr/bin/env node
/**
 * 插件分层与依赖关系提取（只读分析，不改任何文件）
 *
 * 输出三张表：
 *   1. 每个服务谁提供、谁消费（基于 ctx.<name> 与 inject 声明）
 *   2. 包级依赖边（package.json 内部依赖）
 *   3. 按"提供/消费"推断的层级
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOTS = [
  'packages',
  'extensions/official',
  'extensions/bridges/ppt-bridge/plugin',
  'extensions/flow/dsh-flow-engine/plugin',
  'extensions/llm-config/dsh-llm-config/plugin',
]

const SKIP_DIRS = new Set(['node_modules', '.venv', 'dist', 'test', 'fixtures', 'fixture', 'archives'])

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(mjs|js)$/.test(e.name)) acc.push(p)
  }
  return acc
}

function pkgOf(file) {
  const root = pkgRootOf(file)
  if (!root) return '?'
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name } catch { return '?' }
}

/** 向上找到最近的、含 package.json 的目录（= 包根） */
function pkgRootOf(file) {
  let d = path.dirname(file)
  const root = path.parse(d).root
  while (d !== root) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d
    d = path.dirname(d)
  }
  return null
}

const files = ROOTS.flatMap((d) => walk(d))
const byPkg = new Map()
for (const f of files) {
  const p = pkgOf(f)
  if (!byPkg.has(p)) byPkg.set(p, [])
  byPkg.get(p).push(f)
}

// ---------- 1. 服务提供/消费 ----------

const SERVICES = [
  'assets', 'catalog', 'editorHost', 'installer', 'llmTempkey', 'mcpGateway',
  'runtimeControl', 'scrapling', 'serviceBroker', 'serviceHost', 'skills',
  'state', 'toolHost', 'workspace',
]

console.log('='.repeat(78))
console.log('1. CTX 服务：谁提供、谁消费')
console.log('='.repeat(78))

const providers = new Map()   // service -> Set(pkg)
const consumers = new Map()   // service -> Set(pkg)

for (const [pkg, list] of byPkg) {
  for (const f of list) {
    const src = fs.readFileSync(f, 'utf8')

    for (const s of SERVICES) {
      // provide
      const provideRe = new RegExp(`ctx\\.provide\\(\\s*['"\`]${s}['"\`]`, 'g')
      if (provideRe.test(src)) {
        if (!providers.has(s)) providers.set(s, new Set())
        providers.get(s).add(pkg)
      }
      // consume via ctx.<s>
      const useRe = new RegExp(`ctx\\.${s}\\b`, 'g')
      if (useRe.test(src)) {
        if (!consumers.has(s)) consumers.set(s, new Set())
        consumers.get(s).add(pkg)
      }
      // consume via inject 声明
      const injectRe = new RegExp(`inject\\s*=\\s*\\[[^\\]]*['"\`]${s}['"\`][^\\]]*\\]`, 'g')
      if (injectRe.test(src)) {
        if (!consumers.has(s)) consumers.set(s, new Set())
        consumers.get(s).add(pkg)
      }
    }
  }
}

for (const s of SERVICES) {
  const prov = providers.get(s) ? [...providers.get(s)] : []
  const cons = [...(consumers.get(s) || [])].filter((p) => !prov.includes(p))
  console.log(
    `  ${s.padEnd(15)} 提供: ${(prov.join(',') || '—').padEnd(24)} 消费: ${cons.length ? cons.join(', ') : '—'}`,
  )
}

console.log('')
console.log('='.repeat(78))
console.log('2. 包级内部依赖（package.json）')
console.log('='.repeat(78))

const found = []
const seenRoots = new Set()
for (const [, list] of byPkg) {
  for (const f of list) {
    const dir = pkgRootOf(f)
    if (!dir || seenRoots.has(dir)) continue
    seenRoots.add(dir)
    try { found.push({ dir, p: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) }) } catch { /* ignore */ }
  }
}
const names = new Set(found.map((f) => f.p.name))
let edgeCount = 0
const inbound = new Map()
for (const f of found) {
  const deps = { ...(f.p.dependencies || {}), ...(f.p.peerDependencies || {}) }
  const inner = Object.keys(deps).filter((n) => names.has(n))
  if (!inner.length) continue
  edgeCount += inner.length
  for (const n of inner) inbound.set(n, (inbound.get(n) || 0) + 1)
  console.log(`  ${f.p.name.padEnd(34)} -> ${inner.join(', ')}`)
}
console.log(`\n  内部依赖边总数: ${edgeCount}`)
console.log('  被依赖最多的包（入度）:')
for (const [n, c] of [...inbound].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    ${n.padEnd(30)} ${c} 个包依赖它`)
}

console.log('')
console.log('='.repeat(78))
console.log('3. 插件能力声明')
console.log('='.repeat(78))
for (const f of found.sort((a, b) => a.p.name.localeCompare(b.p.name))) {
  const d = f.p.dsh || {}
  const tags = []
  if (d.bundle) tags.push('bundle')
  if (d.suite) tags.push('suite')
  if (d.domain) tags.push('domain')
  if (!tags.length) tags.push('（纯库，非插件）')
  console.log(`  ${f.p.name.padEnd(34)} ${tags.join('+')}`)
}

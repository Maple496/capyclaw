#!/usr/bin/env node
/** Validate published package exports/bin targets before install or release. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', 'dist', '.dsh', '.zcode'])
const errors = []
const manifests = []

function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
    manifests.push(path.join(dir, 'package.json'))
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    walk(path.join(dir, entry.name))
  }
}

for (const base of ['packages', 'tools', 'extensions']) walk(path.join(ROOT, base))

function targets(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) targets(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) targets(item, out)
  return out
}

for (const manifest of manifests) {
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch (error) {
    errors.push(`${path.relative(ROOT, manifest)}: JSON 无效: ${error.message}`)
    continue
  }
  const base = path.dirname(manifest)
  const declared = [...targets(pkg.exports), ...targets(pkg.bin)]
  for (const target of declared) {
    if (!target.startsWith('./') || target.includes('*')) continue
    const resolved = path.resolve(base, target)
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      errors.push(`${pkg.name || manifest}: 导出越界 ${target}`)
    } else if (!fs.existsSync(resolved)) {
      errors.push(`${pkg.name || manifest}: 导出目标不存在 ${target}`)
    }
  }
}

if (errors.length) {
  console.error(`包导出校验失败（${errors.length}）:`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`包导出校验通过：${manifests.length} 个 package.json`)
}

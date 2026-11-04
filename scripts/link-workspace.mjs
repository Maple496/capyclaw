#!/usr/bin/env node
/**
 * 本地工作区链接：在仓库根 node_modules 下为 packages/* 建 junction。
 * 让公共插件的 `import 'dsh-plugin-kit/...'` 在 monorepo 开发/测试时可直接解析，
 * 不依赖每个包各自 npm install。发布时仍由 package.json dependencies 正常安装。
 *
 * 用法：node scripts/link-workspace.mjs [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PACKAGES = path.join(ROOT, 'packages')
const NODE_MODULES = path.join(ROOT, 'node_modules')
const CHECK = process.argv.includes('--check')

function packages() {
  return fs.readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(PACKAGES, entry.name)
      const manifest = path.join(dir, 'package.json')
      if (!fs.existsSync(manifest)) return null
      return { dir, name: JSON.parse(fs.readFileSync(manifest, 'utf8')).name }
    })
    .filter(Boolean)
}

let missing = 0
for (const pkg of packages()) {
  const link = path.join(NODE_MODULES, pkg.name)
  const target = fs.realpathSync(pkg.dir)
  let current = null
  try { current = fs.realpathSync(link) } catch { /* 不存在 */ }
  if (current === target) {
    console.log(`· ${pkg.name} 已链接`)
    continue
  }
  if (CHECK) {
    console.error(`✗ ${pkg.name} 未链接: ${link}`)
    missing++
    continue
  }
  fs.mkdirSync(NODE_MODULES, { recursive: true })
  try { fs.rmSync(link, { recursive: true, force: true }) } catch { /* 忽略 */ }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`✓ ${pkg.name} → ${target}`)
}
if (CHECK && missing) process.exit(1)

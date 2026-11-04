#!/usr/bin/env node
/**
 * 批量验证所有插件
 * 确保整个插件生态符合规范
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { validatePlugin } from '../tools/plugin-validator/lib/index.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

const PLUGIN_DIRS = [
  { path: 'extensions/official', required: true },
  { path: 'extensions/suites', required: false },  // suite 目录按需创建，当前不存在
  { path: 'extensions/bridges', required: false } // bridges 可选验证（递归含 plugin/ 深层的 suite 与 skill 包）
]

// 与 test-all 同口径：递归找带 package.json 的目录，跳过产物/依赖/夹具
const SKIP_DIRS = new Set(['node_modules', 'dist', 'archive', 'archives', '.git', '.dshd', 'fixtures', 'fixture'])

function findPluginDirs(root, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const child = join(root, entry.name)
    if (existsSync(join(child, 'package.json'))) out.push(child)
    findPluginDirs(child, out, depth + 1)
  }
  return out
}

/** 只把「dsh 插件形态」的包纳入验证：声明了 dsh.bundle / dsh.suite / dsh.client 才算。
 *  bridges 根（如 ppt-bridge-middleware 构建工场）与纯独立包（如 canvas-plugin）不是 dsh 插件，跳过。 */
function isDshPluginDir(pluginPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginPath, 'package.json'), 'utf8'))
    return Boolean(pkg.dsh?.bundle || pkg.dsh?.suite || pkg.dsh?.client)
  } catch {
    return false
  }
}

console.log('🔍 批量验证所有插件')
console.log('━'.repeat(60))
console.log('')

let totalPlugins = 0
let validPlugins = 0
let invalidPlugins = 0
let optionalInvalidPlugins = 0
const failures = []

for (const dirConfig of PLUGIN_DIRS) {
  const dir = typeof dirConfig === 'string' ? dirConfig : dirConfig.path
  const required = typeof dirConfig === 'string' ? true : dirConfig.required
  const dirPath = join(rootDir, dir)
  
  try {
    const pluginDirs = findPluginDirs(dirPath)

    for (const pluginPath of pluginDirs) {
      if (!isDshPluginDir(pluginPath)) continue
      const entry = pluginPath.slice(dirPath.length + 1)

      totalPlugins++
      const label = required ? '' : '(可选) '
      console.log(`\n验证: ${label}${dir}/${entry}`)
      
      try {
        const result = await validatePlugin(pluginPath)
        
        if (result.valid) {
          validPlugins++
          console.log('  ✅ 通过')
          if (result.warnings.length > 0) {
            result.warnings.forEach(w => console.log(`  ⚠️  ${w}`))
          }
        } else {
          invalidPlugins++
          if (required) {
            console.log('  ❌ 失败')
            result.errors.forEach(err => {
              console.log(`     [${err.rule}] ${err.message}`)
            })
            failures.push({ path: `${dir}/${entry}`, errors: result.errors })
          } else {
            optionalInvalidPlugins++
            console.log('  ⚠️  不符合标准（bridges 可选）')
            result.errors.slice(0, 2).forEach(err => {
              console.log(`     [${err.rule}] ${err.message}`)
            })
          }
        }
      } catch (error) {
        invalidPlugins++
        if (!required) optionalInvalidPlugins++
        console.log(`  💥 错误: ${error.message}`)
        if (required) {
          failures.push({ path: `${dir}/${entry}`, errors: [{ message: error.message }] })
        }
      }
    }
  } catch (error) {
    console.log(`跳过目录 ${dir}: ${error.message}`)
  }
}

console.log('\n' + '━'.repeat(60))
console.log('\n📊 验证汇总:')
console.log(`  总计: ${totalPlugins} 个插件`)
console.log(`  ✅ 通过: ${validPlugins}`)
console.log(`  ❌ 失败: ${invalidPlugins}${optionalInvalidPlugins ? `（其中可选 bridges: ${optionalInvalidPlugins}）` : ''}`)

if (failures.length > 0) {
  console.log('\n❌ 以下插件需要修复:')
  failures.forEach(({ path, errors }) => {
    console.log(`\n  ${path}:`)
    errors.forEach(err => {
      console.log(`    - [${err.rule || 'ERROR'}] ${err.message}`)
    })
  })
  console.log('')
  process.exit(1)
} else if (optionalInvalidPlugins > 0) {
  console.log(`\n✅ 必需插件全部通过；${optionalInvalidPlugins} 个可选 bridges 未达标（不影响退出码）。\n`)
  process.exit(0)
} else {
  console.log('\n🎉 所有插件验证通过！\n')
  process.exit(0)
}

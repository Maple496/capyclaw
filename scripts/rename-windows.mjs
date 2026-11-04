#!/usr/bin/env node
/**
 * Windows 友好的重命名脚本 - 使用复制+删除方式
 */

import { execSync } from 'child_process'
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

const plugins = [
  { old: 'extensions/official/dsh-ddr0-client', new: 'extensions/official/capyclaw-ddr0-client' },
  { old: 'extensions/official/dsh-launchpad', new: 'extensions/official/capyclaw-launchpad' },
  { old: 'extensions/official/dsh-llm-tempkey', new: 'extensions/official/capyclaw-llm-tempkey' },
  { old: 'extensions/official/dsh-port-sidebar', new: 'extensions/official/capyclaw-port-sidebar' },
  { old: 'extensions/official/dsh-scrapling', new: 'extensions/official/capyclaw-scrapling' },
  { old: 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-suite', new: 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite' },
  { old: 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-workbench', new: 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-workbench' },
]

console.log('🚀 开始重命名插件（复制+删除方式）\n')

for (const plugin of plugins) {
  const oldPath = join(rootDir, plugin.old)
  const newPath = join(rootDir, plugin.new)
  
  if (!existsSync(oldPath)) {
    console.log(`⏭️  跳过: ${plugin.old} (不存在)`)
    continue
  }
  
  if (existsSync(newPath)) {
    console.log(`⏭️  跳过: ${plugin.new} (已存在)`)
    continue
  }
  
  try {
    console.log(`📦 处理: ${plugin.old}`)
    
    // 使用 cpSync 递归复制
    cpSync(oldPath, newPath, { recursive: true, force: true })
    console.log(`  ✅ 复制完成`)
    
    // 删除旧目录
    rmSync(oldPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
    console.log(`  ✅ 删除旧目录`)
    
  } catch (error) {
    console.log(`  ❌ 失败: ${error.message}`)
  }
}

console.log('\n✅ 目录重命名完成！')
console.log('\n现在更新 package.json...\n')

// 更新所有 package.json
function updatePackageJson(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  
  try {
    const content = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(content)
    
    // 检查是否需要更新
    if (pkg.name?.startsWith('dsh-')) {
      const oldName = pkg.name
      const newName = `@capyclaw/${pkg.name.replace('dsh-', '')}`
      pkg.name = newName
      
      // 添加作者信息
      pkg.author = {
        name: 'CapyClaw',
        url: 'https://github.com/capyclaw',
        email: 'support@capyclaw.dev'
      }
      
      pkg.repository = {
        type: 'git',
        url: 'https://github.com/capyclaw/dsh-plugins'
      }
      
      pkg.bugs = {
        url: 'https://github.com/capyclaw/dsh-plugins/issues'
      }
      
      pkg.homepage = 'https://github.com/capyclaw/dsh-plugins'
      
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      console.log(`  ✅ ${oldName} → ${newName}`)
    }
  } catch (error) {
    console.log(`  ❌ 更新失败: ${pkgPath}`)
  }
}

// 递归查找并更新所有 capyclaw 插件
function scanAndUpdate(dir) {
  if (!existsSync(dir)) return
  
  const entries = readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = join(dir, entry.name)
      
      // 如果是 capyclaw 插件目录
      if (entry.name.startsWith('capyclaw-')) {
        console.log(`\n📦 更新: ${entry.name}`)
        updatePackageJson(fullPath)
      } else {
        // 递归扫描
        scanAndUpdate(fullPath)
      }
    }
  }
}

scanAndUpdate(join(rootDir, 'extensions'))

console.log('\n✅ 所有更新完成！')

#!/usr/bin/env node
/**
 * 将所有 dsh-* 插件重命名为 capyclaw-*
 * 
 * 使用方法:
 *   node scripts/rename-to-capyclaw.mjs --dry-run  # 预览操作
 *   node scripts/rename-to-capyclaw.mjs --execute  # 执行重命名
 */

import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

// 重命名映射
const renameMap = {
  'dsh-launchpad': 'capyclaw-launchpad',
  'dsh-llm-tempkey': 'capyclaw-llm-tempkey',
  'dsh-port-sidebar': 'capyclaw-port-sidebar',
  'dsh-scrapling': 'capyclaw-scrapling',
  'dsh-ddr0-client': 'capyclaw-ddr0-client',
  'dsh-ppt-workbench': 'capyclaw-ppt-workbench',
  'dsh-ppt-suite': 'capyclaw-ppt-suite',
}

// 作用域包选项 (推荐使用)
const useScope = true
const scope = '@capyclaw'

// 品牌信息
const brandInfo = {
  author: {
    name: 'CapyClaw',
    url: 'https://github.com/capyclaw',
    email: 'support@capyclaw.dev'
  },
  repository: {
    type: 'git',
    url: 'https://github.com/capyclaw/dsh-plugins'
  },
  bugs: {
    url: 'https://github.com/capyclaw/dsh-plugins/issues'
  },
  homepage: 'https://github.com/capyclaw/dsh-plugins'
}

const dryRun = process.argv.includes('--dry-run')
const execute = process.argv.includes('--execute')

if (!dryRun && !execute) {
  console.log('❌ 请指定 --dry-run 或 --execute')
  console.log('   --dry-run: 预览操作')
  console.log('   --execute: 执行重命名')
  process.exit(1)
}

console.log('🔍 扫描插件...\n')

// 查找所有需要重命名的目录
function findPluginDirs() {
  const dirs = []
  
  // extensions/official/*
  const officialDir = join(rootDir, 'extensions', 'official')
  if (existsSync(officialDir)) {
    for (const name of readdirSync(officialDir)) {
      if (renameMap[name]) {
        dirs.push({
          path: join(officialDir, name),
          oldName: name,
          newName: renameMap[name],
          category: 'official'
        })
      }
    }
  }
  
  // extensions/bridges/*/plugin/*
  const bridgesDir = join(rootDir, 'extensions', 'bridges')
  if (existsSync(bridgesDir)) {
    for (const bridge of readdirSync(bridgesDir)) {
      const pluginDir = join(bridgesDir, bridge, 'plugin')
      if (existsSync(pluginDir)) {
        for (const name of readdirSync(pluginDir)) {
          if (renameMap[name]) {
            dirs.push({
              path: join(pluginDir, name),
              oldName: name,
              newName: renameMap[name],
              category: 'bridge'
            })
          }
        }
      }
    }
  }
  
  return dirs
}

// 更新 package.json
function updatePackageJson(filePath, oldName, newName) {
  if (!existsSync(filePath)) return
  
  const content = readFileSync(filePath, 'utf-8')
  const pkg = JSON.parse(content)
  
  // 更新包名
  if (useScope) {
    pkg.name = `${scope}/${newName.replace('capyclaw-', '')}`
  } else {
    pkg.name = newName
  }
  
  // 添加品牌信息
  pkg.author = brandInfo.author
  pkg.repository = brandInfo.repository
  pkg.bugs = brandInfo.bugs
  pkg.homepage = brandInfo.homepage
  
  // 更新描述（添加 by CapyClaw）
  if (pkg.description && !pkg.description.includes('CapyClaw')) {
    pkg.description += ' by CapyClaw'
  }
  
  // 更新 meta 信息
  if (pkg.meta) {
    if (pkg.meta.description && !pkg.meta.description.includes('CapyClaw')) {
      pkg.meta.description += ' by CapyClaw'
    }
  }
  
  // 更新依赖中的包名
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[depType]) {
      for (const [dep, version] of Object.entries(pkg[depType])) {
        if (renameMap[dep]) {
          const newDep = useScope 
            ? `${scope}/${renameMap[dep].replace('capyclaw-', '')}`
            : renameMap[dep]
          delete pkg[depType][dep]
          pkg[depType][newDep] = version
        }
      }
    }
  }
  
  if (execute) {
    writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`  ✅ 更新 package.json`)
  } else {
    console.log(`  📝 将更新 package.json: ${pkg.name}`)
  }
}

// 更新所有文件中的引用
function updateReferences(dir, oldName, newName) {
  const extensions = ['.mjs', '.js', '.json', '.yml', '.yaml', '.md']
  
  function walkDir(currentDir) {
    if (!existsSync(currentDir)) return
    
    const entries = readdirSync(currentDir)
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry)
      const stat = statSync(fullPath)
      
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue
        walkDir(fullPath)
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        updateFileReferences(fullPath, oldName, newName)
      }
    }
  }
  
  walkDir(dir)
}

function updateFileReferences(filePath, oldName, newName) {
  let content = readFileSync(filePath, 'utf-8')
  let updated = false
  
  // 替换包名引用
  const patterns = [
    new RegExp(`"${oldName}"`, 'g'),
    new RegExp(`'${oldName}'`, 'g'),
    new RegExp(`/${oldName}/`, 'g'),
    new RegExp(`${oldName}:`, 'g'),
  ]
  
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      const replacement = useScope
        ? `${scope}/${newName.replace('capyclaw-', '')}`
        : newName
      content = content.replace(pattern, match => match.replace(oldName, replacement))
      updated = true
    }
  }
  
  if (updated) {
    if (execute) {
      writeFileSync(filePath, content)
      console.log(`  ✅ 更新引用: ${filePath.replace(rootDir, '.')}`)
    } else {
      console.log(`  📝 将更新引用: ${filePath.replace(rootDir, '.')}`)
    }
  }
}

// 重命名目录
function renameDirectory(oldPath, newPath) {
  if (existsSync(newPath)) {
    console.log(`  ⚠️  目标目录已存在: ${newPath}`)
    return false
  }
  
  if (execute) {
    const parentDir = dirname(oldPath)
    const newName = newPath.split(/[\\/]/).pop()
    renameSync(oldPath, join(parentDir, newName))
    console.log(`  ✅ 重命名目录`)
    return true
  } else {
    console.log(`  📝 将重命名目录: ${oldPath} → ${newPath}`)
    return true
  }
}

// 执行重命名
const plugins = findPluginDirs()

if (plugins.length === 0) {
  console.log('❌ 未找到需要重命名的插件')
  process.exit(1)
}

console.log(`找到 ${plugins.length} 个插件需要处理\n`)

if (dryRun) {
  console.log('🔍 预览模式 - 不会进行实际修改\n')
} else {
  console.log('⚠️  执行模式 - 将进行实际修改\n')
  console.log('按 Ctrl+C 取消...\n')
  await new Promise(resolve => setTimeout(resolve, 3000))
}

for (const plugin of plugins) {
  console.log(`\n📦 处理插件: ${plugin.oldName}`)
  console.log(`   分类: ${plugin.category}`)
  console.log(`   路径: ${plugin.path.replace(rootDir, '.')}`)
  
  // 1. 更新 package.json
  const pkgPath = join(plugin.path, 'package.json')
  updatePackageJson(pkgPath, plugin.oldName, plugin.newName)
  
  // 2. 更新所有文件中的引用
  updateReferences(plugin.path, plugin.oldName, plugin.newName)
  
  // 3. 重命名目录（最后执行）
  const newPath = join(dirname(plugin.path), plugin.newName)
  renameDirectory(plugin.path, newPath)
}

console.log('\n' + '='.repeat(60))
if (dryRun) {
  console.log('✅ 预览完成！')
  console.log('\n要执行实际重命名，请运行:')
  console.log('   node scripts/rename-to-capyclaw.mjs --execute')
} else {
  console.log('✅ 重命名完成！')
  console.log('\n后续步骤:')
  console.log('1. 检查 git diff 确认修改正确')
  console.log('2. 运行测试: npm run test-all')
  console.log('3. 提交更改: git add . && git commit -m "Rebrand to CapyClaw"')
  console.log('4. 创建标签: git tag -a capyclaw-v1.0.0 -m "First release"')
}
console.log('='.repeat(60) + '\n')

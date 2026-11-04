#!/usr/bin/env node
/**
 * CapyClaw 发布准备检查工具
 * 
 * 使用方法:
 *   node scripts/check-publish-ready.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

console.log('🔍 CapyClaw 发布准备检查工具\n')
console.log('='.repeat(60))

let passed = 0
let failed = 0
const issues = []

// 检查函数
function check(name, condition, errorMsg) {
  if (condition) {
    console.log(`✅ ${name}`)
    passed++
    return true
  } else {
    console.log(`❌ ${name}`)
    failed++
    if (errorMsg) issues.push(errorMsg)
    return false
  }
}

function warn(name, message) {
  console.log(`⚠️  ${name}`)
  if (message) issues.push(`[警告] ${message}`)
}

// 1. 检查基础文件
console.log('\n📁 基础文件检查\n')

check(
  '发布计划文档',
  existsSync(join(rootDir, 'CAPYCLAW_PUBLISHING_PLAN.md')),
  '缺少 CAPYCLAW_PUBLISHING_PLAN.md'
)

check(
  '快速启动指南',
  existsSync(join(rootDir, 'CAPYCLAW_QUICKSTART.md')),
  '缺少 CAPYCLAW_QUICKSTART.md'
)

check(
  '插件注册表',
  existsSync(join(rootDir, 'capyclaw-registry.json')),
  '缺少 capyclaw-registry.json'
)

check(
  '贡献指南',
  existsSync(join(rootDir, 'CONTRIBUTING.md')),
  '缺少 CONTRIBUTING.md'
)

// 2. 检查脚本文件
console.log('\n🛠️  脚本文件检查\n')

check(
  '重命名脚本',
  existsSync(join(rootDir, 'scripts', 'rename-to-capyclaw.mjs')),
  '缺少 scripts/rename-to-capyclaw.mjs'
)

check(
  '打包脚本',
  existsSync(join(rootDir, 'scripts', 'pack-capyclaw-plugins.mjs')),
  '缺少 scripts/pack-capyclaw-plugins.mjs'
)

check(
  '发布脚本',
  existsSync(join(rootDir, 'scripts', 'publish-to-npm.mjs')),
  '缺少 scripts/publish-to-npm.mjs'
)

// 3. 检查 CI/CD
console.log('\n🔄 CI/CD 检查\n')

check(
  'GitHub Actions 工作流',
  existsSync(join(rootDir, '.github', 'workflows', 'publish-plugins.yml')),
  '缺少 .github/workflows/publish-plugins.yml'
)

// 4. 查找插件
console.log('\n📦 插件检查\n')

function findPlugins() {
  const plugins = []
  
  const officialDir = join(rootDir, 'extensions', 'official')
  if (existsSync(officialDir)) {
    for (const name of readdirSync(officialDir)) {
      const pluginPath = join(officialDir, name)
      if (statSync(pluginPath).isDirectory()) {
        plugins.push({ name, path: pluginPath, category: 'official' })
      }
    }
  }
  
  const bridgesDir = join(rootDir, 'extensions', 'bridges')
  if (existsSync(bridgesDir)) {
    for (const bridge of readdirSync(bridgesDir)) {
      const pluginDir = join(bridgesDir, bridge, 'plugin')
      if (existsSync(pluginDir)) {
        for (const name of readdirSync(pluginDir)) {
          const pluginPath = join(pluginDir, name)
          if (statSync(pluginPath).isDirectory()) {
            plugins.push({ name, path: pluginPath, category: 'bridge' })
          }
        }
      }
    }
  }
  
  return plugins
}

const allPlugins = findPlugins()
const capyClawPlugins = allPlugins.filter(p => p.name.startsWith('capyclaw-'))
const dshPlugins = allPlugins.filter(p => p.name.startsWith('dsh-'))

console.log(`找到 ${allPlugins.length} 个插件:`)
console.log(`  • CapyClaw 插件: ${capyClawPlugins.length}`)
console.log(`  • DSH 插件 (待重命名): ${dshPlugins.length}`)

if (capyClawPlugins.length === 0 && dshPlugins.length > 0) {
  warn('未重命名', '插件尚未重命名为 CapyClaw，请运行: node scripts/rename-to-capyclaw.mjs --execute')
}

// 5. 检查每个 CapyClaw 插件
if (capyClawPlugins.length > 0) {
  console.log('\n📋 插件详细检查\n')
  
  for (const plugin of capyClawPlugins) {
    console.log(`\n${plugin.name}:`)
    
    // package.json
    const pkgPath = join(plugin.path, 'package.json')
    if (check(
      '  package.json 存在',
      existsSync(pkgPath),
      `${plugin.name}: 缺少 package.json`
    )) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        
        check(
          '  包名正确',
          pkg.name && (pkg.name.startsWith('@capyclaw/') || pkg.name.startsWith('capyclaw-')),
          `${plugin.name}: 包名不符合规范`
        )
        
        check(
          '  有版本号',
          pkg.version,
          `${plugin.name}: 缺少版本号`
        )
        
        check(
          '  有描述',
          pkg.description,
          `${plugin.name}: 缺少描述`
        )
        
        check(
          '  有作者信息',
          pkg.author,
          `${plugin.name}: 缺少作者信息`
        )
        
        check(
          '  有许可证',
          pkg.license,
          `${plugin.name}: 缺少许可证`
        )
        
        if (pkg.private) {
          warn('  私有包', `${plugin.name}: 设置为私有包，无法发布到 NPM`)
        }
      } catch (error) {
        check('  package.json 有效', false, `${plugin.name}: package.json 格式错误`)
      }
    }
    
    // README.md
    check(
      '  README.md 存在',
      existsSync(join(plugin.path, 'README.md')),
      `${plugin.name}: 缺少 README.md`
    )
    
    // LICENSE
    const hasLicense = existsSync(join(plugin.path, 'LICENSE')) ||
                       existsSync(join(plugin.path, 'LICENSE.md')) ||
                       existsSync(join(plugin.path, 'LICENSE.txt'))
    check(
      '  LICENSE 存在',
      hasLicense,
      `${plugin.name}: 缺少 LICENSE 文件`
    )
    
    // 测试
    const hasTests = existsSync(join(plugin.path, 'test')) ||
                     existsSync(join(plugin.path, '__tests__'))
    if (!hasTests) {
      warn('  测试文件', `${plugin.name}: 没有测试目录`)
    } else {
      console.log('  ✅ 测试文件存在')
      passed++
    }
  }
}

// 6. NPM 检查
console.log('\n\n🔐 NPM 环境检查\n')

try {
  const { execSync } = await import('child_process')
  
  try {
    const user = execSync('npm whoami', { encoding: 'utf-8', stdio: 'pipe' }).trim()
    console.log(`✅ NPM 已登录: ${user}`)
    passed++
  } catch {
    warn('NPM 未登录', '需要运行: npm login')
  }
  
  try {
    const registry = execSync('npm config get registry', { encoding: 'utf-8' }).trim()
    console.log(`✅ NPM Registry: ${registry}`)
    passed++
  } catch {
    warn('NPM Registry', '无法获取 registry 配置')
  }
} catch {
  warn('NPM 命令', '无法执行 npm 命令')
}

// 7. Git 检查
console.log('\n📚 Git 检查\n')

try {
  const { execSync } = await import('child_process')
  
  try {
    execSync('git status', { stdio: 'pipe' })
    console.log('✅ Git 仓库')
    passed++
    
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
      console.log(`✅ 当前分支: ${branch}`)
      passed++
      
      if (branch !== 'main' && branch !== 'master') {
        warn('Git 分支', `当前在 ${branch} 分支，建议切换到 main/master`)
      }
    } catch {
      warn('Git 分支', '无法获取当前分支')
    }
    
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8' })
      if (status.trim()) {
        warn('未提交的更改', '有未提交的更改，建议先提交')
      } else {
        console.log('✅ 工作区干净')
        passed++
      }
    } catch {
      warn('Git 状态', '无法检查工作区状态')
    }
  } catch {
    warn('Git 仓库', '当前目录不是 Git 仓库')
  }
} catch {
  warn('Git 命令', '无法执行 git 命令')
}

// 总结
console.log('\n' + '='.repeat(60))
console.log('\n📊 检查结果\n')

console.log(`✅ 通过: ${passed}`)
console.log(`❌ 失败: ${failed}`)
console.log(`⚠️  警告: ${issues.filter(i => i.startsWith('[警告]')).length}`)

const totalChecks = passed + failed
const passRate = totalChecks > 0 ? ((passed / totalChecks) * 100).toFixed(1) : 0

console.log(`\n通过率: ${passRate}%`)

if (issues.length > 0) {
  console.log('\n⚠️  需要解决的问题:\n')
  issues.forEach((issue, i) => {
    console.log(`${i + 1}. ${issue}`)
  })
}

console.log('\n' + '='.repeat(60))

if (failed === 0 && capyClawPlugins.length > 0) {
  console.log('\n🎉 所有检查通过！你可以开始发布流程了。\n')
  console.log('下一步:')
  console.log('1. npm login  # 如果还未登录')
  console.log('2. node scripts/pack-capyclaw-plugins.mjs')
  console.log('3. node scripts/publish-to-npm.mjs --dry-run')
  console.log('4. node scripts/publish-to-npm.mjs --execute')
  console.log('5. git push --tags\n')
} else if (capyClawPlugins.length === 0) {
  console.log('\n📝 插件尚未重命名\n')
  console.log('请先运行:')
  console.log('  node scripts/rename-to-capyclaw.mjs --dry-run  # 预览')
  console.log('  node scripts/rename-to-capyclaw.mjs --execute  # 执行\n')
} else {
  console.log('\n⚠️  还有一些问题需要解决才能发布。\n')
  console.log('请根据上面的问题列表逐一解决。\n')
}

console.log('='.repeat(60) + '\n')

// 退出码
process.exit(failed > 0 ? 1 : 0)

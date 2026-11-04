#!/usr/bin/env node
/**
 * DSH + Capyclaw 插件一键部署脚本
 * 
 * 在任意 Windows 机器上运行，自动完成：
 *   1. 检查依赖（Node.js、pnpm）
 *   2. 安装 dsh（如果没有）
 *   3. 从 npm 安装 Capyclaw 插件
 *   4. 配置 profile
 *   5. 启动 dsh
 * 
 * 用法:
 *   # 最简单（使用默认配置）
 *   node bootstrap.mjs
 * 
 *   # 自定义插件列表
 *   node bootstrap.mjs --plugins @capyclaw/launchpad,@capyclaw/ppt-suite
 * 
 *   # 指定 profile
 *   node bootstrap.mjs --profile web --plugins @capyclaw/launchpad
 * 
 *   # 只安装不启动
 *   node bootstrap.mjs --no-start
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const DEFAULT_PLUGINS = [
  '@capyclaw/launchpad',
  '@capyclaw/plugin-sync',
  '@capyclaw/port-sidebar',
  '@capyclaw/llm-tempkey',
]

const DEFAULT_PROFILE = 'web'

function log(msg, level = 'info') {
  const prefix = { info: '⏳', success: '✓', error: '✗', warn: '⚠' }[level] || '•'
  console.log(`${prefix} ${msg}`)
}

function die(msg) {
  log(msg, 'error')
  process.exit(1)
}

function run(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' })
  } catch (error) {
    if (!silent) throw error
    return null
  }
}

function checkDependency(name, checkCmd, installUrl) {
  log(`检查 ${name}...`)
  const result = run(checkCmd, true)
  if (!result) {
    log(`${name} 未安装`, 'error')
    log(`请先安装: ${installUrl}`, 'warn')
    return false
  }
  const version = result.trim().split('\n')[0]
  log(`${name}: ${version}`, 'success')
  return true
}

function ensurePnpm() {
  log('检查 pnpm...')
  const hasPnpm = run('pnpm --version', true)
  if (!hasPnpm) {
    log('pnpm 未安装，正在安装...', 'warn')
    run('npm install -g pnpm')
    log('pnpm 安装完成', 'success')
  } else {
    log(`pnpm: ${hasPnpm.trim()}`, 'success')
  }
}

function ensureDsh() {
  log('检查 dsh...')
  const hasDsh = run('dsh --version', true)
  if (!hasDsh) {
    log('dsh 未安装，正在安装...', 'warn')
    log('从 npm 安装 @deepseek-ai/dsh（可能需要几分钟）...')
    run('npm install -g @deepseek-ai/dsh')
    log('dsh 安装完成', 'success')
  } else {
    log(`dsh: ${hasDsh.trim()}`, 'success')
  }
}

function ensureProfile(profileName) {
  const dshHome = join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', profileName)
  const pkgPath = join(profileDir, 'package.json')

  if (!existsSync(profileDir)) {
    log(`创建 profile: ${profileName}`)
    mkdirSync(profileDir, { recursive: true })
  }

  if (!existsSync(pkgPath)) {
    log(`初始化 profile package.json`)
    const pkg = {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  }

  return { profileDir, pkgPath }
}

function installPlugins(profileDir, pkgPath, plugins) {
  log(`准备安装 ${plugins.length} 个插件...`)

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

  const existing = new Set(pkg.dsh.profile.bundles)
  let newCount = 0

  for (const name of plugins) {
    if (!pkg.dependencies[name]) {
      pkg.dependencies[name] = 'latest'
      newCount++
      log(`  + ${name}`)
    }
    if (!existing.has(name)) {
      pkg.dsh.profile.bundles.push(name)
      existing.add(name)
    }
  }

  if (newCount === 0) {
    log('所有插件已安装', 'success')
    return
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log(`已更新 package.json（+${newCount} 个新插件）`, 'success')

  log('运行 pnpm install（可能需要几分钟）...')
  const result = spawnSync('pnpm', ['install'], {
    cwd: profileDir,
    encoding: 'utf8',
    stdio: 'inherit',
  })

  if (result.error || result.status !== 0) {
    die('pnpm install 失败，请检查网络连接或手动运行: cd ' + profileDir + ' && pnpm install')
  }

  log('插件安装完成', 'success')
}

function startDsh(profileName) {
  log(`启动 dsh (profile: ${profileName})...`)
  log('提示: 按 Ctrl+C 停止', 'warn')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const result = spawnSync('dsh', ['--profile', profileName], {
    encoding: 'utf8',
    stdio: 'inherit',
  })

  if (result.error) {
    die('dsh 启动失败: ' + result.error.message)
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const config = {
    profile: DEFAULT_PROFILE,
    plugins: DEFAULT_PLUGINS,
    start: true,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`
DSH + Capyclaw 插件一键部署脚本

用法:
  node bootstrap.mjs [选项]

选项:
  --profile <name>        profile 名称（默认: web）
  --plugins <list>        逗号分隔的插件列表（默认: launchpad,plugin-sync,port-sidebar,llm-tempkey）
  --no-start             只安装不启动
  --help, -h             显示帮助

示例:
  # 使用默认配置
  node bootstrap.mjs

  # 只安装 launchpad
  node bootstrap.mjs --plugins @capyclaw/launchpad

  # 安装但不启动
  node bootstrap.mjs --no-start

  # 自定义 profile
  node bootstrap.mjs --profile my-profile --plugins @capyclaw/launchpad,@capyclaw/ppt-suite
`)
      process.exit(0)
    } else if (arg === '--profile') {
      config.profile = args[++i]
    } else if (arg === '--plugins') {
      config.plugins = args[++i].split(',').map((s) => s.trim())
    } else if (arg === '--no-start') {
      config.start = false
    }
  }

  return config
}

async function main() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DSH + Capyclaw 插件一键部署
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)

  const config = parseArgs()

  log(`配置:`)
  log(`  profile: ${config.profile}`)
  log(`  plugins: ${config.plugins.join(', ')}`)
  log(`  启动: ${config.start ? '是' : '否'}\n`)

  // 1. 检查依赖
  log('━━━ 1/4 检查依赖 ━━━')
  if (!checkDependency('Node.js', 'node --version', 'https://nodejs.org/')) {
    die('请先安装 Node.js')
  }
  ensurePnpm()
  ensureDsh()
  console.log()

  // 2. 初始化 profile
  log('━━━ 2/4 初始化 Profile ━━━')
  const { profileDir, pkgPath } = ensureProfile(config.profile)
  log(`profile 目录: ${profileDir}`, 'success')
  console.log()

  // 3. 安装插件
  log('━━━ 3/4 安装插件 ━━━')
  installPlugins(profileDir, pkgPath, config.plugins)
  console.log()

  // 4. 启动
  log('━━━ 4/4 完成 ━━━')
  log('部署完成！', 'success')

  if (config.start) {
    console.log()
    startDsh(config.profile)
  } else {
    log(`\n手动启动: dsh --profile ${config.profile}`, 'warn')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

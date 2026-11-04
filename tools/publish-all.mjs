#!/usr/bin/env node
/**
 * 批量发布所有可发布插件到 npm
 * 
 * 用法:
 *   npm run publish-all           # 发布所有
 *   npm run publish-all -- --dry  # 预览不实际发布
 */

import { readFileSync } from 'fs'
import { resolve, join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { spawnSync } from 'child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const REGISTRY = join(REPO, 'capyclaw-registry.json')

const isDryRun = process.argv.includes('--dry')

function log(msg, level = 'info') {
  const prefix = { info: '•', success: '✓', error: '✗', warn: '⚠' }[level] || '•'
  console.log(`${prefix} ${msg}`)
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  return {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  }
}

function getPackageInfo(pluginPath) {
  const pkgPath = join(REPO, pluginPath, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return { name: pkg.name, version: pkg.version, private: pkg.private }
  } catch (error) {
    return null
  }
}

function isPublished(name, version) {
  const result = run('npm', ['view', `${name}@${version}`, 'version'], REPO)
  return result.success && result.stdout.trim() === version
}

function publishPackage(name, pluginPath) {
  const fullPath = join(REPO, pluginPath)
  
  log(`发布 ${name}...`, 'info')
  
  if (isDryRun) {
    log(`  [预览] npm publish ${fullPath} --access public`, 'warn')
    return { success: true, skipped: true }
  }

  const result = run('npm', ['publish', '--access', 'public'], fullPath)
  
  if (result.success) {
    log(`  已发布 ${name}`, 'success')
    return { success: true }
  } else {
    log(`  发布失败: ${result.stderr}`, 'error')
    return { success: false, error: result.stderr }
  }
}

async function main() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  批量发布插件到 npm
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)

  if (isDryRun) {
    log('预览模式（不会实际发布）', 'warn')
  }

  // 1. 读取 registry
  log('读取 capyclaw-registry.json...')
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const plugins = registry.plugins || []
  log(`发现 ${plugins.length} 个插件\n`)

  // 2. 检查每个插件
  const toPublish = []
  const skipped = []
  const errors = []

  for (const plugin of plugins) {
    const { name, path: pluginPath } = plugin
    const info = getPackageInfo(pluginPath)

    if (!info) {
      errors.push({ name, reason: 'package.json 读取失败' })
      continue
    }

    if (info.private) {
      skipped.push({ name, reason: 'private 包' })
      continue
    }

    if (isPublished(info.name, info.version)) {
      skipped.push({ name: info.name, reason: `${info.version} 已发布` })
      continue
    }

    toPublish.push({ name: info.name, version: info.version, path: pluginPath })
  }

  // 3. 显示摘要
  console.log('━━━ 发布计划 ━━━')
  if (toPublish.length > 0) {
    log('待发布:')
    for (const pkg of toPublish) {
      log(`  ${pkg.name}@${pkg.version}`)
    }
  } else {
    log('无需发布（所有包已是最新版本）', 'success')
  }

  if (skipped.length > 0) {
    log('\n跳过:')
    for (const pkg of skipped) {
      log(`  ${pkg.name}: ${pkg.reason}`, 'warn')
    }
  }

  if (errors.length > 0) {
    log('\n错误:')
    for (const pkg of errors) {
      log(`  ${pkg.name}: ${pkg.reason}`, 'error')
    }
  }

  if (toPublish.length === 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    return
  }

  console.log('\n━━━ 开始发布 ━━━\n')

  // 4. 逐个发布
  const published = []
  const failed = []

  for (const pkg of toPublish) {
    const result = publishPackage(pkg.name, pkg.path)
    if (result.success) {
      if (!result.skipped) {
        published.push(pkg.name)
      }
    } else {
      failed.push({ name: pkg.name, error: result.error })
    }
  }

  // 5. 最终报告
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (isDryRun) {
    log('预览完成（未实际发布）', 'success')
  } else {
    log(`发布完成: ${published.length} 成功, ${failed.length} 失败`, published.length === toPublish.length ? 'success' : 'warn')
  }
  
  if (failed.length > 0) {
    log('\n失败列表:', 'error')
    for (const pkg of failed) {
      log(`  ${pkg.name}`, 'error')
      log(`    ${pkg.error}`, 'error')
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

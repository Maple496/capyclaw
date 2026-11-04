#!/usr/bin/env node
/**
 * 把可发布插件发布到 npm。
 *
 * 设计：
 *   - 复用 tools/plugin-release 的同一套判定（插件校验 + 发布闸 + 包名白名单），
 *     不再自己维护一份扫描列表，避免两条发布路径的清单不一致。
 *   - 只发布**原始包目录**（依赖交给 npm 从 registry 解析）；
 *     带 vendored 依赖的 staged 副本只用于 zip 分发，不走 npm。
 *   - 默认 dry-run；显式 --execute 才真正 publish。
 *
 * 用法：
 *   node scripts/publish-to-npm.mjs [--dry-run|--execute] [--skip-tests] [--only <name>]
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

import { discoverPlugins, publishGateErrors } from '../tools/plugin-release/lib/index.mjs'
import { validatePlugin } from '../tools/plugin-validator/lib/index.mjs'

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const execute = hasFlag('--execute') && !hasFlag('--dry-run')
const skipTests = hasFlag('--skip-tests')
const only = valueOf('--only')

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    ...options,
  })
}

function pkgOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

function alreadyPublished(name, version) {
  const r = run('npm', ['view', `${name}@${version}`, 'version'])
  if (r.status !== 0) return false
  return String(r.stdout).trim() === version
}

async function main() {
  const dirs = discoverPlugins()
  if (!dirs.length) {
    console.error('没有可发布的插件（全部被发布闸拦下）')
    process.exitCode = 1
    return
  }

  console.log(`模式: ${execute ? '执行发布' : 'DRY RUN（加 --execute 才会真正发布）'}`)
  console.log(`候选: ${dirs.length} 个\n`)

  const results = []
  for (const dir of dirs) {
    const pkg = pkgOf(dir)
    const label = `${pkg.name}@${pkg.version}`
    if (only && pkg.name !== only) continue

    const gate = publishGateErrors(pkg, dir)
    if (gate.length) {
      results.push({ label, status: 'gate-failed', detail: gate })
      console.log(`✗ ${label} — 发布闸未过`)
      for (const item of gate) console.log(`    - ${item}`)
      continue
    }

    const validation = await validatePlugin(dir)
    if (!validation.valid) {
      results.push({ label, status: 'invalid', detail: validation.errors.map((e) => e.message) })
      console.log(`✗ ${label} — 插件校验未过`)
      for (const item of validation.errors) console.log(`    - [${item.rule}] ${item.message}`)
      continue
    }

    if (alreadyPublished(pkg.name, pkg.version)) {
      results.push({ label, status: 'skipped-exists' })
      console.log(`· ${label} — registry 上已存在，跳过`)
      continue
    }

    if (!skipTests && pkg.scripts?.test) {
      const t = run('npm', ['test'], { cwd: dir })
      if (t.status !== 0) {
        results.push({ label, status: 'test-failed', detail: (t.stdout || '') + (t.stderr || '') })
        console.log(`✗ ${label} — npm test 失败，跳过发布`)
        continue
      }
    }

    if (!execute) {
      results.push({ label, status: 'would-publish' })
      console.log(`→ ${label} — 待发布（dry run）`)
      continue
    }

    const access = pkg.publishConfig?.access || 'public'
    const pub = run('npm', ['publish', '--access', access], { cwd: dir })
    if (pub.status !== 0) {
      results.push({ label, status: 'publish-failed', detail: (pub.stdout || '') + (pub.stderr || '') })
      console.log(`✗ ${label} — npm publish 失败`)
      console.log(String(pub.stderr || pub.stdout || '').trim().slice(0, 500))
      continue
    }
    results.push({ label, status: 'published' })
    console.log(`✓ ${label} — 已发布`)
  }

  const summary = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1
    return acc
  }, {})
  console.log('\n汇总:', JSON.stringify(summary))

  const failed = results.filter((r) => ['gate-failed', 'invalid', 'test-failed', 'publish-failed'].includes(r.status))
  if (failed.length) {
    console.error(`\n${failed.length} 个插件未发布：${failed.map((f) => f.label).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('发布脚本异常:', error.message)
  process.exitCode = 1
})

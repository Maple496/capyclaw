#!/usr/bin/env node
/**
 * 统一发布到 npm：插件 + 支撑库走同一条命令。
 *
 * 设计：
 *   - 复用 tools/capyclaw-plugin-release 的同一套判定（插件校验 + 发布闸 + 包名白名单），
 *     不再自己维护一份扫描列表，避免两条发布路径的清单不一致。
 *   - 支撑库（纯库/独立服务，无 dsh.bundle，进不了插件闸）用 SUPPORT_LIBS 显式清单
 *     + 库发布闸；历史上它们靠 PUBLISHING.md 里的手动命令发布，最易漏发。
 *   - 发布顺序固定为「先库后插件」：@capyclaw/plugin-kit 必须先于消费它的插件上 registry。
 *   - 只发布**原始包目录**（依赖交给 npm 从 registry 解析）；
 *     带 vendored 依赖的 staged 副本只用于 zip 分发，不走 npm。
 *   - 默认 dry-run；显式 --execute 才真正 publish。
 *   - --tag <dist-tag> 透传 npm publish --tag（默认 latest），与 release-index 的
 *     --channel 语义对应：channel=stable ↔ latest，channel=next ↔ next。
 *
 * 用法：
 *   node scripts/publish-to-npm.mjs [--dry-run|--execute] [--skip-tests] [--only <name>] [--tag <dist-tag>]
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { discoverPlugins, publishGateErrors } from '../tools/capyclaw-plugin-release/lib/index.mjs'
import { validatePlugin } from '../tools/capyclaw-plugin-validator/lib/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 支撑库清单（显式维护；这些包没有 dsh.bundle，discoverPlugins 不收）。 */
const SUPPORT_LIBS = [
  'packages/capyclaw-plugin-kit',
  'packages/capyclaw-document-workbench',
  'extensions/bridges/ppt-bridge/capyclaw-skills-service',
]

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const execute = hasFlag('--execute') && !hasFlag('--dry-run')
const skipTests = hasFlag('--skip-tests')
const only = valueOf('--only')
const tag = valueOf('--tag') || 'latest'

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

/** 库发布闸：插件闸管不了的分发必需项。返回错误串数组。 */
function libraryGateErrors(pkg) {
  const errors = []
  if (pkg.private === true) errors.push('package.json 标记了 private: true')
  if (pkg.name.startsWith('@') && !pkg.publishConfig?.access) {
    errors.push('缺少 publishConfig.access（作用域包默认 restricted，需显式 public）')
  }
  if (!pkg.license) errors.push('缺少 license 声明')
  if (!pkg.version) errors.push('缺少 version')
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, range] of Object.entries(deps)) {
      if (/^(link|file):/.test(String(range))) {
        errors.push(`${field}.${name} 是源码树本地路径（${range}）——分发件必须走版本范围`)
      }
    }
  }
  return errors
}

/** 单包发布流程（插件与库共用）。返回结果记录。 */
async function publishOne(dir, { kind }) {
  const pkg = pkgOf(dir)
  const label = `${pkg.name}@${pkg.version}`
  if (only && pkg.name !== only) return null

  const gate = kind === 'lib' ? libraryGateErrors(pkg) : publishGateErrors(pkg, dir)
  if (gate.length) {
    console.log(`✗ ${label} — 发布闸未过`)
    for (const item of gate) console.log(`    - ${item}`)
    return { label, status: 'gate-failed', detail: gate }
  }

  if (kind === 'plugin') {
    const validation = await validatePlugin(dir)
    if (!validation.valid) {
      console.log(`✗ ${label} — 插件校验未过`)
      for (const item of validation.errors) console.log(`    - [${item.rule}] ${item.message}`)
      return { label, status: 'invalid', detail: validation.errors.map((e) => e.message) }
    }
  }

  if (alreadyPublished(pkg.name, pkg.version)) {
    console.log(`· ${label} — registry 上已存在，跳过`)
    return { label, status: 'skipped-exists' }
  }

  if (!skipTests && pkg.scripts?.test) {
    const t = run('npm', ['test'], { cwd: dir })
    if (t.status !== 0) {
      console.log(`✗ ${label} — npm test 失败，跳过发布`)
      return { label, status: 'test-failed', detail: (t.stdout || '') + (t.stderr || '') }
    }
  }

  if (!execute) {
    console.log(`→ ${label} — 待发布（dry run${tag !== 'latest' ? `，dist-tag=${tag}` : ''}）`)
    return { label, status: 'would-publish' }
  }

  const access = pkg.publishConfig?.access || 'public'
  const pub = run('npm', ['publish', '--access', access, '--tag', tag], { cwd: dir })
  if (pub.status !== 0) {
    console.log(`✗ ${label} — npm publish 失败`)
    console.log(String(pub.stderr || pub.stdout || '').trim().slice(0, 500))
    return { label, status: 'publish-failed', detail: (pub.stdout || '') + (pub.stderr || '') }
  }
  console.log(`✓ ${label} — 已发布${tag !== 'latest' ? `（dist-tag=${tag}）` : ''}`)
  return { label, status: 'published' }
}

async function main() {
  const libDirs = SUPPORT_LIBS.map((rel) => path.join(ROOT, rel)).filter((dir) => {
    if (fs.existsSync(path.join(dir, 'package.json'))) return true
    console.error(`支撑库目录缺失: ${dir}`)
    process.exitCode = 1
    return false
  })
  const pluginDirs = discoverPlugins()
  if (!libDirs.length && !pluginDirs.length) {
    console.error('没有可发布的包（全部被发布闸拦下）')
    process.exitCode = 1
    return
  }

  console.log(`模式: ${execute ? '执行发布' : 'DRY RUN（加 --execute 才会真正发布）'}${tag !== 'latest' ? `，dist-tag=${tag}` : ''}`)
  console.log(`候选: ${libDirs.length} 个支撑库 + ${pluginDirs.length} 个插件\n`)

  const results = []
  // 先库后插件：plugin-kit 等支撑库必须先上 registry，插件发布时依赖才可解析
  for (const dir of libDirs) results.push(await publishOne(dir, { kind: 'lib' }))
  for (const dir of pluginDirs) results.push(await publishOne(dir, { kind: 'plugin' }))

  const done = results.filter(Boolean)
  const summary = done.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1
    return acc
  }, {})
  console.log('\n汇总:', JSON.stringify(summary))

  const failed = done.filter((r) => ['gate-failed', 'invalid', 'test-failed', 'publish-failed'].includes(r.status))
  if (failed.length) {
    console.error(`\n${failed.length} 个包未发布：${failed.map((f) => f.label).join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('发布脚本异常:', error.message)
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * 发布前可安装性检查：对每个可发布插件
 *   1. 校验 + 发布闸（与 tools/capyclaw-plugin-release 同一套）
 *   2. npm pack --dry-run 取产物清单 → 检查必需文件在列、无绝对路径、无明文密钥
 *   3. 真正 npm pack 出 tarball → 解开扫一遍内容（双保险）
 *   4. 在临时目录 npm install 该 tarball + 依赖，确认无 404
 *
 * 这不替代 node_modules 里的真实安装（dsh 运行时另说），但能挡住
 * 「发出去装不上」这类问题：依赖不可解析、files 漏文件、把密钥打进包。
 *
 * 用法：
 *   node scripts/verify-publishable.mjs [--only <name>] [--keep]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverPlugins, publishGateErrors } from '../tools/capyclaw-plugin-release/lib/index.mjs'
import { validatePlugin } from '../tools/capyclaw-plugin-validator/lib/index.mjs'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const keep = args.includes('--keep')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SECRET_RE = /sk-[A-Za-z0-9]{20,}/
const ABS_PATH_RE = /[A-Za-z]:\\\\[^"'\s]+|\/(Users|home)\/[^"'\s]+/

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    ...opts,
  })
}

function pkgOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

/** 递归列出目录下所有文件（跳过 node_modules）。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** 本仓可 pack 的 @capyclaw/* 目录映射（短名 → 绝对路径）：
 *  可发布插件（discoverPlugins）+ packages/ 下非 private 支撑库。 */
function buildLocalDirs(pluginDirs) {
  const map = new Map()
  for (const dir of pluginDirs) {
    map.set(pkgOf(dir).name, dir)
  }
  const pkgs = path.join(ROOT, 'packages')
  for (const name of fs.existsSync(pkgs) ? fs.readdirSync(pkgs) : []) {
    const dir = path.join(pkgs, name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    if (pkgOf(dir).private) continue
    map.set(pkgOf(dir).name, dir)
  }
  return map
}

async function checkOne(dir, localDirs) {
  const pkg = pkgOf(dir)
  const label = `${pkg.name}@${pkg.version}`
  const problems = []

  const gate = publishGateErrors(pkg, dir)
  if (gate.length) problems.push(...gate.map((g) => `发布闸: ${g}`))

  const validation = await validatePlugin(dir)
  if (!validation.valid) {
    problems.push(...validation.errors.map((e) => `校验: [${e.rule}] ${e.message}`))
  }
  if (problems.length) return { label, ok: false, problems }

  // 1) dry-run 产物清单
  const dry = run('npm', ['pack', '--dry-run', '--json'], { cwd: dir })
  if (dry.status !== 0) {
    return { label, ok: false, problems: [`npm pack --dry-run 失败: ${(dry.stderr || '').trim().slice(0, 300)}`] }
  }
  let manifest
  try {
    manifest = JSON.parse(dry.stdout)[0]
  } catch {
    return { label, ok: false, problems: ['npm pack --dry-run 输出无法解析'] }
  }

  const packed = new Set((manifest.files || []).map((f) => f.path))
  const mustHave = ['package.json']
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string') mustHave.push(patch.replace(/^\.\//, ''))
  if (pkg.dsh?.client) mustHave.push('client/client.js')
  if (pkg.dsh?.suite) mustHave.push(pkg.dsh.suite.replace(/^\.\//, ''))
  const mainRel = String(pkg.main || '').replace(/^\.\//, '')
  if (mainRel) mustHave.push(mainRel)

  for (const file of mustHave) {
    if (!packed.has(file)) problems.push(`产物缺文件: ${file}`)
  }

  // 2) 真正打 tarball，解包扫内容
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pub-'))
  const pack = run('npm', ['pack', '--pack-destination', tmp], { cwd: dir })
  if (pack.status !== 0) {
    problems.push(`npm pack 失败: ${(pack.stderr || '').trim().slice(0, 300)}`)
    return { label, ok: false, problems }
  }
  const tgz = path.join(tmp, String(pack.stdout).trim().split(/\r?\n/).pop())
  const unpacked = path.join(tmp, 'unpacked')
  fs.mkdirSync(unpacked, { recursive: true })
  // 不要用 shell：Windows 下 `C:\...` 会被当成远程主机名（tar: Cannot connect to C:）
  // bsdtar 会把 `C:\...` 当成远程主机；改用 cwd + 相对路径，彻底避开绝对路径
  const untar = spawnSync('tar', ['-xzf', path.basename(tgz), '-C', 'unpacked'], {
    cwd: tmp, encoding: 'utf8', stdio: 'pipe', shell: false,
  })
  if (untar.status !== 0) {
    problems.push(`解包失败: ${(untar.stderr || '').trim().slice(0, 200)}`)
    return { label, ok: false, problems }
  }
  const root = path.join(unpacked, 'package')

  for (const file of walk(root)) {
    if (/\.(png|jpg|jpeg|gif|webp|zip|tgz|woff2?|ttf)$/i.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    if (SECRET_RE.test(text)) problems.push(`包内含明文密钥: ${path.relative(root, file)}`)
    if (ABS_PATH_RE.test(text)) problems.push(`包内含绝对路径: ${path.relative(root, file)}`)
  }

  // 3) 装进干净目录，确认依赖可解析
  //    注意：依赖里的 @capyclaw/* 若尚未发布到 registry（如新的支撑库或
  //    同批待发的插件），npm 会 404/ETARGET。这里把这些本仓包也打成
  //    tarball 一起安装，验证的是「插件自身依赖/文件完整」，而不是
  //    「依赖包已在 npm 上」——后者由发布顺序保证（先支撑库 → 运行时
  //    插件 → suite）。private 支撑库（构建期内联）不兜底，兜底会掩盖
  //    「运行时依赖了不该发布的包」这类配置错误。
  const installDir = path.join(tmp, 'consumer')
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(installDir, 'package.json'), `${JSON.stringify({ name: 'consumer', private: true, version: '1.0.0' }, null, 2)}\n`)
  const installArgs = ['install', '--no-audit', '--no-fund']
  const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
  /* 兜底集合沿依赖闭包展开：suite → workbench → document-workbench
     这类传递依赖同样未发布，只兜第一层会漏。 */
  const closure = new Set()
  const queue = Object.keys(deps).filter((n) => n.startsWith('@capyclaw/') && n !== pkg.name && localDirs.has(n))
  while (queue.length) {
    const name = queue.shift()
    if (closure.has(name)) continue
    closure.add(name)
    const meta = pkgOf(localDirs.get(name))
    for (const dep of Object.keys({ ...(meta.dependencies || {}), ...(meta.peerDependencies || {}) })) {
      if (dep.startsWith('@capyclaw/') && dep !== pkg.name && localDirs.has(dep)) queue.push(dep)
    }
  }
  for (const depName of closure) {
    const p = run('npm', ['pack', '--pack-destination', tmp], { cwd: localDirs.get(depName) })
    if (p.status === 0) {
      installArgs.push(path.join(tmp, String(p.stdout).trim().split(/\r?\n/).pop()))
    } else {
      problems.push(`本地兜底 pack ${depName} 失败: ${(p.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)}`)
    }
  }
  installArgs.push(tgz)
  const install = run('npm', installArgs, { cwd: installDir })
  if (install.status !== 0) {
    const msg = `${install.stderr || ''}${install.stdout || ''}`
    problems.push(`npm install 失败（依赖不可解析？）: ${msg.trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 600)}`)
  } else {
    const ls = run('npm', ['ls', '--all', '--depth=0'], { cwd: installDir })
    if (ls.status !== 0) problems.push(`npm ls 报告依赖问题: ${(ls.stdout || ls.stderr || '').trim().slice(0, 400)}`)
  }

  if (!keep) fs.rmSync(tmp, { recursive: true, force: true })

  return { label, ok: problems.length === 0, problems }
}

async function main() {
  const dirs = discoverPlugins()
  const targets = only ? dirs.filter((d) => pkgOf(d).name === only) : dirs
  if (!targets.length) {
    console.error(only ? `找不到可发布插件: ${only}` : '没有可发布插件')
    process.exitCode = 1
    return
  }

  console.log(`检查 ${targets.length} 个可发布插件的可安装性\n`)
  const localDirs = buildLocalDirs(dirs)
  const results = []
  for (const dir of targets) {
    const result = await checkOne(dir, localDirs)
    results.push(result)
    if (result.ok) {
      console.log(`✓ ${result.label}`)
    } else {
      console.log(`✗ ${result.label}`)
      for (const problem of result.problems) console.log(`    - ${problem}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error('检查脚本异常:', error.message)
  process.exitCode = 1
})

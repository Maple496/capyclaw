#!/usr/bin/env node
/**
 * 沙箱安装形态验证（模拟 dsh 用户视角）：
 *
 *   1. 空沙箱 profile（= dsh 删除全部插件后）
 *   2. registry 28 包：npm 上同名版本已发布 → registry 安装；未发布 → npm pack tarball 安装
 *      （后者等价于「发布后」的安装形态；document-workbench 支撑库按需一并 pack）
 *   3. 依赖树完整性 + cordis 式逐插件 import
 *   4. canvas-workbench 真浏览器全链路 + ppt-workbench 对称冒烟（--skip-browser 跳过）
 *
 * 用法：node scripts/sandbox/verify-install.mjs [--keep] [--skip-browser]
 * 沙箱默认建在系统临时目录，--keep 保留供排查。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT, Recorder } from '../e2e/harness.mjs'
import { canvasLive, pptLive } from './live.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const SKIP_BROWSER = args.includes('--skip-browser')

const rec = new Recorder('沙箱安装形态验证')
const run = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, {
  encoding: 'utf8', shell: process.platform === 'win32', ...opts,
})

/* ── 1. 版本分类：registry 版本是否已在 npm 上 ── */
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'capyclaw-registry.json'), 'utf8'))
const published = []
const local = []
for (const p of registry.plugins) {
  const v = run('npm', ['view', `${p.name}@${p.version}`, 'version'], { stdio: 'pipe' })
  ;((v.status === 0 && String(v.stdout).trim() === p.version) ? published : local).push(p)
}
rec.section(`版本分类（registry ${registry.plugins.length} 包）`)
rec.check(`npm 已发布 ${published.length} 包（registry 直装）`, published.length > 0)
console.log(`· 待发布/本地 tarball：${local.map((p) => p.name).join('、') || '无'}`)

/* document-workbench 支撑库：npm 版本落后于本地需求时也走 tarball */
const DW = path.join(ROOT, 'packages', 'capyclaw-document-workbench')
const dwLocal = JSON.parse(fs.readFileSync(path.join(DW, 'package.json'), 'utf8'))
const dwNpm = run('npm', ['view', `${dwLocal.name}@${dwLocal.version}`, 'version'], { stdio: 'pipe' })
const dwNeeded = dwNpm.status !== 0 || String(dwNpm.stdout).trim() !== dwLocal.version

/* ── 2. 沙箱 profile：安装（已发布走 registry，其余走 pack tarball） ── */
rec.section('沙箱安装（空 profile → npm 全量安装）')
const SB = path.join(os.tmpdir(), `dsh-plugin-verify-${Date.now().toString(36)}`)
const PROFILE = path.join(SB, 'profile')
const TB = path.join(SB, 'tarballs')
fs.mkdirSync(PROFILE, { recursive: true })
fs.mkdirSync(TB, { recursive: true })
fs.writeFileSync(path.join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-plugin-verify', private: true, version: '1.0.0', dependencies: {} }, null, 2)}\n`)
console.log(`· 沙箱：${PROFILE}`)

if (published.length) {
  const spec = published.map((p) => `${p.name}@${p.version}`)
  const r = run('npm', ['install', '--no-audit', '--no-fund', ...spec], { cwd: PROFILE })
  rec.check(`registry 安装 ${published.length} 包`, r.status === 0, `${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
}

const packDirs = local.map((p) => path.join(ROOT, p.directory))
if (dwNeeded) packDirs.push(DW)
if (packDirs.length) {
  const tarballs = []
  for (const dir of packDirs) {
    const r = run('npm', ['pack', '--pack-destination', TB], { cwd: dir, stdio: 'pipe' })
    if (r.status !== 0) { rec.check(`npm pack ${path.basename(dir)}`, false, (r.stderr || '').slice(0, 120)); continue }
    tarballs.push(path.join(TB, String(r.stdout).trim().split(/\r?\n/).pop()))
  }
  const r = run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: PROFILE })
  rec.check(`tarball 安装 ${tarballs.length} 个（未发布集，等价发布后形态）`, r.status === 0, `${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
}

/* ── 3. 依赖树 + cordis 加载 ── */
rec.section('依赖树与 cordis 加载')
const ls = run('npm', ['ls', '--all'], { cwd: PROFILE, stdio: 'pipe' })
rec.check('npm ls 无 UNMET/invalid', !/UNMET|invalid|missing/.test(`${ls.stdout}${ls.stderr}`), (ls.stderr || '').trim().slice(0, 200))

const scope = path.join(PROFILE, 'node_modules', '@capyclaw')
const dirs = fs.existsSync(scope) ? fs.readdirSync(scope).map((d) => path.join(scope, d)) : []
let loadPass = 0
const loadFail = []
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (!pkg.dsh?.bundle) continue /* 支撑库（plugin-kit/document-workbench 等）不加载进 dsh */
  const problems = []
  const patch = pkg.dsh.bundle.patch
  if (patch && !fs.existsSync(path.join(dir, patch.replace(/^\.\//, '')))) problems.push(`缺 ${patch}`)
  try {
    const mod = await import(pathToFileURL(path.resolve(dir, pkg.main || 'lib/index.mjs')).href)
    if (typeof mod.apply !== 'function') problems.push('未导出 apply()')
    if (typeof mod.name !== 'string') problems.push('未导出 name')
  } catch (e) { problems.push('import 失败: ' + e.message.split('\n')[0]) }
  if (problems.length) loadFail.push(`${pkg.name}: ${problems.join('; ')}`)
  else loadPass++
}
rec.check(`cordis 加载 ${loadPass} 插件全部通过`, loadFail.length === 0, loadFail.join(' | '))

/* ── 4. 服务级实测 ── */
if (!SKIP_BROWSER) {
  rec.section('canvas-workbench 真浏览器全链路')
  try {
    await canvasLive(rec, { wbDir: path.join(scope, 'canvas-workbench') })
  } catch (e) { rec.check('canvas 实测流程', false, e.message) }

  rec.section('ppt-workbench 对称冒烟')
  try {
    await pptLive(rec, { wbDir: path.join(scope, 'ppt-workbench') })
  } catch (e) { rec.check('ppt 冒烟流程', false, e.message) }
} else {
  rec.skip('服务级实测', '--skip-browser')
}

/* ── 收尾 ── */
if (!KEEP) fs.rmSync(SB, { recursive: true, force: true })
else console.log(`\n· 沙箱保留：${SB}`)

const summary = rec.summary()
process.exit(summary.fail ? 1 : 0)

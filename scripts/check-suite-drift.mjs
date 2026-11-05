#!/usr/bin/env node
/**
 * 检查公共插件元数据与三个 bridge suite 的一致性。
 *
 * 三层闸：
 *   1. 仓库级：5 个公共插件（service-host 等）自己的 dsh-suite.json 自条目
 *      的 version 必须与自己的 package.json 一致，且声明 dsh.apiVersion——
 *      suite 经 components 组合时拉的就是这份自条目，版本滞后会让组合
 *      静默拿到旧元数据。
 *   2. suite 级：三个 suite（ppt/canvas/browser）都必须锁定
 *      @capyclaw/plugin-kit support 包，且 range 满足本地 kit 版本
 *      （真 semver 判断，不用字符串包含）。
 *   3. 引用级：suite 若（经 packages 或 components）引用公共插件，其条目
 *      （role/version/provides）必须与公共插件自条目一致。
 *
 * 用法：node scripts/check-suite-drift.mjs
 * 退出码 0 = 一致；1 = 漂移（打印具体字段）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const PUBLIC_PACKAGES = [
  'capyclaw-service-host',
  'capyclaw-tool-host',
  'capyclaw-state-service',
  'capyclaw-asset-service',
  'capyclaw-editor-host',
]

/* 各 suite 必须引用的公共插件（packages 条目或 components 组合皆可）。
 * ppt 套件不消费 ctx.state（journal/checkpoint 由 document-workbench 直接落盘），
 * 因此 state-service 不在 ppt 的必需集合里；canvas/browser 不经 components
 * 组合公共插件（公共代码走 build 时的 shared 快照），必需集合为空。 */
const SUITES = [
  {
    id: 'ppt',
    dir: path.join(ROOT, 'extensions', 'bridges', 'ppt-bridge', 'plugin', 'capyclaw-ppt-suite'),
    required: ['capyclaw-service-host', 'capyclaw-tool-host', 'capyclaw-asset-service', 'capyclaw-editor-host'],
  },
  {
    id: 'canvas',
    dir: path.join(ROOT, 'extensions', 'bridges', 'canvas-bridge', 'plugin', 'capyclaw-canvas-suite'),
    required: [],
  },
  {
    id: 'browser',
    dir: path.join(ROOT, 'extensions', 'bridges', 'browser-bridge', 'plugin', 'capyclaw-browser-suite'),
    required: [],
  },
]

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
/* suite manifest 的 packages key 统一用 npm 发布名（@capyclaw/*），本地目录名 = 包名去 scope（capyclaw-*） */
const npmNameOf = (pkg) => '@capyclaw/' + pkg.replace(/^capyclaw-/, '')
const pickProvides = (entry) => ({
  services: [...(entry.provides?.services || [])].sort(),
  capabilities: Object.fromEntries(Object.entries(entry.provides?.capabilities || {}).sort()),
})

/** ^X.Y.Z 范围满足判断。本仓引用只有 ^ 与精确两种形态；^0.x.y 不跨 minor，^0.0.z 不跨 patch。 */
export function satisfiesRange(range, version) {
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim())
  if (!caret) return String(range).trim() === String(version).trim()
  const [maj, min, pat] = caret.slice(1).map(Number)
  const v = String(version).trim().split('.').map(Number)
  if (v.length < 3 || v.some((n) => Number.isNaN(n))) return false
  if (v[0] !== maj) return false
  if (maj === 0) {
    if (min === 0) return v[1] === 0 && v[2] >= pat // ^0.0.z
    return v[1] === min && v[2] >= pat // ^0.y.z
  }
  return v[1] > min || (v[1] === min && v[2] >= pat) // ^X.Y.Z
}

export function checkSuiteDrift({ quiet = false } = {}) {
  const issues = []
  const kitVersion = readJson(path.join(ROOT, 'packages', 'capyclaw-plugin-kit', 'package.json')).version

  /* 1. 仓库级：公共插件自条目与自己的 package.json 对账 */
  const ownEntries = new Map()
  for (const name of PUBLIC_PACKAGES) {
    const ownPath = path.join(ROOT, 'packages', name, 'dsh-suite.json')
    if (!fs.existsSync(ownPath)) {
      issues.push(`${name}: 缺少自己的 dsh-suite.json`)
      continue
    }
    const own = readJson(ownPath)
    const ownEntry = own.packages?.[npmNameOf(name)] || own.packages?.[name]
    if (!ownEntry) { issues.push(`${name}: 自己的 suite 缺少 package 条目`); continue }
    const pkg = readJson(path.join(ROOT, 'packages', name, 'package.json'))
    if (pkg.version !== String(ownEntry.version).replace(/^\^/, '')) {
      issues.push(`${name}: package.json version=${pkg.version} 与自条目 version=${ownEntry.version} 不一致`)
    }
    if (!pkg.dsh?.apiVersion) issues.push(`${name}: package.json 缺少 dsh.apiVersion`)
    ownEntries.set(npmNameOf(name), ownEntry)
  }

  /* 2+3. suite 级：plugin-kit 锁；引用级：公共插件条目与自条目对账 */
  for (const suite of SUITES) {
    const file = path.join(suite.dir, 'dsh-suite.json')
    if (!fs.existsSync(file)) {
      issues.push(`${suite.id} suite 缺少 dsh-suite.json: ${path.relative(ROOT, file)}`)
      continue
    }
    const manifest = readJson(file)
    const components = new Set((manifest.components || []).map((item) => path.resolve(suite.dir, item)))
    const locked = manifest.packages?.['@capyclaw/plugin-kit']
    if (!locked) issues.push(`${suite.id} suite 缺少 @capyclaw/plugin-kit support package`)
    else if (!satisfiesRange(locked.version, kitVersion)) {
      issues.push(`@capyclaw/plugin-kit: package.json=${kitVersion} 不满足 ${suite.id} suite 锁定 ${locked.version}`)
    }
    for (const name of PUBLIC_PACKAGES) {
      const npmName = npmNameOf(name)
      const ownEntry = ownEntries.get(npmName)
      if (!ownEntry) continue /* 仓库级闸已报 */
      const suiteEntry = manifest.packages?.[npmName]
        || (components.has(path.join(ROOT, 'packages', name)) ? ownEntry : null)
      if (!suiteEntry) {
        if (suite.required.includes(name)) {
          issues.push(`${name}: ${suite.id} suite 缺少引用（packages 条目或 components 组合）`)
        }
        continue
      }
      for (const field of ['role', 'version']) {
        if (String(ownEntry[field]) !== String(suiteEntry[field])) {
          issues.push(`${name}.${field}: own=${ownEntry[field]} ${suite.id}=${suiteEntry[field]}`)
        }
      }
      const a = pickProvides(ownEntry)
      const b = pickProvides(suiteEntry)
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        issues.push(`${name}.provides: own=${JSON.stringify(a)} ${suite.id}=${JSON.stringify(b)}`)
      }
    }
  }

  if (!quiet) {
    if (issues.length) console.error('✗ suite 元数据漂移:\n- ' + issues.join('\n- '))
    else console.log('✓ 公共插件元数据与 3 个 suite（ppt/canvas/browser）一致')
  }
  return { ok: issues.length === 0, issues }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSuiteDrift()
  process.exit(result.ok ? 0 : 1)
}

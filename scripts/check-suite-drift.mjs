#!/usr/bin/env node
/**
 * 检查 capyclaw-ppt-suite 中公共插件元数据是否与各插件自己的 dsh-suite.json 漂移。
 *
 * 用法：node scripts/check-suite-drift.mjs
 * 退出码 0 = 一致；1 = 漂移（打印具体字段）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PPT_SUITE = [
  path.join(ROOT, 'extensions', 'bridges', 'ppt-bridge', 'plugin', 'capyclaw-ppt-suite', 'dsh-suite.json'),
  path.join(ROOT, 'bridges', 'ppt-bridge', 'plugin', 'capyclaw-ppt-suite', 'dsh-suite.json'),
].find((candidate) => fs.existsSync(candidate)) || ''
const PUBLIC_PACKAGES = [
  'dsh-service-host',
  'dsh-tool-host',
  'dsh-state-service',
  'dsh-asset-service',
  'dsh-editor-host',
]

/* PPT 套件不消费 ctx.state（journal/checkpoint 由 document-workbench 直接落盘），
 * 因此 dsh-state-service 允许不出现在套件里；其余公共插件必须声明。 */
const OPTIONAL_PACKAGES = new Set(['dsh-state-service'])

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const pickProvides = (entry) => ({
  services: [...(entry.provides?.services || [])].sort(),
  capabilities: Object.fromEntries(Object.entries(entry.provides?.capabilities || {}).sort()),
})

export function checkSuiteDrift({ quiet = false } = {}) {
  const issues = []
  const ppt = readJson(PPT_SUITE)
  const pptDir = path.dirname(PPT_SUITE)
  const components = new Set((ppt.components || []).map((item) => path.resolve(pptDir, item)))
  for (const name of PUBLIC_PACKAGES) {
    const ownPath = path.join(ROOT, 'packages', name, 'dsh-suite.json')
    if (!fs.existsSync(ownPath)) {
      issues.push(`${name}: 缺少自己的 dsh-suite.json`)
      continue
    }
    const own = readJson(ownPath)
    const ownEntry = own.packages?.[name]
    const pptEntry = ppt.packages?.[name]
      || (components.has(path.resolve(ROOT, 'packages', name)) ? ownEntry : null)
    if (!ownEntry) { issues.push(`${name}: 自己的 suite 缺少 package 条目`); continue }
    if (!pptEntry) {
      if (OPTIONAL_PACKAGES.has(name)) continue
      issues.push(`${name}: capyclaw-ppt-suite 缺少 package 条目`)
      continue
    }
    for (const field of ['role', 'version']) {
      if (String(ownEntry[field]) !== String(pptEntry[field])) {
        issues.push(`${name}.${field}: own=${ownEntry[field]} ppt=${pptEntry[field]}`)
      }
    }
    const a = pickProvides(ownEntry)
    const b = pickProvides(pptEntry)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      issues.push(`${name}.provides: own=${JSON.stringify(a)} ppt=${JSON.stringify(b)}`)
    }
    const pkg = readJson(path.join(ROOT, 'packages', name, 'package.json'))
    if (pkg.version !== ownEntry.version?.replace(/^\^/, '')) {
      issues.push(`${name}: package.json version=${pkg.version} 与 suite version=${ownEntry.version} 不一致`)
    }
    const apiVersion = pkg.dsh?.apiVersion
    if (!apiVersion) issues.push(`${name}: package.json 缺少 dsh.apiVersion`)
    const locked = ppt.packages?.['dsh-plugin-kit']
    if (!locked) issues.push('capyclaw-ppt-suite 缺少 dsh-plugin-kit support package')
  }
  const kitVersion = readJson(path.join(ROOT, 'packages', 'dsh-plugin-kit', 'package.json')).version
  const pptKit = ppt.packages?.['dsh-plugin-kit']?.version
  if (pptKit && !pptKit.includes(kitVersion)) {
    issues.push(`dsh-plugin-kit: package.json=${kitVersion} ppt=${pptKit}`)
  }
  if (!quiet) {
    if (issues.length) console.error('✗ suite 元数据漂移:\n- ' + issues.join('\n- '))
    else console.log('✓ 公共插件元数据与 capyclaw-ppt-suite 一致')
  }
  return { ok: issues.length === 0, issues }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSuiteDrift()
  process.exit(result.ok ? 0 : 1)
}

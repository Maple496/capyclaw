/**
 * 源校验器：按 PLUGIN_SOURCE_STANDARD.md（plugin-source/1）逐条核验任意源。
 *
 * 这是「切换源」前的守门人：不管源是谁产的，跑一遍就知道能不能用。
 *   - 只读，不写任何东西；本地目录与 http(s) 两种形态走同一套断言。
 *   - 每条违规都带条目名与具体原因，便于源作者修。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { listZipEntryNames, readZipEntryBuffer } from './index.mjs'

const SHA256_RE = /^[0-9a-f]{64}$/
// 允许 dsh-<name> / @org/dsh-<name> / 已发布作用域 @capyclaw/<name>
const NAME_RE = /^((@[\w.-]+\/)?dsh-[\w.-]+|@capyclaw\/[\w.-]+)$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function isHttp(target) {
  return /^https?:\/\//i.test(target)
}

async function loadBytes(target, rel) {
  if (isHttp(target)) {
    const url = `${target.replace(/\/+$/, '')}/${rel}`
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const root = target.startsWith('file://') ? decodeURIComponent(target.slice(7)) : target
  const file = path.join(root, ...rel.split('/'))
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`)
  return fs.readFileSync(file)
}

function safeRel(rel) {
  const text = String(rel || '').replace(/\\/g, '/')
  if (!text || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return false
  if (text.split('/').some((part) => part === '..')) return false
  return true
}

/** 校验一个源。返回 {ok, target, errors, warnings, plugins, channel}。 */
export async function verifySource(target, { maxBytes = 4 * 1024 ** 3 } = {}) {
  const errors = []
  const warnings = []
  const plugins = []
  const report = { ok: false, target, channel: '', schema: null, errors, warnings, plugins }

  if (!target) {
    errors.push('缺源地址')
    return report
  }
  if (!isHttp(target) && !fs.existsSync(target)) {
    errors.push(`源不存在: ${target}`)
    return report
  }

  let index
  try {
    const raw = await loadBytes(target, 'index.json')
    if (raw.length > 4 * 1024 * 1024) errors.push('index.json 超过 4 MB 上限')
    index = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    errors.push(`读不到 index.json: ${error.message}`)
    return report
  }

  report.schema = index?.schema
  report.channel = String(index?.channel || '')
  if (index?.schema !== 1) {
    errors.push(`index.json schema 必须是 1，实际 ${JSON.stringify(index?.schema)}`)
    return report
  }
  if (!Array.isArray(index.plugins)) {
    errors.push('index.json 缺 plugins 数组')
    return report
  }
  if (index.plugins.length === 0) errors.push('index.json 的 plugins 为空')

  const seen = new Set()
  for (const [i, entry] of index.plugins.entries()) {
    const label = entry?.name && entry?.version ? `${entry.name}@${entry.version}` : `plugins[${i}]`
    const item = { name: '', version: '', file: '', ok: true, errors: [] }
    const fail = (msg) => { item.ok = false; item.errors.push(msg); errors.push(`${label}: ${msg}`) }

    if (!entry || typeof entry !== 'object') { fail('条目不是对象'); plugins.push(item); continue }
    item.name = String(entry.name || '')
    item.version = String(entry.version || '')
    item.file = String(entry.file || '')

    if (!NAME_RE.test(item.name)) fail(`name 不合法（应为 dsh-* 或 @capyclaw/*）: ${JSON.stringify(entry.name)}`)
    if (!SEMVER_RE.test(item.version)) fail(`version 不是严格 semver: ${JSON.stringify(entry.version)}`)
    if (!safeRel(entry.file)) fail(`file 必须是相对源根的安全路径: ${JSON.stringify(entry.file)}`)
    if (!SHA256_RE.test(String(entry.sha256 || ''))) fail('sha256 缺失或不是 64 位小写十六进制')
    if (typeof entry.bundle !== 'boolean') fail('bundle 必须是布尔（false 的条目不可安装）')
    if (typeof entry.dsh !== 'string' || !entry.dsh.trim()) fail('dsh 必须是非空的 engines.dsh 范围')

    const key = `${item.name}@${item.version}`
    if (seen.has(key)) fail('索引里出现重复的 name@version')
    seen.add(key)

    if (!item.ok) { plugins.push(item); continue }

    // ---- 包实体校验 ----
    let data
    try {
      data = await loadBytes(target, item.file)
    } catch (error) {
      fail(`包读不到: ${error.message}`)
      plugins.push(item)
      continue
    }
    if (data.length > maxBytes) fail(`包超过体积上限 ${maxBytes}`)
    item.size = data.length

    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== entry.sha256) {
      fail(`sha256 不匹配（索引 ${String(entry.sha256).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`)
    }

    let names = []
    try {
      names = listZipEntryNames(data, item.file)
    } catch (error) {
      fail(`不是有效 ZIP: ${error.message}`)
      plugins.push(item)
      continue
    }
    const unsafe = names.filter((n) => n.startsWith('/') || n.split('/').includes('..'))
    if (unsafe.length) fail(`ZIP 内含不安全路径: ${unsafe.slice(0, 3).join(', ')}`)

    const pkgRaw = readZipEntryBuffer(data, 'package.json', item.file)
    if (!pkgRaw) {
      fail('ZIP 根没有 package.json')
      plugins.push(item)
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(pkgRaw.toString('utf8'))
    } catch {
      fail('ZIP 内 package.json 不是合法 JSON')
      plugins.push(item)
      continue
    }
    if (pkg.name !== item.name) fail(`包内 name ${JSON.stringify(pkg.name)} 与索引不一致`)
    if (pkg.version !== item.version) fail(`包内 version ${JSON.stringify(pkg.version)} 与索引不一致`)

    const patch = pkg.dsh?.bundle?.patch
    const patches = Array.isArray(patch) ? patch : patch ? [patch] : []
    if (!patches.length) fail('包内缺 dsh.bundle.patch（装上也不会被加载）')
    for (const rel of patches) {
      const norm = String(rel).replace(/^\.\//, '').replace(/\\/g, '/')
      if (!names.includes(norm)) fail(`dsh.bundle.patch 指向的文件不在包里: ${rel}`)
    }
    if (!patches.length && entry.bundle === true) fail('索引标 bundle:true，但包内没有 dsh.bundle')

    const enginesDsh = pkg.engines?.dsh
    if (typeof enginesDsh !== 'string' || !enginesDsh.trim()) fail('包内缺 engines.dsh')
    else if (enginesDsh !== entry.dsh) {
      warnings.push(`${label}: 索引 dsh=${entry.dsh} 与包内 engines.dsh=${enginesDsh} 不一致`)
    }

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dep, range] of Object.entries(pkg[field] || {})) {
        if (/^(link|file):/.test(String(range))) {
          fail(`${field}.${dep} 是源码树本地路径（${range}）——分发出去必断`)
        }
      }
    }

    const main = pkg.main
    if (main && !names.includes(String(main).replace(/^\.\//, '').replace(/\\/g, '/'))) {
      fail(`package.json.main 指向的文件不在包里: ${main}`)
    }

    plugins.push(item)
  }

  // latest 一致性：同名的多个版本里不应有多个 latest
  const byName = new Map()
  for (const entry of index.plugins) {
    if (!entry?.name) continue
    if (!byName.has(entry.name)) byName.set(entry.name, [])
    byName.get(entry.name).push(entry)
  }
  for (const [name, list] of byName) {
    const flagged = list.filter((e) => e.latest === true)
    if (flagged.length > 1) warnings.push(`${name}: 有 ${flagged.length} 个版本同时标 latest，消费方行为不确定`)
    if (list.length > 1 && flagged.length === 0) {
      warnings.push(`${name}: 多版本共存但没有 latest 标记，消费方会取最高版本`)
    }
  }

  report.ok = errors.length === 0
  return report
}

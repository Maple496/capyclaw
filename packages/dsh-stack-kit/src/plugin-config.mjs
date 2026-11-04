/**
 * 把 stack 里的 `plugins.configs` 变成 profile 的 patch 覆盖行。
 *
 * 为什么要「先取插件默认值再深合并」：
 *   dsh 的 patch 覆盖语义是**逐键赋值**（`target[key] = value`），`config` 是整键替换，
 *   不是深合并。若直接把用户片段写成 override 行，插件自己 cordis.patch.yml 里的默认
 *   配置会整体丢失。所以这里先读插件包自己的 patch，取出目标行的默认 config，
 *   深合并后再写出一条**完整**的 override 行。
 *
 * 找不到行 → 直接报错（不静默）。行不存在却继续写，会让插件跑在错误的默认值上，
 * 这类「行不存在 ≠ 错误」的静默失败此前已经出过事故。
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/** 简单深合并：对象递归，数组/标量整体替换。 */
export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (base === undefined) return patch
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(base) || !isObj(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}

/** 从 bundle 目录读它的 patch 文件（package.json 的 dsh.bundle.patch）。 */
export function readBundlePatch(bundleDir) {
  const pkgFile = path.join(bundleDir, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    throw new Error(`bundle 目录里没有 package.json: ${bundleDir}`)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const rel = pkg?.dsh?.bundle?.patch
  if (!rel) {
    throw new Error(`${pkg.name || bundleDir} 没有声明 dsh.bundle.patch，无法注入 config`)
  }
  const file = path.join(bundleDir, rel)
  if (!fs.existsSync(file)) {
    throw new Error(`${pkg.name}: dsh.bundle.patch 指向的文件不存在: ${rel}`)
  }
  const text = fs.readFileSync(file, 'utf8')
  let doc
  try {
    doc = yaml.load(text)
  } catch (error) {
    throw new Error(`${pkg.name}: patch 解析失败 (${rel}): ${error.message}`)
  }
  const patches = Array.isArray(doc) ? doc : []
  const rows = []
  for (const entry of patches) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) {
        if (row && typeof row === 'object' && row.id) rows.push(row)
      }
    }
  }
  return { pkg, file, rows }
}

/**
 * 计算 configs 通道要写入的 override 行。
 *
 * @param {object} params
 * @param {Array<{name:string,row?:string,config:object}>} params.configs  stack.plugins.configs
 * @param {(name:string)=>{dir:string,kind:string}|null} params.resolveBundle 包名 → 目录
 * @returns {{ rows: Array, details: Array }}
 */
export function buildConfigPatches({ configs = [], resolveBundle }) {
  const rows = []
  const details = []
  const seen = new Set()

  for (const [index, item] of configs.entries()) {
    if (!item || typeof item !== 'object' || !item.name) {
      throw new Error(`plugins.configs[${index}] 缺少 name`)
    }
    const name = String(item.name)
    const resolved = resolveBundle(name)
    if (!resolved?.dir) {
      throw new Error(`plugins.configs[${index}]: 找不到 bundle ${name}（它必须同时出现在 plugins.bundles 里）`)
    }
    const { rows: defaultRows } = readBundlePatch(resolved.dir)

    let target
    if (item.row) {
      target = defaultRows.find((r) => r.id === item.row)
      if (!target) {
        const known = defaultRows.map((r) => r.id).join(', ') || '(无 insert 行)'
        throw new Error(`${name}: 找不到 row "${item.row}"（可用的行: ${known}）`)
      }
    } else if (defaultRows.length === 1) {
      target = defaultRows[0]
    } else if (defaultRows.length === 0) {
      throw new Error(`${name}: 该包没有可配置的 insert 行（dsh.bundle.patch 里没有 insert）`)
    } else {
      const known = defaultRows.map((r) => r.id).join(', ')
      throw new Error(`${name}: 有多个可配置行（${known}），请在 configs 里用 row 指定其一`)
    }

    const key = target.id
    if (seen.has(key)) {
      throw new Error(`plugins.configs 里重复配置了同一行: ${key}`)
    }
    seen.add(key)

    const merged = deepMerge(target.config || {}, item.config || {})
    const row = { id: target.id, name: target.name || name }
    if (merged && Object.keys(merged).length) row.config = merged
    rows.push(row)
    details.push({
      bundle: name,
      row: target.id,
      defaults: target.config || {},
      overrides: item.config || {},
      merged,
    })
  }

  return { rows, details }
}

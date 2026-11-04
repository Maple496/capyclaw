/**
 * 行覆盖审计（Row Coverage Audit）。
 *
 * 防御 ppt-workbench-host 类故障：domain 的 runtime.bindings / removeRows 引用某个
 * row id，但组件链里没有任何 patch/manifest 声明它 —— 行不存在不是错误，运行时
 * 会静默失去宿主（content 端口无人绑定，健康检查超时且零日志）。
 *
 * 审计规则：bindings[].row 与 removeRows[] 里每个 id，必须能在组件链的以下任一处
 * 找到声明：
 *   1. suite manifest 的 rows[].id
 *   2. suite packages[].path 指向的包目录里 cordis.patch.yml 的 insert `id:`
 * 审计只读声明面，不做端口/版本检查（那是 composeSuites 的职责）——独立、单一。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDomain } from '../src/domain.mjs'

/** 从 cordis.patch.yml 文本收集 insert 行 id（容忍引号与缩进；只认 `- id:` 条目行）。 */
export function collectPatchRowIds(patchText) {
  const ids = []
  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+id:\s*(.+?)\s*$/)
    if (match) ids.push(match[1].replace(/^['"]|['"]$/g, ''))
  }
  return ids
}

/** 收集一个 suite 的全部声明行 id：manifest rows + suite 级 cordis.patch.yml + 各包 cordis.patch.yml。 */
export function collectSuiteDeclaredRows(suite, resolved) {
  const declared = new Map() // id -> [{where}]
  const record = (id, where) => {
    if (!declared.has(id)) declared.set(id, [])
    declared.get(id).push(where)
  }
  for (const row of suite.manifest.rows || []) {
    if (row?.id) record(row.id, `${suite.manifest.name}:rows[]`)
  }
  if (suite.dir) {
    // suite 级 patch（如 dsh-ppt-suite：宿主/技能行声明在 suite 自己的 cordis.patch.yml）
    const suitePatch = path.join(suite.dir, 'cordis.patch.yml')
    const suiteIds = readPatchRowIdsCached(suitePatch)
    if (suiteIds.length) {
      const where = `${suite.manifest.name}:cordis.patch.yml`
      for (const id of suiteIds) record(id, where)
    }
  }
  for (const [name, entry] of Object.entries(suite.manifest.packages || {})) {
    const rel = entry?.path
    if (!rel || !suite.dir) continue
    const packageDir = path.isAbsolute(rel) ? rel : path.resolve(suite.dir, rel)
    const patchFile = path.join(packageDir, 'cordis.patch.yml')
    const ids = readPatchRowIdsCached(patchFile)
    const where = `${name}:cordis.patch.yml`
    for (const id of ids) record(id, where)
  }
  void resolved
  return declared
}

/**
 * 进程内 patch 行 id 缓存：键 = 文件路径，值 = { mtimeMs, size, ids }。
 * 重复调用（控制面 create / deploy validate / 安装）省去重复的文件读取与逐行扫描；
 * mtime+size 变化即失效，文件被就地修改也不会读到旧数据。
 * 上限保护：包级 patch 数量有限，超过 MAX 时整体清空（简单 LRU 近似）。
 */
const PATCH_CACHE_MAX = 512
const patchCache = new Map()

function readPatchRowIdsCached(patchFile) {
  let stat
  try {
    stat = fs.statSync(patchFile)
  } catch {
    return []
  }
  const hit = patchCache.get(patchFile)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.ids
  const ids = collectPatchRowIds(fs.readFileSync(patchFile, 'utf8'))
  if (patchCache.size >= PATCH_CACHE_MAX) patchCache.clear()
  patchCache.set(patchFile, { mtimeMs: stat.mtimeMs, size: stat.size, ids })
  return ids
}

/** 清空 patch 缓存（测试/长驻进程显式刷新用）。 */
export function clearPatchCache() {
  patchCache.clear()
}

/**
 * 审计一个 domain 的行覆盖。
 * @param {string} domainInput - domain 目录或 manifest 路径（与 createRuntime 的 domainInput 同口径）
 * @returns {{ ok: boolean, missing: Array<{id, referencedBy}>, declaredCount: number, suites: string[] }}
 */
export function auditRowCoverage(domainInput) {
  const resolved = resolveDomain(domainInput)
  const domain = resolved.manifest

  const declared = new Map()
  for (const suite of resolved.suites) {
    for (const [id, where] of collectSuiteDeclaredRows(suite, resolved)) {
      if (!declared.has(id)) declared.set(id, [])
      declared.get(id).push(...where)
    }
  }

  const referenced = []
  for (const binding of domain.runtime?.bindings || []) {
    if (binding?.row) referenced.push({ id: binding.row, referencedBy: 'runtime.bindings' })
  }
  for (const id of domain.removeRows || []) {
    referenced.push({ id, referencedBy: 'removeRows' })
  }

  const missing = referenced
    .filter((ref) => !declared.has(ref.id))
    .map((ref) => ({ id: ref.id, referencedBy: ref.referencedBy }))

  return {
    ok: missing.length === 0,
    missing,
    declaredCount: declared.size,
    suites: resolved.suites.map((suite) => suite.manifest.name),
  }
}

/**
 * 清单（Manifest）归一化与校验。
 *
 * 清单是「外部的期望状态」，与当前 profile 的实际状态比对后决定开关动作。
 * 本轮只定义结构；来源可以是本地文件，将来可以是 HTTP / npm registry。
 *
 * 结构：
 * {
 *   "version": 1,
 *   "plugins": [
 *     { "name": "@capyclaw/launchpad", "version": "1.1.0", "enabled": true }
 *   ],
 *   "entries": [
 *     { "entryId": "include:launchpad-host", "enabled": false }
 *   ]
 * }
 *
 * 约定：
 *   - name       bundle 包名（对应 profile 的 dsh.profile.bundles 条目）
 *   - enabled    bundle 是否参与组合（缺省 true）
 *   - version    期望版本，仅用于报告差异，本轮不触发安装
 *   - entries    行级开关，entryId 用 inventory 里的 entryId（通常 `include:<rowId>`）
 */

export const MANIFEST_VERSION = 1

export class ManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManifestError'
    this.code = 'INVALID_MANIFEST'
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new ManifestError(`${field} 必须是非空字符串`)
  return value.trim()
}

/**
 * @param {unknown} raw 已解析的清单 JSON
 * @returns {{ version:number, plugins:Array<{name:string,version?:string,enabled:boolean}>, entries:Array<{entryId:string,enabled:boolean}>, meta:object }}
 */
export function normalizeManifest(raw) {
  if (!isObject(raw)) throw new ManifestError('清单必须是对象')
  const version = raw.version ?? MANIFEST_VERSION
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(`不支持的清单版本: ${JSON.stringify(version)}（期望 ${MANIFEST_VERSION}）`)
  }

  const pluginsRaw = raw.plugins ?? []
  if (!Array.isArray(pluginsRaw)) throw new ManifestError('plugins 必须是数组')

  const seen = new Set()
  const plugins = pluginsRaw.map((item, index) => {
    if (!isObject(item)) throw new ManifestError(`plugins[${index}] 必须是对象`)
    const name = requireString(item.name, `plugins[${index}].name`)
    if (seen.has(name)) throw new ManifestError(`plugins 里重复的包名: ${name}`)
    seen.add(name)
    const out = { name, enabled: item.enabled !== false }
    if (item.version !== undefined) {
      out.version = requireString(item.version, `plugins[${index}].version`)
    }
    return out
  })

  const entriesRaw = raw.entries ?? []
  if (!Array.isArray(entriesRaw)) throw new ManifestError('entries 必须是数组')
  const seenEntries = new Set()
  const entries = entriesRaw.map((item, index) => {
    if (!isObject(item)) throw new ManifestError(`entries[${index}] 必须是对象`)
    const entryId = requireString(item.entryId, `entries[${index}].entryId`)
    if (seenEntries.has(entryId)) throw new ManifestError(`entries 里重复的 entryId: ${entryId}`)
    seenEntries.add(entryId)
    return { entryId, enabled: item.enabled !== false }
  })

  return {
    version,
    plugins,
    entries,
    meta: isObject(raw.meta) ? raw.meta : {},
  }
}

/** 只比较会被「期望状态」影响的字段，便于测试与日志。 */
export function summarizeManifest(manifest) {
  return {
    version: manifest.version,
    plugins: manifest.plugins.map((p) => `${p.name}${p.version ? `@${p.version}` : ''}${p.enabled ? '' : ' (off)'}`),
    entries: manifest.entries.map((e) => `${e.entryId}${e.enabled ? '' : ' (off)'}`),
  }
}

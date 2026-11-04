/**
 * 期望状态 × 实际状态 → 差异。
 *
 * 实际状态来自 dsh 原生：
 *   - pluginManager.listBundles()  → [{ name, version, enabled, installed, error?, rows[] }]
 *   - pluginManager.listPlugins()  → [{ entryId, moduleName, enabled, fiberPhase, patchId? | readOnlyReason? }]
 *
 * 差异分四类：
 *   bundles[]  bundle 级开关（参与/不参与组合；dsh 会保留 dependencies）
 *   entries[]  行级开关（只关这一行；bundle 仍在）
 *   missing[]  清单里有、但当前安装/选择里没有的 bundle
 *   readonly[] 行不可改（dsh 返回 readOnlyReason）——不静默，单独列出
 *   versions[] 版本不符（只报告，不触发安装）
 */

const sameVersion = (a, b) => String(a ?? '') === String(b ?? '')

export function diffManifest({ desired, bundles = [], plugins = [] }) {
  const bundleByName = new Map(bundles.map((b) => [b.name, b]))
  const pluginByEntry = new Map(plugins.map((p) => [p.entryId, p]))

  const bundleChanges = []
  const missing = []
  const versions = []

  for (const want of desired.plugins) {
    const actual = bundleByName.get(want.name)
    if (!actual) {
      missing.push({ name: want.name, reason: '当前 profile 的 bundles 里没有这个包' })
      continue
    }
    if (actual.error) {
      missing.push({ name: want.name, reason: `该 bundle 加载出错: ${actual.error}` })
    }
    if (want.enabled !== Boolean(actual.enabled)) {
      bundleChanges.push({
        op: 'bundle',
        name: want.name,
        enabled: want.enabled,
        current: Boolean(actual.enabled),
      })
    }
    if (want.version && !sameVersion(want.version, actual.version)) {
      versions.push({
        name: want.name,
        desired: want.version,
        installed: actual.version ?? null,
        kind: 'installed-vs-desired',
      })
    }
  }

  const entryChanges = []
  const readonly = []
  for (const want of desired.entries) {
    const actual = pluginByEntry.get(want.entryId)
    if (!actual) {
      missing.push({ name: want.entryId, reason: '当前 runtime 里没有这个 entry（bundle 未启用或 id 写错）' })
      continue
    }
    if (actual.readOnlyReason) {
      readonly.push({ entryId: want.entryId, reason: actual.readOnlyReason })
      continue
    }
    if (want.enabled !== Boolean(actual.enabled)) {
      entryChanges.push({
        op: 'entry',
        entryId: want.entryId,
        enabled: want.enabled,
        current: Boolean(actual.enabled),
      })
    }
  }

  return {
    bundles: bundleChanges,
    entries: entryChanges,
    missing,
    readonly,
    versions,
    changed: bundleChanges.length + entryChanges.length > 0,
  }
}

/** 让 diff 能直接当"待执行变更列表"用。 */
export function changesOf(diff) {
  return [
    ...diff.bundles.map((c) => ({ op: c.op, name: c.name, enabled: c.enabled })),
    ...diff.entries.map((c) => ({ op: c.op, entryId: c.entryId, enabled: c.enabled })),
  ]
}

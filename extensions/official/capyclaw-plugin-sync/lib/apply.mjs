/**
 * 把变更翻译成 dsh 原生调用。
 *
 * 这里**不自己实现开关**：
 *   bundle 级 → ctx.pluginManager.setBundleEnabled(name, enabled)
 *   entry  级 → ctx.pluginManager.setPluginEnabled(entryId, enabled)
 *
 * dsh 返回的 application 字段原样透传：
 *   applied            已热应用
 *   restart-required   需要重启才生效（没有 HMR）
 *   overridden         被更高优先级的 patch 层覆盖（写成功但不生效）
 *   failed             失败，带 error
 * 不能把 overridden / restart-required 当成成功——调用方要能看见。
 */

export const CHANGE_OPS = ['bundle', 'entry']

export function validateChanges(changes) {
  if (!Array.isArray(changes)) throw new Error('changes 必须是数组')
  return changes.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`changes[${index}] 必须是对象`)
    if (!CHANGE_OPS.includes(item.op)) {
      throw new Error(`changes[${index}].op 必须是 ${CHANGE_OPS.join(' 或 ')}，收到 ${JSON.stringify(item.op)}`)
    }
    if (typeof item.enabled !== 'boolean') {
      throw new Error(`changes[${index}].enabled 必须是布尔值`)
    }
    if (item.op === 'bundle') {
      if (typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error(`changes[${index}] bundle 级变更缺少 name`)
      }
      return { op: 'bundle', name: item.name.trim(), enabled: item.enabled }
    }
    if (typeof item.entryId !== 'string' || !item.entryId.trim()) {
      throw new Error(`changes[${index}] entry 级变更缺少 entryId（用 inventory 里的 entryId，通常 include:<rowId>）`)
    }
    return { op: 'entry', entryId: item.entryId.trim(), enabled: item.enabled }
  })
}

/**
 * @param {object} params
 * @param {Array} params.changes
 * @param {{setBundleEnabled:Function,setPluginEnabled:Function}} params.manager
 * @param {boolean} [params.stopOnFailure] 默认 false：逐项执行并收集结果
 */
export async function applyChanges({ changes, manager, stopOnFailure = false }) {
  const list = validateChanges(changes)
  const results = []

  for (const change of list) {
    const target = change.op === 'bundle' ? change.name : change.entryId
    try {
      const result = change.op === 'bundle'
        ? await manager.setBundleEnabled(change.name, change.enabled)
        : await manager.setPluginEnabled(change.entryId, change.enabled)
      const application = result?.application ?? 'unknown'
      const entry = {
        op: change.op,
        target,
        enabled: change.enabled,
        application,
        changed: result?.changed ?? null,
        warnings: result?.warnings ?? [],
      }
      if (result?.error) entry.error = result.error
      // 只有 applied 才算真的生效；其余如实标记
      entry.ok = application === 'applied'
      results.push(entry)
      if (!entry.ok && stopOnFailure) break
    } catch (error) {
      results.push({
        op: change.op,
        target,
        enabled: change.enabled,
        application: 'threw',
        ok: false,
        error: { code: error.code || 'ERROR', message: error.message },
      })
      if (stopOnFailure) break
    }
  }

  return {
    results,
    ok: results.every((r) => r.ok),
    applied: results.filter((r) => r.application === 'applied').length,
    pending: results.filter((r) => ['restart-required', 'overridden'].includes(r.application)).length,
    failed: results.filter((r) => !r.ok && !['restart-required', 'overridden'].includes(r.application)).length,
  }
}

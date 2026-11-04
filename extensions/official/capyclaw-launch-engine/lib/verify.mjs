/**
 * 激活验证：唯一可信证据是 pluginManager.listPlugins() 的
 * `enabled === true && fiberPhase === 'active'`。
 *
 * GET / 200、doctor 绿灯都不是激活证据（见 ARCHITECTURE.md「运行期插件集合管理」）。
 * 停用验证口径与 e2e 相同：entry 消失或 enabled === false 即已停用。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stateOf(entry, expect) {
  if (expect === 'active') {
    return entry?.enabled === true && entry?.fiberPhase === 'active' ? 'active' : 'pending'
  }
  // inactive：entry 不在清单里（被移出组合）或开关为 false 都算
  return !entry || entry.enabled !== true ? 'inactive' : 'pending'
}

/**
 * 轮询等待一组 entry 到达期望状态。
 *
 * @param {object} params
 * @param {{listPlugins():Promise<Array>}} params.manager dsh 原生 pluginManager
 * @param {string[]} params.entryIds 目标 entryId 列表
 * @param {'active'|'inactive'} [params.expect] 默认 'active'
 * @param {number} [params.timeoutMs] 默认 60000
 * @param {number} [params.pollMs] 默认 500
 * @returns {{ok:boolean, timedOut:boolean, entries:Array}} 到超时为止的最后一次快照
 */
export async function waitForEntries({ manager, entryIds, expect = 'active', timeoutMs = 60000, pollMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  let snapshot = { ok: false, timedOut: true, entries: [] }

  for (;;) {
    let plugins = []
    try { plugins = await manager.listPlugins() } catch { /* 管理器暂不可用按 pending 处理 */ }
    const byId = new Map(plugins.map((p) => [p.entryId, p]))
    const entries = entryIds.map((entryId) => {
      const entry = byId.get(entryId) || null
      return {
        entryId,
        found: Boolean(entry),
        enabled: entry?.enabled ?? null,
        fiberPhase: entry?.fiberPhase ?? null,
        state: stateOf(entry, expect),
      }
    })
    const ok = entries.every((e) => e.state === expect)
    snapshot = { ok, timedOut: false, entries }

    if (ok) return snapshot
    if (Date.now() + pollMs >= deadline) {
      return { ...snapshot, ok: false, timedOut: true }
    }
    await sleep(pollMs)
  }
}

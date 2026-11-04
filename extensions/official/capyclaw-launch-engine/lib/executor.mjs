/**
 * 执行器：把计划落成动作——全部转发，不自己实现任何开关。
 *
 *   bundle / entry 开关 → ctx.pluginSync.apply（内部转发 dsh 原生 pluginManager）
 *   服务进程           → 激活 serviceBroker.start / 停用 serviceBroker.stop
 *                        （broker 统一编排；本栈没有 broker 宿主插件时
 *                        诚实报 unavailable，不假装成功）
 *   激活证据           → waitForEntries（fiberPhase === 'active' 口径）
 *
 * 逐波执行：每波先重读实际状态裁剪掉已满足的开关，再下发、再验证；
 * 验证不过也继续下一波（结果如实汇总，由调用方决定怎么处理）。
 *
 * outcome 优先级：failed > restart-required > degraded > active；
 * verify=false 时不做验证，全绿也只能报 unverified（不冒充激活证据）。
 */
import { filterPending } from './planner.mjs'
import { waitForEntries } from './verify.mjs'

async function readActual(manager) {
  try {
    const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
    return { bundles, plugins }
  } catch {
    return null // 读不到实际状态：不裁剪，让 apply 诚实报错
  }
}

/**
 * @param {object} params
 * @param {object} params.plan planner 产出的计划（waves / expect / intent）
 * @param {{apply(changes:object):Promise<object>}} params.pluginSync plugin-sync ctx 服务
 * @param {() => object|null} params.getBroker 惰性取 ctx.serviceBroker（可能不存在）
 * @param {{listPlugins():Promise<Array>,listBundles():Promise<Array>}} params.manager
 * @param {object} [params.options] verify / verifyTimeoutMs / pollMs / force
 */
export async function executePlan({ plan, pluginSync, getBroker, manager }, {
  verify = true, verifyTimeoutMs = 60000, pollMs = 500, force = false,
} = {}) {
  const waves = []
  let anyFailed = false
  let anyPending = false
  let anyDegraded = false

  for (const wave of plan.waves) {
    const actual = await readActual(manager)
    const pending = filterPending(
      { ...plan, waves: [wave] },
      actual,
      { force },
    ).waves[0]

    const changes = []
    if (plan.intent === 'activate') {
      for (const b of pending.bundles) changes.push({ op: 'bundle', name: b.name, enabled: b.enabled })
      for (const e of pending.entries) changes.push({ op: 'entry', entryId: e.entryId, enabled: e.enabled })
    } else {
      for (const e of pending.entries) changes.push({ op: 'entry', entryId: e.entryId, enabled: e.enabled })
      for (const b of pending.bundles) changes.push({ op: 'bundle', name: b.name, enabled: b.enabled })
    }

    let applied
    if (!changes.length) {
      applied = { ok: true, applied: 0, pending: 0, failed: 0, results: [], skipped: true }
    } else {
      try {
        applied = await pluginSync.apply({ changes })
      } catch (error) {
        applied = { ok: false, applied: 0, pending: changes.length, failed: changes.length, results: [], error: { code: error.code || 'APPLY_ERROR', message: error.message } }
      }
    }
    if (applied.failed > 0 || applied.error) anyFailed = true
    if (applied.pending > 0) anyPending = true

    const broker = getBroker()
    const services = []
    for (const spec of wave.services) {
      if (!broker) {
        services.push({ id: spec.id, ok: false, error: '本栈没有 serviceBroker 服务（服务步骤需要 broker 宿主插件）' })
        anyDegraded = true
        continue
      }
      try {
        // 激活投递服务，停用回收服务（broker 幂等：up 复用优先，stop 按 id）
        const result = plan.intent === 'activate'
          ? await broker.start(spec)
          : await broker.stop(spec.id)
        services.push({ id: spec.id, ok: true, result })
      } catch (error) {
        services.push({ id: spec.id, ok: false, error: error.message })
        anyDegraded = true
      }
    }

    let verification = null
    if (verify && wave.entries.length) {
      verification = await waitForEntries({
        manager,
        entryIds: wave.entries.map((e) => e.entryId),
        expect: plan.expect,
        timeoutMs: verifyTimeoutMs,
        pollMs,
      })
      if (!verification.ok) anyDegraded = true
    }

    waves.push({
      capability: wave.capability,
      changes: applied,
      services,
      verification,
    })
  }

  const outcome = anyFailed ? 'failed'
    : anyPending ? 'restart-required'
      : anyDegraded ? 'degraded'
        : verify && plan.expect === 'active' ? 'active'
          : verify ? 'inactive'
            : 'unverified'

  return { ok: outcome === 'active' || outcome === 'inactive', outcome, requirement: plan.requirement, intent: plan.intent, waves }
}

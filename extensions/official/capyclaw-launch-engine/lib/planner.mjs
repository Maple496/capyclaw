/**
 * 计划器（纯函数）：requirement → 有序激活动作。
 *
 * 产出「波（wave）」序列，每波对应一个 capability：
 *   - 依赖闭包里依赖在前（见 registry.resolveClosure）——消费方的
 *     inject: ['x'] 要等服务提供方 active 之后才有意义；
 *   - 跨波去重：bundle / entry / service 首次出现（= 更深依赖处）生效；
 *   - 激活波内先 bundle 后 entry（dsh 实测：开 bundle 即激活其 patch 行，
 *     entry 级开关只兜 profile 行）；停用波内相反：先 entry 后 bundle。
 *
 * 开关目标值：
 *   激活 = 注册表声明值（enabled 缺省 true；声明 false 表示「该能力要求此项关闭」）
 *   停用 = 一律 false（能力下线 = 其声明的所有 bundle/entry 关闭）
 *
 * planner 不读运行时状态；「已经是目标状态就跳过」由 filterPending
 * 按调用方传入的实际快照（pluginManager.listBundles/listPlugins）裁剪。
 */
import { resolveClosure, lookupCapability } from './registry.mjs'

/** capability 闭包 → 激活计划（依赖在前）。 */
export function planActivation(registry, name) {
  return buildPlan(registry, name, 'activate')
}

/** 停用计划：波序倒转（先关依赖方再关依赖）。 */
export function planDeactivation(registry, name) {
  return buildPlan(registry, name, 'deactivate')
}

function buildPlan(registry, name, intent) {
  const activating = intent === 'activate'
  const order = resolveClosure(registry, name)
  const wavesInOrder = activating ? order : [...order].reverse()

  const seenBundles = new Set()
  const seenEntries = new Set()
  const seenServices = new Set()
  const waves = []

  for (const capabilityName of wavesInOrder) {
    const spec = lookupCapability(registry, capabilityName)
    const bundles = spec.bundles
      .filter((b) => !seenBundles.has(b.name) && seenBundles.add(b.name))
      .map((b) => ({ name: b.name, enabled: activating ? b.enabled : false }))
    const entries = spec.entries
      .filter((e) => !seenEntries.has(e.entryId) && seenEntries.add(e.entryId))
      .map((e) => ({ entryId: e.entryId, enabled: activating ? e.enabled : false }))
    const services = spec.services
      .filter((s) => !seenServices.has(s.id) && seenServices.add(s.id))
    waves.push({ capability: capabilityName, bundles, entries, services })
  }

  return { requirement: name, intent, expect: activating ? 'active' : 'inactive', waves }
}

/**
 * 按实际状态裁剪计划：已经处于目标状态的开关不重复下发。
 *
 * - bundle：listBundles 里 enabled === 目标值 → 跳过；找不到 → 保留
 *   （让 pluginManager 诚实报 unknown-plugin，而不是这里静默吞掉）
 * - entry：listPlugins 里 enabled === 目标值 → 跳过；找不到 → 保留（理由同上）
 * - services：不裁剪（broker 的 up 语义幂等、复用优先，见 dsh-service-broker）
 *
 * @param {object} actual { bundles: [{name, enabled}], plugins: [{entryId, enabled}] }
 */
export function filterPending(plan, actual, { force = false } = {}) {
  if (force) return { ...plan, waves: plan.waves.map((wave) => ({ ...wave })) }
  const bundleState = new Map((actual?.bundles || []).map((b) => [b.name, b.enabled === true]))
  const entryState = new Map((actual?.plugins || []).map((p) => [p.entryId, p.enabled === true]))

  const waves = plan.waves.map((wave) => ({
    capability: wave.capability,
    bundles: wave.bundles.filter((b) => bundleState.get(b.name) !== b.enabled),
    entries: wave.entries.filter((e) => entryState.get(e.entryId) !== e.enabled),
    services: [...wave.services],
  }))
  return { ...plan, waves }
}

/** 计划里全部 entryId（验证目标用；含被裁剪掉的——已激活的也应保持激活）。 */
export function verificationTargets(plan) {
  const targets = []
  const seen = new Set()
  for (const wave of plan.waves) {
    for (const entry of wave.entries) {
      if (!seen.has(entry.entryId)) { seen.add(entry.entryId); targets.push(entry.entryId) }
    }
  }
  return targets
}

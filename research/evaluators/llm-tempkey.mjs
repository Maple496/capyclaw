/**
 * dsh-llm-tempkey 评估器：虚拟时钟 + 事件驱动仿真，直接驱动**生产策略纯函数**
 * （extensions/official/dsh-llm-tempkey/lib/rotation-policy.mjs）——仿真即真实行为，
 * 无需起服务、无网络，毫秒级完成，供 NSGA-II 全速搜索。
 *
 * 旧版（mock fetch + 真实 host）存在三处坏点（vclock 模块缺失、host 导出名错、
 * objectives 未定义），从未能运行；本实现以纯策略仿真替代，确定性可复现。
 *
 * 目标（全部最小化）：
 *   stabilityFailures — 稳态下 Key 过期窗口（对话 401）+ 403 恢复超时
 *   issuedKeys        — 24h 签发次数（每次签发真实预扣积分）
 *   heldSeconds       — 积分占用（Σ TTL，预扣时长）
 *   checkCalls        — 周期检查次数（网络 + CPU 开销）
 *   policyViolations  — 401 宽限策略违例（该换不换 / 不该换乱换）
 */
import { decide, effectiveMarginSeconds, shouldForceRefreshOn401 } from '../../extensions/official/dsh-llm-tempkey/lib/rotation-policy.mjs'
import { TUNING_DEFAULTS } from '../../extensions/official/dsh-llm-tempkey/lib/tuning.mjs'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 评估假设：上游 Key 真实传播窗口（秒级浮动的代表值）。 */
const TRUE_PROPAGATION_MS = 60000
/** 请求到达平均间隔（工作负载假设）。 */
const MEAN_REQUEST_GAP_MS = 11000
/** 403 场景：token 失效窗口与恢复观察窗。 */
const SESSION_FAIL_START = 2 * HOUR
const SESSION_FAIL_END = 2 * HOUR + 5 * 60 * 1000
/** 仿真总时长。 */
const HORIZON_MS = DAY
/** 真实时钟抖动：tick 周期在 ±10% 内浮动（调度延迟/GC）。 */
const TICK_JITTER = 0.10
/** 403 恢复相位：token 恢复时刻相对 tick 网格的随机偏移比例。 */
const RECOVERY_PHASE = 0.37

/** 确定性 PRNG（与引擎同源算法，避免跨模块耦合）。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 稳态仿真：tick 周期检查 + 随机请求到达。返回成本与稳定性指标。
 */
function simulateSteady(genome, seed) {
  const rng = mulberry32(seed)
  const ttlMs = genome.ttlSeconds * 1000
  const cfg = { ttlSeconds: genome.ttlSeconds, refreshMarginSeconds: genome.refreshMarginSeconds }
  const tickMs = genome.tickMs

  let now = 0
  let nextTick = 0
  let nextReq = Math.floor(rng() * MEAN_REQUEST_GAP_MS)
  let apiKey = null
  let expiresAt = 0
  let issued = 0
  let checks = 0
  let heldMs = 0
  let gapMs = 0
  let gapEvents = 0
  let inGap = false

  while (now < HORIZON_MS) {
    if (nextTick <= nextReq) {
      now = nextTick
      checks += 1
      const action = decide({ apiKey, expiresAt, now }, now, cfg)
      if (action === 'issue') {
        apiKey = `key-${issued}`
        expiresAt = now + ttlMs
        issued += 1
        heldMs += ttlMs
        inGap = false
      }
      nextTick += Math.round(tickMs * (1 - TICK_JITTER + 2 * TICK_JITTER * rng()))
    } else {
      now = nextReq
      // 指数间隔请求（均值 MEAN_REQUEST_GAP_MS）
      nextReq += Math.max(500, Math.floor(-Math.log(1 - rng()) * MEAN_REQUEST_GAP_MS))
      const keyValid = apiKey !== null && now < expiresAt
      if (!keyValid) {
        gapMs += Math.min(1000, 1000 + Math.max(0, (apiKey ? expiresAt : now) - now))
        if (!inGap) gapEvents += 1
        inGap = true
      } else {
        inGap = false
      }
    }
  }

  return {
    issued,
    heldSeconds: Math.round(heldMs / 1000),
    checks,
    gapMs: Math.round(gapMs),
    gapEvents,
  }
}

/**
 * 403 场景：登录态失效窗口内不得签发、丢弃本地 Key；恢复后 ≤ 2×tick 内重新就绪。
 * 返回恢复延迟（ms）。
 */
function simulateSessionRecovery(genome) {
  const ttlMs = genome.ttlSeconds * 1000
  const cfg = { ttlSeconds: genome.ttlSeconds, refreshMarginSeconds: genome.refreshMarginSeconds }
  let now = 0
  let apiKey = 'seed-key'
  let expiresAt = 0
  let sessionValid = true
  let recoveryAt = null
  let nextTick = 0

  const recoveryPhase = Math.round(genome.tickMs * RECOVERY_PHASE)
  const failEnd = SESSION_FAIL_END + recoveryPhase
  while (now < failEnd + 10 * 60 * 1000) {
    now = nextTick
    nextTick += genome.tickMs

    const inFailWindow = now >= SESSION_FAIL_START && now < failEnd
    if (inFailWindow && sessionValid) {
      sessionValid = false
      apiKey = null // 403 时宿主丢弃 Key 引用
      expiresAt = 0
      recoveryAt = null
    }
    if (!inFailWindow && !sessionValid) {
      sessionValid = true
      // 真实 token 恢复时刻 = 窗口结束（相位偏移后），不必然是 tick 检出时刻
      if (recoveryAt === null) recoveryAt = failEnd
    }
    if (!sessionValid) continue

    if (decide({ apiKey, expiresAt, now }, now, cfg) === 'issue') {
      apiKey = `key-${now}`
      expiresAt = now + ttlMs
      if (recoveryAt !== null) {
        return Math.max(0, now - recoveryAt)
      }
    }
  }
  return Number.POSITIVE_INFINITY
}

/**
 * 401 宽限策略正确性：以真实传播窗口为基准，统计
 *   waste = 传播未完成就强制换新（白花积分）
 *   loss  = 传播已完成仍不换新（持续 401 拒绝）
 */
function evaluate401Policy(genome) {
  const probeAges = Array.from({ length: 24 }, (_, i) => (i + 1) * 5000)
  let waste = 0
  let loss = 0
  for (const age of probeAges) {
    const lastIssueAt = 1_000_000
    const now = lastIssueAt + age
    const force = shouldForceRefreshOn401(lastIssueAt, now, genome.propagationMs)
    if (force && age < TRUE_PROPAGATION_MS) waste += 1
    if (!force && age >= TRUE_PROPAGATION_MS) loss += 1
  }
  return { waste, loss }
}

/**
 * 单个基因组的完整评估。签名与 evolution/run.mjs 的 evaluate(genome, tuningPatch) 对齐。
 */
export async function evaluateLlmTempkey(genome, tuningPatch = {}) {
  const seed = 20261102
  const steady = simulateSteady(genome, seed)
  const recoveryMs = simulateSessionRecovery(genome)
  const policy = evaluate401Policy(genome)

  const recoveryLimit = Math.max(genome.tickMs * 2, 15000)
  const stabilityFailures =
    steady.gapEvents +
    (recoveryMs > recoveryLimit ? 1 : 0)
  const policyViolations = policy.waste + policy.loss

  return {
    ok: stabilityFailures === 0 && policyViolations === 0,
    objectives: {
      stabilityFailures,
      issuedKeys: steady.issued,
      heldSeconds: steady.heldSeconds,
      checkCalls: steady.checks,
      policyViolations,
    },
    // 明细（不参与权重，供报告）
    meta: {
      gapMs: steady.gapMs,
      recoveryMs,
      propagationWaste: policy.waste,
      propagationLoss: policy.loss,
      tuningPatch,
      defaults: { ...TUNING_DEFAULTS },
    },
  }
}

export default evaluateLlmTempkey

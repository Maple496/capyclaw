/**
 * 临时 Key 轮换策略（纯函数，无 IO）。
 *
 * 为什么单独成模块：轮换决策此前埋在 host.mjs 的 ensureKey 里，评估器无法
 * 直接驱动真实策略。抽成纯函数后：
 *   - host 与进化评估器共用同一套决策（仿真即真实行为）；
 *   - 参数（ttl/margin/propagation/tick）可被 NSGA-II 高速评估，无需起服务。
 *
 * 决策规则（与 host.mjs 现行为逐条等价）：
 *   1. 无 Key / Key 已过期 / 进入轮换窗口（距到期 ≤ margin）→ issue
 *   2. 否则 reuse
 *   3. 上游 401：Key 年龄 < propagationMs → 宽限内不强制换新（诚实回 401）；
 *      超过宽限 → 强制换新重试
 */

/** 生效 margin：服务端 TTL 下限 300s；margin 不得超过 TTL/2（避免轮换过密）。 */
export function effectiveMarginSeconds(ttlSeconds, marginSeconds) {
  const ttl = Number(ttlSeconds) || 300
  const margin = Number(marginSeconds) || 0
  return Math.min(Math.max(0, margin), Math.floor(ttl / 2))
}

/**
 * 周期检查时的动作判定。
 * @param {{ apiKey: string|null, expiresAt: number, now: number }} state
 *   expiresAt 为毫秒时间戳；now 为毫秒时间戳
 * @param {{ ttlSeconds: number, refreshMarginSeconds: number }} cfg
 * @returns { 'issue' | 'reuse' }
 */
export function decide(state, now, cfg) {
  if (!state.apiKey) return 'issue'
  if (now >= state.expiresAt) return 'issue'
  const marginMs = effectiveMarginSeconds(cfg.ttlSeconds, cfg.refreshMarginSeconds) * 1000
  if (state.expiresAt - now <= marginMs) return 'issue'
  return 'reuse'
}

/**
 * 上游 401 时的强制换新判定。
 * @param {number} lastIssueAt - 最近签发时间（ms）；0/缺省视为很久以前
 * @param {number} now - 当前时间（ms）
 * @param {number} propagationMs - 签发传播宽限（ms）
 * @returns { boolean } true = 强制换新重试；false = 宽限内诚实回 401
 */
export function shouldForceRefreshOn401(lastIssueAt, now, propagationMs) {
  if (!lastIssueAt) return true
  return now - lastIssueAt >= propagationMs
}

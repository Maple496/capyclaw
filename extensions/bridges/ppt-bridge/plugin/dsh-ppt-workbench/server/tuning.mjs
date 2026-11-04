/**
 * 运行时调优参数（单一真源，构建时复制到 server/tuning.mjs）。
 *
 * 这些值不是拍脑袋的常量：由 bench/evolution 的 NSGA-II 进化搜索在
 * 延迟 / 吞吐 / 空闲 CPU / 稳定性四个目标上跑出的 Pareto 解固化而来。
 * 生产可以通过 PPT_TUNING_JSON 环境变量覆盖（见 applyTuningFromEnv）。
 *
 * 注意：本模块同时被 src/mcp 与构建后的 server/ 使用，禁止依赖插件内其它模块。
 */

export const DEFAULT_TUNING = Object.freeze({
  /* 编辑器长轮询：越小延迟越低，越大空闲 CPU 越低。
   * 进化搜索的膝点解：75ms 只比 50ms 多 ~5ms 更新延迟，但轮询唤醒减少 35%。 */
  watchPollMs: 75,
  watchTimeoutSec: 20,
  watchTimeoutMaxSec: 30,

  /* MCP 客户端等待回执的节奏。 */
  statusPollMs: 100,
  pushBaseDeadlineMs: 12000,
  pushPerOpMs: 50,

  /* HTTP 宿主超时。 */
  httpRequestTimeoutMs: 30000,
  httpHeadersTimeoutMs: 10000,
  httpKeepAliveTimeoutMs: 5000,

  /* 状态持久化。 */
  journalMaxBytes: 2 * 1024 * 1024,
  stateCompact: true,

  /* 请求体与 MCP 批量上限。 */
  bodyLimitBytes: 10 * 1024 * 1024,
  mcpBatchLimit: 100,
})

const NUMERIC_KEYS = new Set([
  'watchPollMs', 'watchTimeoutSec', 'watchTimeoutMaxSec', 'statusPollMs',
  'pushBaseDeadlineMs', 'pushPerOpMs', 'httpRequestTimeoutMs', 'httpHeadersTimeoutMs',
  'httpKeepAliveTimeoutMs', 'journalMaxBytes', 'bodyLimitBytes', 'mcpBatchLimit',
])

let current = { ...DEFAULT_TUNING }

function sanitize(patch) {
  const next = {}
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_TUNING)) continue
    if (key === 'stateCompact') {
      if (typeof raw === 'boolean') next[key] = raw
      continue
    }
    if (!NUMERIC_KEYS.has(key)) continue
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) next[key] = value
  }
  return next
}

export function getTuning() {
  return current
}

/** 仅供测试/进化搜索使用：设置当前进程内的调优参数。 */
export function setTuning(patch) {
  current = { ...current, ...sanitize(patch) }
  return current
}

export function resetTuning() {
  current = { ...DEFAULT_TUNING }
  return current
}

/** 生产覆盖：PPT_TUNING_JSON='{"watchPollMs":100}'。非法值静默忽略。 */
export function applyTuningFromEnv(env = process.env) {
  const raw = env && env.PPT_TUNING_JSON
  if (!raw) return current
  try {
    return setTuning(JSON.parse(raw))
  } catch {
    return current
  }
}

applyTuningFromEnv()

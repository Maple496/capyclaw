/**
 * dsh-service-host 运行时调优层。
 *
 * 默认值与进化搜索（evolution/ NSGA-II）的 founder 基线保持一致；
 * 生产环境可用 DSH_TUNING_JSON 覆盖（按包名分组），测试/评估用 setTuning 注入。
 */

const DEFAULTS = {
  /* 端口被占时向后顺延扫描的次数上限（非 strictPort） */
  portScanLimit: 50,
  /* 复用既有实例的 /healthz 探测超时
   * 200ms 由进化搜索固化（evolution/，2026-11-01）：黑洞端口启动阻塞 425→227ms；
   * 健康实例 RTT 1-3ms，仍有 60 倍以上余量。 */
  reuseProbeTimeoutMs: 200,
  /* 单实例锁：空/坏锁视为残留前的宽限 */
  lockFreshGraceMs: 2000,
  /* 优雅关闭：先等 N ms 再断开全部连接 */
  closeGraceMs: 50,
  /* 优雅关闭：强制完成的兜底时限 */
  closeForceMs: 1000,
}

let overrides = {}
let envLoaded = false

function loadEnv() {
  if (envLoaded) return
  envLoaded = true
  try {
    const raw = process.env.DSH_TUNING_JSON
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    const own = parsed['dsh-service-host'] && typeof parsed['dsh-service-host'] === 'object'
      ? parsed['dsh-service-host']
      : parsed
    for (const key of Object.keys(DEFAULTS)) {
      if (own[key] !== undefined) overrides[key] = own[key]
    }
  } catch { /* 非法 JSON 静默忽略：调优失败不能阻塞启动 */ }
}

/** 当前生效参数（默认值 + env + setTuning 覆盖）。 */
export function tuning() {
  loadEnv()
  return { ...DEFAULTS, ...overrides }
}

/** 测试/评估注入。只接受已知键，避免拼写错误静默生效。 */
export function setTuning(patch = {}) {
  loadEnv()
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULTS) overrides[key] = value
  }
}

/** 恢复到默认值 + env 覆盖。 */
export function resetTuning() {
  overrides = {}
  envLoaded = false
}

export const TUNING_DEFAULTS = { ...DEFAULTS }

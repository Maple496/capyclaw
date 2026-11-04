/**
 * dsh-suite-kit 运行时调优层。
 *
 * 默认值与进化搜索（evolution/ NSGA-II）的 founder 基线保持一致；
 * 生产环境可用 DSH_TUNING_JSON 覆盖（按包名分组），测试/评估用 setTuning 注入。
 */

const DEFAULTS = {
  /* 端口分配：preferred 被占时向后扫描的数量 */
  portScanRange: 200,
  /* startRuntime 就绪轮询步长（300ms 由进化搜索固化：就绪检测 1948→1644ms） */
  readyPollMs: 300,
  /* 就绪探测：HTTP 健康检查超时 */
  probeHttpTimeoutMs: 1000,
  /* 就绪探测：TCP 端口连通判定超时 */
  canConnectTimeoutMs: 500,
  /* stopRuntime 等进程退出的轮询步长（次数固定 20） */
  stopPollMs: 100,
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
    const own = parsed['dsh-suite-kit'] && typeof parsed['dsh-suite-kit'] === 'object'
      ? parsed['dsh-suite-kit']
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

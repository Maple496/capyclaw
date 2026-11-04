/**
 * dsh-plugin-kit 运行时调优层。
 *
 * 默认值与进化搜索（evolution/ NSGA-II）的 founder 基线保持一致；
 * 生产环境可用 DSH_TUNING_JSON 覆盖（按包名分组），测试/评估用 setTuning 注入。
 *
 * DSH_TUNING_JSON 形如：
 *   {"dsh-plugin-kit": {"fileLockPollMs": 25, "journalMaxBytes": 2097152}}
 */

const DEFAULTS = {
  /* fs-lock：元数据文件锁
   * pollMs=10 由 NSGA-II 进化搜索固化（evolution/，2026-11-01）：
   * 24 路竞争延迟 2202→1400ms；10ms 为延迟与轮询 IO 的膝点。 */
  fileLockSyncTimeoutMs: 10000,
  fileLockSyncStaleMs: 30000,
  fileLockAsyncTimeoutMs: 30000,
  fileLockPollMs: 10,
  fileLockFreshGraceMs: 2000,

  /* 编辑器租约：wait() 轮询节奏 */
  leaseWaitPollMs: 200,
  leaseWaitTimeoutMs: 4000,

  /* JournalStore：journal 轮转阈值与尾读默认行数
   * 512KB 由进化搜索固化：尾读 p95 4.3→1.9ms、磁盘 -70%、追加吞吐 +8%。 */
  journalMaxBytes: 512 * 1024,
  journalTailLimit: 8,

  /* WorkspaceManager catalog 写节流（降低全局 catalog 锁竞争） */
  catalogThrottleMs: 5000,

  /* WorkspaceClient token 校验缓存 */
  tokenVerifyCacheMs: 30000,

  /* HTTP 服务三级超时（keepAliveTimeoutMs 必须小于 headersTimeoutMs） */
  requestTimeoutMs: 30000,
  headersTimeoutMs: 10000,
  keepAliveTimeoutMs: 5000,
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
    const own = parsed['dsh-plugin-kit'] && typeof parsed['dsh-plugin-kit'] === 'object'
      ? parsed['dsh-plugin-kit']
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

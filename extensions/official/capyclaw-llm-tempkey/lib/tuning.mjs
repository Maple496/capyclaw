/**
 * dsh-llm-tempkey 运行时调优层。
 *
 * 默认值与进化搜索（evolution/ NSGA-II）的 founder 基线保持一致；
 * 评估器用 setTuning 注入基因组，生产环境可用 DSH_TUNING_JSON 覆盖
 * （按包名分组），config（cordis.patch.yml 的行 config）始终最高优先。
 */

const DEFAULTS = {
  /* 以下四项由 NSGA-II 进化搜索固化（evolution/，2026-11-02，seed 2026）：
   * 平衡解 ttl=2820 margin=555 tick=90s prop=60s；
   * 相对旧基线（300/60/30s/60s）：24h 签发 340→38（-89%）、检查 2879→960（-67%）、
   * 稳定性违例 0→0。margin≈6×tick 覆盖时钟抖动；prop 精确命中 60s 传播窗口。
   * 注意：单笔预扣 = TTL×费率，大 TTL 需用户余额足够（300–3600 为服务端范围）。 */
  tickMs: 90000,
  ttlSeconds: 2820,
  refreshMarginSeconds: 555,
  /* 上游 401 宽限：Key 刚签发多久内不强制换新（千帆传播窗口，进化确认 60s） */
  propagationMs: 60000,
  /* 中转上游请求超时 */
  upstreamTimeoutMs: 120000,
  /* 中转重启退避步长（上游连续失败时 listen 循环用） */
  relayRetryMs: 500,
  /* 签发失败后的退避基数（指数：base × 2^failures，封顶 5min） */
  issueBackoffBaseMs: 2000,
  /* 签发失败退避封顶 */
  issueBackoffMaxMs: 300000,
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
    if (parsed && typeof parsed === 'object' && parsed['dsh-llm-tempkey']) {
      for (const [key, value] of Object.entries(parsed['dsh-llm-tempkey'])) {
        if (key in DEFAULTS) overrides[key] = value
      }
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

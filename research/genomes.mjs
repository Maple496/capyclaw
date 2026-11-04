/**
 * 基础设施组件基因组：只包含真实参与运行时决策、且能通过真实基准区分的参数。
 *
 * 约定：
 *   - founder = 当前生产默认值（进化必须证明自己优于现状才能入选）；
 *   - 安全/策略不变式不进搜索空间（如 MCP body 上限、上传上限、stateCompact、
 *     编辑器心跳 TTL 耦合关系、租约 TTL 与编辑器心跳 worker 的 4s 节奏）；
 *   - 每个基因组附带 pickBalanced 权重（stabilityFailures 永远最高）。
 */

export const PLUGIN_KIT_WEIGHTS = {
  stabilityFailures: 10.0,
  contentionMs: 1.5,
  storageMs: 1.2,
  metaLatencyMs: 1.0,
  catalogCost: 0.8,
  storageBytes: 0.5,
  connections: 0.4,
}

export const pluginKitGenome = [
  { name: 'fsLockSyncTimeoutMs', type: 'int', min: 2000, max: 30000, step: 1000, founder: 10000 },
  { name: 'fsLockStaleMs', type: 'int', min: 5000, max: 60000, step: 5000, founder: 30000 },
  { name: 'fsLockPollMs', type: 'int', min: 5, max: 100, step: 5, founder: 25 },
  { name: 'journalMaxKB', type: 'enum', values: [256, 512, 1024, 2048, 4096, 8192], founder: 2048 },
  { name: 'journalTailLimit', type: 'int', min: 4, max: 64, step: 4, founder: 8 },
  { name: 'catalogThrottleMs', type: 'int', min: 1000, max: 30000, step: 1000, founder: 5000 },
  { name: 'keepAliveTimeoutMs', type: 'int', min: 1000, max: 15000, step: 500, founder: 5000 },
]

/** genome → plugin-kit tuning patch。 */
export function pluginKitTuning(genome) {
  return {
    fileLockSyncTimeoutMs: genome.fsLockSyncTimeoutMs,
    fileLockSyncStaleMs: genome.fsLockStaleMs,
    fileLockPollMs: genome.fsLockPollMs,
    journalMaxBytes: genome.journalMaxKB * 1024,
    journalTailLimit: genome.journalTailLimit,
    catalogThrottleMs: genome.catalogThrottleMs,
    keepAliveTimeoutMs: genome.keepAliveTimeoutMs,
  }
}

export const SUITE_KIT_WEIGHTS = {
  stabilityFailures: 10.0,
  readyDetectMs: 1.5,
  allocMs: 1.0,
  stopDetectMs: 0.5,
  probeCount: 0.3,
}

export const suiteKitGenome = [
  { name: 'portScanRange', type: 'int', min: 20, max: 500, step: 20, founder: 200 },
  { name: 'readyPollMs', type: 'int', min: 100, max: 2000, step: 100, founder: 500 },
  { name: 'probeHttpTimeoutMs', type: 'int', min: 200, max: 5000, step: 200, founder: 1000 },
  { name: 'canConnectTimeoutMs', type: 'int', min: 100, max: 3000, step: 100, founder: 500 },
  { name: 'stopPollMs', type: 'int', min: 25, max: 500, step: 25, founder: 100 },
]

export function suiteKitTuning(genome) {
  return {
    portScanRange: genome.portScanRange,
    readyPollMs: genome.readyPollMs,
    probeHttpTimeoutMs: genome.probeHttpTimeoutMs,
    canConnectTimeoutMs: genome.canConnectTimeoutMs,
    stopPollMs: genome.stopPollMs,
  }
}

export const SERVICE_HOST_WEIGHTS = {
  stabilityFailures: 10.0,
  startScanMs: 1.2,
  startBlackholeMs: 0.8,
  closeLatencyMs: 0.6,
  rps: 0.4,
}

export const serviceHostGenome = [
  { name: 'portScanLimit', type: 'int', min: 5, max: 200, step: 5, founder: 50 },
  { name: 'reuseProbeTimeoutMs', type: 'int', min: 100, max: 2000, step: 100, founder: 400 },
  { name: 'lockFreshGraceMs', type: 'int', min: 500, max: 5000, step: 250, founder: 2000 },
  { name: 'closeGraceMs', type: 'int', min: 10, max: 500, step: 10, founder: 50 },
]

export function serviceHostTuning(genome) {
  return {
    portScanLimit: genome.portScanLimit,
    reuseProbeTimeoutMs: genome.reuseProbeTimeoutMs,
    lockFreshGraceMs: genome.lockFreshGraceMs,
    closeGraceMs: genome.closeGraceMs,
  }
}

export const STATE_SERVICE_WEIGHTS = {
  recoveryFailures: 10.0,
  appendOpsPerSec: 1.5,
  stateWriteMs: 1.0,
  tailP95Ms: 0.8,
  journalBytes: 0.4,
}

export const stateServiceGenome = [
  { name: 'journalMaxKB', type: 'enum', values: [256, 512, 1024, 2048, 4096, 8192], founder: 2048 },
  { name: 'journalTailLimit', type: 'int', min: 4, max: 64, step: 4, founder: 8 },
]

export const MCP_GATEWAY_WEIGHTS = {
  stabilityFailures: 10.0,
  fastCallP95Ms: 1.5,
  listRefreshMs: 1.0,
  hungAbortMs: 0.8,
}

export const mcpGatewayGenome = [
  { name: 'upstreamTimeoutMs', type: 'int', min: 3000, max: 30000, step: 1000, founder: 15000 },
]

/* ---------------------------------------------------------------------------
 * llm-tempkey：Key 轮换策略（纯函数仿真驱动）
 * 目标：稳定性 gate（Key 过期窗口/403 恢复）优先；成本项 = 签发次数/积分占用/检查次数；
 * 401 宽限正确性为安全不变式（权重最高）。
 * ------------------------------------------------------------------------- */
export const LLM_TEMPKEY_WEIGHTS = {
  stabilityFailures: 10.0,
  policyViolations: 10.0,
  issuedKeys: 1.2,
  heldSeconds: 0.8,
  checkCalls: 0.4,
}

export const llmTempkeyGenome = [
  { name: 'ttlSeconds', type: 'int', min: 300, max: 3600, step: 60, founder: 300 },
  { name: 'refreshMarginSeconds', type: 'int', min: 15, max: 600, step: 15, founder: 60 },
  { name: 'tickMs', type: 'int', min: 5000, max: 120000, step: 5000, founder: 30000 },
  { name: 'propagationMs', type: 'int', min: 5000, max: 120000, step: 5000, founder: 60000 },
]

/** genome → llm-tempkey tuning patch（margin 由策略层 clamp ≤ ttl/2）。 */
export function llmTempkeyTuning(genome) {
  return {
    ttlSeconds: genome.ttlSeconds,
    refreshMarginSeconds: genome.refreshMarginSeconds,
    tickMs: genome.tickMs,
    propagationMs: genome.propagationMs,
  }
}

export const COMPONENTS = {
  'plugin-kit': {
    genome: pluginKitGenome,
    weights: PLUGIN_KIT_WEIGHTS,
    tuning: pluginKitTuning,
    population: 12,
    generations: 6,
  },
  'suite-kit': {
    genome: suiteKitGenome,
    weights: SUITE_KIT_WEIGHTS,
    tuning: suiteKitTuning,
    population: 12,
    generations: 6,
  },
  'service-host': {
    genome: serviceHostGenome,
    weights: SERVICE_HOST_WEIGHTS,
    tuning: serviceHostTuning,
    population: 12,
    generations: 6,
  },
  'state-service': {
    genome: stateServiceGenome,
    weights: STATE_SERVICE_WEIGHTS,
    tuning: (genome) => ({ journalMaxBytes: genome.journalMaxKB * 1024, journalTailLimit: genome.journalTailLimit }),
    population: 10,
    generations: 4,
  },
  'mcp-gateway': {
    genome: mcpGatewayGenome,
    weights: MCP_GATEWAY_WEIGHTS,
    tuning: (genome) => ({ timeoutMs: genome.upstreamTimeoutMs }),
    population: 10,
    generations: 4,
  },
  'llm-tempkey': {
    genome: llmTempkeyGenome,
    weights: LLM_TEMPKEY_WEIGHTS,
    tuning: llmTempkeyTuning,
    population: 14,
    generations: 8,
  },
}

// ===== dsh 插件（extensions/official/）=====

export const PORT_SIDEBAR_WEIGHTS = {
  stabilityFailures: 10.0,
  wastedOpens: 2.0,
  timeToPresentP95: 1.2,
  reviveMsAvg: 0.8,
  tickCount: 0.3,
}

export const portSidebarGenome = [
  { name: 'retry2Ms', type: 'int', min: 50, max: 500, step: 50, founder: 200 },
  { name: 'retry3Ms', type: 'int', min: 300, max: 2000, step: 100, founder: 1000 },
  { name: 'checkIntervalMs', type: 'int', min: 100, max: 1000, step: 50, founder: 300 },
  { name: 'pendingOpenMs', type: 'int', min: 300, max: 3000, step: 100, founder: 800 },
  { name: 'reviveCooldownMs', type: 'int', min: 100, max: 1500, step: 50, founder: 400 },
  { name: 'maxFailuresPerSession', type: 'int', min: 3, max: 10, step: 1, founder: 5 },
  { name: 'collapseGate', type: 'bool', founder: true },
]

export function portSidebarTuning(genome) {
  return {
    retry2Ms: genome.retry2Ms,
    retry3Ms: genome.retry3Ms,
    checkIntervalMs: genome.checkIntervalMs,
    pendingOpenMs: genome.pendingOpenMs,
    reviveCooldownMs: genome.reviveCooldownMs,
    maxFailuresPerSession: genome.maxFailuresPerSession,
    collapseGate: genome.collapseGate,
  }
}

// 注册到组件表（追加，不影响既有条目）
COMPONENTS['port-sidebar'] = {
  genome: portSidebarGenome,
  weights: PORT_SIDEBAR_WEIGHTS,
  tuning: portSidebarTuning,
  population: 8,
  generations: 4,
}

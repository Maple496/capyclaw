/**
 * PPT 编辑链路基因组（多轮进化：宽搜 → 窄搜 → 确认）。
 *
 * editing：编辑指令闭环（push → ppt-shim op 引擎 → store 持久化 → watch 更新）。
 *   覆盖 relay 节奏参数 + journal 阈值；op 引擎本身无数值参数，
 *   以真实混合 op 负载（set-text/fill-slot/add-element/add-slide/…）测量其吞吐。
 *   浏览器侧编辑器节奏（stateDebounceMs 等）需要浏览器在环，不在本轮搜索域。
 *
 * audit：审计阈值（效果维度）。真相 = 生成器↔审计器一致性：
 *   buildDeck 生成的合规稿必须 0 error；注入的几何损坏必须被检出。
 */

export const EDITING_WEIGHTS = {
  stabilityFailures: 10.0,
  opsApplyMsPerBatch: 1.5,
  pushP95Ms: 1.2,
  watchLatencyMs: 1.2,
  watchWakeupsPerSec: 0.8,
  journalBytes: 0.4,
}

export const editingGenome = [
  { name: 'watchPollMs', type: 'int', min: 25, max: 250, step: 25, founder: 75 },
  { name: 'statusPollMs', type: 'int', min: 50, max: 300, step: 50, founder: 100 },
  { name: 'pushBaseDeadlineMs', type: 'int', min: 6000, max: 20000, step: 2000, founder: 12000 },
  { name: 'pushPerOpMs', type: 'int', min: 0, max: 200, step: 20, founder: 50 },
  { name: 'watchTimeoutSec', type: 'int', min: 10, max: 25, step: 5, founder: 20 },
  { name: 'httpKeepAliveTimeoutMs', type: 'int', min: 1000, max: 10000, step: 1000, founder: 5000 },
  { name: 'journalMaxKB', type: 'enum', values: [256, 512, 1024, 2048, 4096, 8192], founder: 2048 },
]

export function editingTuning(genome) {
  return {
    watchPollMs: genome.watchPollMs,
    watchTimeoutSec: genome.watchTimeoutSec,
    statusPollMs: genome.statusPollMs,
    pushBaseDeadlineMs: genome.pushBaseDeadlineMs,
    pushPerOpMs: genome.pushPerOpMs,
    httpKeepAliveTimeoutMs: genome.httpKeepAliveTimeoutMs,
    journalMaxBytes: genome.journalMaxKB * 1024,
    /* 压缩是安全修复，不允许被性能搜索关掉。 */
    stateCompact: true,
  }
}

export const AUDIT_WEIGHTS = {
  robustnessViolations: 10.0,
  missedDetections: 8.0,
  falseBlocks: 8.0,
  falseWarnings: 1.5,
  auditMsPerDeck: 1.0,
}

export const auditGenome = [
  { name: 'overflowWarnK', type: 'enum', values: [0.9, 1.0, 1.05, 1.1, 1.2, 1.3, 1.4, 1.5], founder: 1.2 },
  { name: 'overflowErrK', type: 'enum', values: [1.3, 1.4, 1.5, 1.6, 1.75, 1.9, 2.1], founder: 1.5 },
  { name: 'overlapMin', type: 'enum', values: [0.05, 0.1, 0.15, 0.2, 0.25, 0.35], founder: 0.15 },
  { name: 'overlapErr', type: 'enum', values: [0.2, 0.25, 0.3, 0.35, 0.4, 0.55], founder: 0.3 },
  { name: 'neutralDiff', type: 'enum', values: [10, 15, 20, 25, 30, 45], founder: 20 },
]

/** genome → globalThis.PPT_AUDIT_TUNING 注入对象。 */
export function auditTuning(genome) {
  return {
    overflowWarnK: genome.overflowWarnK,
    overflowErrK: genome.overflowErrK,
    overlapMin: genome.overlapMin,
    overlapErr: genome.overlapErr,
    neutralDiff: genome.neutralDiff,
  }
}

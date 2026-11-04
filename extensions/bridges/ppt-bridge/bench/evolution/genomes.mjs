/** 模块基因组：只包含真实参与运行时决策、且能通过基准评测区分的参数。 */

export const RELAY_WEIGHTS = {
  /* p95 单次抖动大，权重压低；watch 延迟/唤醒次数是稳定可测的真实权衡。 */
  watchLatencyMs: 2.0,
  watchWakeupsPerSec: 1.5,
  p95StatusMs: 0.3,
  pushP95Ms: 0.3,
  stabilityFailures: 10.0,
  responseBytes: 0.05,
}

export const relayGenome = [
  { name: 'watchPollMs', type: 'int', min: 25, max: 250, step: 25, founder: 75 },
  { name: 'watchTimeoutSec', type: 'int', min: 10, max: 25, step: 5, founder: 20 },
  { name: 'statusPollMs', type: 'int', min: 50, max: 300, step: 50, founder: 100 },
  { name: 'pushBaseDeadlineMs', type: 'int', min: 6000, max: 20000, step: 2000, founder: 12000 },
  { name: 'pushPerOpMs', type: 'int', min: 0, max: 200, step: 20, founder: 50 },
  { name: 'httpKeepAliveTimeoutMs', type: 'int', min: 1000, max: 10000, step: 1000, founder: 5000 },
  { name: 'httpRequestTimeoutMs', type: 'int', min: 15000, max: 60000, step: 5000, founder: 30000 },
  { name: 'bodyLimitBytes', type: 'enum', values: [4, 8, 10, 16], founder: 10 },
]

export const STORE_WEIGHTS = {
  msPerBatch: 1.2,
  stateBytes: 0.8,
  journalBytes: 0.5,
  recoveryFailures: 5.0,
}

export const storeGenome = [
  { name: 'journalMaxBytes', type: 'enum', values: [256, 512, 1024, 2048, 4096, 8192], founder: 2048 },
]

/** genome 值 → tuning patch（bodyLimitBytes 用 MB 存储，落成字节）。 */
export function relayTuning(genome) {
  return {
    watchPollMs: genome.watchPollMs,
    watchTimeoutSec: genome.watchTimeoutSec,
    statusPollMs: genome.statusPollMs,
    pushBaseDeadlineMs: genome.pushBaseDeadlineMs,
    pushPerOpMs: genome.pushPerOpMs,
    httpKeepAliveTimeoutMs: genome.httpKeepAliveTimeoutMs,
    httpRequestTimeoutMs: genome.httpRequestTimeoutMs,
    bodyLimitBytes: genome.bodyLimitBytes * 1024 * 1024,
  }
}

export function storeTuning(genome) {
  return {
    journalMaxBytes: genome.journalMaxBytes * 1024,
    /* 压缩是安全修复，不允许被性能搜索关掉。 */
    stateCompact: true,
  }
}

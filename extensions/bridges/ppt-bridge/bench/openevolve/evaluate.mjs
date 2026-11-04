#!/usr/bin/env node
/** OpenEvolve 候选评估器：接收 Python 侧传来的 JSON tuning，跑真实 relay 基准。 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateRelay } from '../evolution/evaluators.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const raw = process.argv[2] || '{}'
let input
try { input = JSON.parse(raw) } catch (error) {
  console.error('bad tuning json:', error.message)
  process.exit(2)
}

const int = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

const genome = {
  watchPollMs: int(input.watch_poll_ms, 25, 250, 75),
  watchTimeoutSec: int(input.watch_timeout_sec, 10, 25, 20),
  statusPollMs: int(input.status_poll_ms, 50, 300, 100),
  pushBaseDeadlineMs: int(input.push_base_deadline_ms, 6000, 20000, 12000),
  pushPerOpMs: int(input.push_per_op_ms, 0, 200, 50),
  httpKeepAliveTimeoutMs: int(input.http_keep_alive_timeout_ms, 1000, 10000, 5000),
  httpRequestTimeoutMs: int(input.http_request_timeout_ms, 15000, 60000, 30000),
  bodyLimitBytes: int(input.body_limit_mb, 4, 16, 10),
}

const tuning = {
  watchPollMs: genome.watchPollMs,
  watchTimeoutSec: genome.watchTimeoutSec,
  statusPollMs: genome.statusPollMs,
  pushBaseDeadlineMs: genome.pushBaseDeadlineMs,
  pushPerOpMs: genome.pushPerOpMs,
  httpKeepAliveTimeoutMs: genome.httpKeepAliveTimeoutMs,
  httpRequestTimeoutMs: genome.httpRequestTimeoutMs,
  bodyLimitBytes: genome.bodyLimitBytes * 1024 * 1024,
}

try {
  const result = await evaluateRelay(genome, tuning)
  console.log('__AE_RESULT__' + JSON.stringify({ genome, ...result }))
} catch (error) {
  console.log('__AE_RESULT__' + JSON.stringify({ genome, ok: false, error: String(error && error.message || error) }))
  process.exit(1)
}

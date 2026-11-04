#!/usr/bin/env node
/**
 * Service Broker 真实压测
 *
 * 真实度说明：
 *   - 启动仓库里真实的 packages/dsh-service-broker/server.mjs
 *   - 通过它的真实 HTTP 控制端点 /control/start、/control/doctor、/control/stop 驱动
 *   - 每个"服务"都是真实子进程（node -e 起一个 HTTP server）
 *   - 全部子进程与 broker 在结束时被回收
 *
 * 测量项：
 *   1. broker 自身启动耗时
 *   2. 单服务启动到健康可用耗时
 *   3. 并发启动 N 个服务的耗时
 *   4. doctor 健康检查吞吐与 P50/P95 延迟
 *   5. 服务重启成功率（stop -> start 循环）
 *   6. 孤儿进程检查
 *
 * 运行：node tests/performance/broker-stress.mjs
 * 可选：BROKER_STRESS_N=10 node tests/performance/broker-stress.mjs
 */

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const BROKER = path.join(repoRoot, 'packages/dsh-service-broker/server.mjs')

const CONCURRENT = Number(process.env.BROKER_STRESS_N || 8)
// 每次运行使用唯一端口段，避免上次残留进程撞端口
const RUN_SEED = process.env.BROKER_STRESS_SEED
  ? Number(process.env.BROKER_STRESS_SEED)
  : (process.pid % 20)
const PORT_BASE = Number(process.env.BROKER_STRESS_PORT_BASE || (41000 + RUN_SEED * 200))
const BROKER_PORT = PORT_BASE

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : n
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function request(url, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

async function waitHealth(url, deadlineMs) {
  const t0 = performance.now()
  while (performance.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) {
        await r.text()
        return performance.now() - t0
      }
    } catch { /* 还没起来 */ }
    await delay(50)
  }
  return null
}

// 真实服务进程脚本：HTTP server，/healthz 返回带 pid 的 JSON
function serviceCode(port) {
  return `
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({status:'ok', pid: process.pid}));
        return;
      }
      res.writeHead(200); res.end('ok');
    });
    server.listen(${port}, '127.0.0.1');
  `
}

const results = []
const record = (name, ok, data) => {
  results.push({ name, ok, ...data })
  const icon = ok ? '✅' : '❌'
  console.log(`${icon} ${name}: ${JSON.stringify(data)}`)
}

let brokerProc = null
const serviceIds = []
let stateDir = null

/** 兜底：按端口杀掉残留子进程（Windows） */
function killByPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    const line = out.split(/\r?\n/).find((l) =>
      l.includes(`127.0.0.1:${port} `) && l.includes('LISTENING'))
    if (!line) return
    const pid = line.trim().split(/\s+/).pop()
    if (pid && pid !== '0') execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' })
  } catch { /* 已退出 */ }
}

async function main() {
  console.log('='.repeat(74))
  console.log('Service Broker 真实压测')
  console.log('='.repeat(74))
  console.log(`Node        : ${process.version}`)
  console.log(`Broker      : ${path.relative(repoRoot, BROKER)}`)
  console.log(`Broker 端口 : ${BROKER_PORT}`)
  console.log(`并发服务数  : ${CONCURRENT}`)
  console.log('')

  // ── 1. 启动 broker（真实子进程，--stop-on-exit 保证子服务随 broker 回收）
  console.log('【1】启动 broker')
  stateDir = mkdtempSync(path.join(tmpdir(), 'dsh-broker-stress-'))
  const discoveryPath = path.join(stateDir, 'services.json')
  const t0 = performance.now()
  brokerProc = spawn(
    process.execPath,
    [BROKER, '--port', String(BROKER_PORT), '--stop-on-exit', '--discovery', discoveryPath],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_BROKER_PORT: String(BROKER_PORT) },
    },
  )
  let brokerLog = ''
  brokerProc.stdout.on('data', (c) => { brokerLog += c })
  brokerProc.stderr.on('data', (c) => { brokerLog += c })

  const brokerUrl = `http://127.0.0.1:${BROKER_PORT}`
  const brokerUpMs = await waitHealth(`${brokerUrl}/healthz`, 20000)
  if (brokerUpMs === null) {
    console.error('❌ broker 启动失败，日志：')
    console.error(brokerLog.slice(-2000))
    throw new Error('broker did not start')
  }
  const brokerSpawnMs = performance.now() - t0
  record('broker 启动到可用', true, { spawnMs: Math.round(brokerSpawnMs) })
  console.log('')

  // 确认控制端点可用
  const list0 = await request(`${brokerUrl}/control/list`)
  if (list0.status !== 200) throw new Error(`/control/list 异常: ${list0.status}`)

  // ── 2. 单服务启动到健康
  console.log('【2】单服务启动')
  const singlePort = PORT_BASE + 1
  const singleSpec = {
    id: 'stress-single',
    cmd: [process.execPath, '-e', serviceCode(singlePort)],
    ports: { main: singlePort },
    url: `http://127.0.0.1:${singlePort}`,
    healthPath: '/healthz',
    keepAlive: false,
    env: {},
  }
  const t1 = performance.now()
  const startRes = await request(`${brokerUrl}/control/start`, {
    method: 'POST',
    body: { service: singleSpec, waitMs: 8000 },
  })
  const singleMs = performance.now() - t1
  serviceIds.push('stress-single')
  const healthyMs = await waitHealth(`http://127.0.0.1:${singlePort}/healthz`, 8000)

  record('单服务 start→健康', startRes.status === 200 && healthyMs !== null, {
    httpStatus: startRes.status,
    controlMs: Math.round(singleMs),
    healthMs: healthyMs === null ? null : Math.round(healthyMs),
    errors: startRes.data?.errors ?? null,
  })
  console.log('')

  // ── 3. 并发启动
  console.log(`【3】并发启动 ${CONCURRENT} 个服务`)
  const specs = []
  for (let i = 0; i < CONCURRENT; i++) {
    const port = PORT_BASE + 100 + i
    specs.push({
      id: `stress-c-${i}`,
      cmd: [process.execPath, '-e', serviceCode(port)],
      ports: { main: port },
      url: `http://127.0.0.1:${port}`,
      healthPath: '/healthz',
      keepAlive: false,
      env: {},
    })
  }

  const t2 = performance.now()
  const startAll = await Promise.all(specs.map((s) =>
    request(`${brokerUrl}/control/start`, {
      method: 'POST',
      body: { service: s, waitMs: 60000 },
      timeoutMs: 90000,   // 并发 spawn N 个 node 进程在 Windows 上可能很慢，给足时间
    })
  ))
  const concurrentMs = performance.now() - t2
  const okCount = startAll.filter((r) => r.status === 200).length
  for (const s of specs) serviceIds.push(s.id)

  const healthAll = await Promise.all(specs.map((s) =>
    waitHealth(`${s.url}/healthz`, 15000)
  ))
  const healthOk = healthAll.filter((v) => v !== null).length

  record(`${CONCURRENT} 服务并发启动`, okCount === CONCURRENT && healthOk === CONCURRENT, {
    started: okCount,
    healthy: healthOk,
    totalMs: Math.round(concurrentMs),
    avgPerServiceMs: Math.round(concurrentMs / CONCURRENT),
    firstErrors: startAll
      .filter((r) => r.status !== 200)
      .slice(0, 2)
      .flatMap((r) => r.data?.errors || [{ status: r.status }]),
  })
  console.log('')

  // ── 4. doctor 健康检查吞吐
  console.log('【4】doctor 健康检查延迟分布（500 次）')
  const latencies = []
  const DOCTOR_N = 500
  const t3 = performance.now()
  for (let i = 0; i < DOCTOR_N; i++) {
    const t = performance.now()
    await request(`${brokerUrl}/control/doctor?id=stress-single`)
    latencies.push(performance.now() - t)
  }
  const doctorTotal = performance.now() - t3
  const qps = (DOCTOR_N / doctorTotal) * 1000

  record('doctor 健康检查', true, {
    count: DOCTOR_N,
    qps: Math.round(qps),
    p50Ms: +pct(latencies, 50).toFixed(2),
    p95Ms: +pct(latencies, 95).toFixed(2),
    maxMs: +Math.max(...latencies).toFixed(2),
  })
  console.log('')

  // ── 5. 重启可靠性
  console.log('【5】服务重启可靠性（5 轮 stop→start）')
  let restartsOk = 0
  const restartTimes = []
  for (let i = 0; i < 5; i++) {
    await request(`${brokerUrl}/control/stop`, { method: 'POST', body: { id: 'stress-single' } })
    await delay(200)
    const t = performance.now()
    const r = await request(`${brokerUrl}/control/start`, {
      method: 'POST',
      body: { service: singleSpec, waitMs: 8000 },
    })
    const h = await waitHealth(`http://127.0.0.1:${singlePort}/healthz`, 8000)
    if (r.status === 200 && h !== null) {
      restartsOk++
      restartTimes.push(performance.now() - t)
    }
    await delay(100)
  }
  record('重启可靠性', restartsOk === 5, {
    success: `${restartsOk}/5`,
    avgMs: restartTimes.length ? Math.round(restartTimes.reduce((a, b) => a + b, 0) / restartTimes.length) : null,
  })
  console.log('')

  // ── 6. 停止所有服务 + 孤儿检查
  console.log('【6】清理与孤儿进程检查')
  for (const id of serviceIds) {
    try {
      await request(`${brokerUrl}/control/stop`, { method: 'POST', body: { id } })
    } catch { /* 已停 */ }
  }
  await delay(500)

  const listAfter = await request(`${brokerUrl}/control/list`)
  const stillRunning = Array.isArray(listAfter.data)
    ? listAfter.data.filter((s) => s.state === 'running')
    : []

  record('停止后无残留运行中服务', stillRunning.length === 0, {
    remaining: stillRunning.map((s) => s.id),
  })
  console.log('')

  // ── 汇总
  console.log('='.repeat(74))
  console.log('压测汇总')
  console.log('='.repeat(74))
  console.table(results.map((r) => ({
    '项目': r.name,
    '结果': r.ok ? 'PASS' : 'FAIL',
    '详情': JSON.stringify(Object.fromEntries(
      Object.entries(r).filter(([k]) => !['name', 'ok'].includes(k)),
    )),
  })))

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n通过 ${results.length - failed}/${results.length}`)
  console.log('')
  console.log('环境：Node ' + process.version + ' / ' + process.platform + ' ' + process.arch)
  console.log('注意：绝对耗时尚受机器负载影响；并发/QPS 数据用于同机趋势对比，不作跨机阈值。')

  return failed === 0 ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error('❌ 压测异常中止:', err.message)
  exitCode = 1
} finally {
  // 无论成败都要回收 broker
  if (brokerProc && !brokerProc.killed) {
    try { brokerProc.kill('SIGTERM') } catch { /* noop */ }
    await delay(1200)          // 给 --stop-on-exit 时间回收子服务
    try { brokerProc.kill('SIGKILL') } catch { /* noop */ }
  }
  // 兜底：按端口杀掉任何残留（上次超时留下的孤儿）
  const allPorts = [BROKER_PORT, PORT_BASE + 1,
    ...Array.from({ length: CONCURRENT }, (_, i) => PORT_BASE + 100 + i)]
  for (const p of allPorts) killByPort(p)
  if (stateDir) {
    try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* noop */ }
  }
  // 孤儿检查结果
  const leftovers = []
  for (const p of allPorts) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(500) })
      if (r.ok) { await r.text(); leftovers.push(p) }
    } catch { /* 无监听 = 好 */ }
  }
  console.log(`残留端口检查: ${leftovers.length === 0 ? '干净 ✅' : '仍有监听 ' + leftovers.join(',') + ' ❌'}`)
  process.exit(exitCode)
}

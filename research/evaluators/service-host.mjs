/**
 * dsh-service-host 评估器：真实 createServiceApp().listen() 的
 * 端口扫描、复用探测（含黑洞实例）、单实例锁宽限、优雅关闭、吞吐。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import {
  importPkg, tempDir, rmRf, freePort, occupyPort, round2, sleep, httpGet,
} from '../util.mjs'

const { setTuning, resetTuning } = await importPkg('dsh-service-host', 'src/tuning.mjs')
const { createServiceApp } = await importPkg('dsh-service-host', 'src/index.mjs')

const tempSub = () => tempDir('evo-sh-host-')

/** 场景一：首选端口被 6 个真实服务占住 → 必须顺延扫描并成功启动。 */
async function benchScan(portScanLimit) {
  const hostDir = tempSub()
  const holders = []
  try {
    const first = await freePort()
    for (let i = 0; i < 6; i++) holders.push(await occupyPort(first + i))
    const app = createServiceApp({ id: 'evo-scan' })
    const started = performance.now()
    let failures = 0
    try {
      const info = await app.listen({ port: first, hostDir, lockFile: path.join(hostDir, 's.lock') })
      if (!info.port || info.port !== first + 6) failures++
    } catch {
      failures++
    }
    const startMs = performance.now() - started
    await app.close().catch(() => {})
    return { startMs: round2(startMs), failures }
  } finally {
    for (const release of holders) await release().catch(() => {})
    rmRf(hostDir)
  }
}

/** 黑洞服务：接受 TCP 但永不响应 → 复用探测必须超时后放弃复用、成功自启。 */
async function benchBlackhole(reuseProbeTimeoutMs) {
  const hostDir = tempSub()
  let blackhole = null
  try {
    const port = await freePort()
    blackhole = net.createServer()
    blackhole.listen(port, '127.0.0.1') // accept 后不回任何字节
    const app = createServiceApp({ id: 'evo-bh' })
    const started = performance.now()
    let failures = 0
    try {
      const info = await app.listen({ port, hostDir, lockFile: path.join(hostDir, 'b.lock') })
      /* 黑洞不可能是本服务：必须自启新端口，且耗时 ≈ 探测超时 */
      if (info.reused || info.port === port) failures++
    } catch {
      failures++
    }
    const startMs = performance.now() - started
    await app.close().catch(() => {})
    return { startMs: round2(startMs), failures, probeTimeout: reuseProbeTimeoutMs }
  } finally {
    if (blackhole) {
      /* 探测中止后的半开 socket 永不结束：只触发关闭，不等待回调。 */
      try { blackhole.closeAllConnections?.(); blackhole.close(() => {}) } catch { /* 已关闭 */ }
    }
    rmRf(hostDir)
  }
}

/** 真实复用：同 id 实例已就位 → 第二个实例必须探测到并复用（不起新 server）。 */
async function benchReuse() {
  const hostDir = tempSub()
  try {
    const first = await freePort()
    const appA = createServiceApp({ id: 'evo-reuse' })
    const infoA = await appA.listen({ port: first, hostDir, lockFile: path.join(hostDir, 'r.lock') })
    const appB = createServiceApp({ id: 'evo-reuse' })
    const started = performance.now()
    let failures = 0
    try {
      const infoB = await appB.listen({ port: infoA.port, hostDir, lockFile: path.join(hostDir, 'r2.lock') })
      if (!infoB.reused) failures++
    } catch {
      failures++
    }
    const reuseMs = performance.now() - started
    await appB.close().catch(() => {})
    await appA.close().catch(() => {})
    return { reuseMs: round2(reuseMs), failures }
  } finally {
    rmRf(hostDir)
  }
}

/** 锁宽限：空锁文件在宽限内绝不能被抢；超过宽限必须能接管。 */
async function benchLockGrace(lockFreshGraceMs) {
  const hostDir = tempSub()
  try {
    const lockFile = path.join(hostDir, 'grace.lock')
    fs.writeFileSync(lockFile, '') // 空/坏锁
    let failures = 0
    /* 宽限内：必须拒绝启动（acquireLock 返回 null → listen 抛错）。 */
    const app1 = createServiceApp({ id: 'evo-grace' })
    const halfPast = Date.now() - Math.floor(lockFreshGraceMs / 2)
    fs.utimesSync(lockFile, new Date(halfPast), new Date(halfPast))
    try {
      await app1.listen({ port: 0, hostDir, lockFile })
      failures++ // 成功启动 = 误抢别人的初始化中实例
      await app1.close().catch(() => {})
    } catch {
      /* 预期路径：拒绝 */
    }
    /* 超过宽限：必须接管成功，且关闭后锁正确释放（同锁可再次启动）。 */
    const app2 = createServiceApp({ id: 'evo-grace' })
    const longPast = Date.now() - (lockFreshGraceMs + 1500)
    fs.utimesSync(lockFile, new Date(longPast), new Date(longPast))
    try {
      const info = await app2.listen({ port: 0, hostDir, lockFile })
      if (!info.port) failures++
    } catch {
      failures++
    }
    await app2.close().catch(() => {})
    const app3 = createServiceApp({ id: 'evo-grace' })
    try {
      await app3.listen({ port: 0, hostDir, lockFile })
    } catch {
      failures++ // 锁没释放干净
    }
    await app3.close().catch(() => {})
    return { failures }
  } finally {
    rmRf(hostDir)
  }
}

/** 优雅关闭：在途慢请求（150ms）+ 空闲 keep-alive 连接下 close 的耗时。
 * closeGraceMs < 150 → 在途请求被截断、close 提前返回；≥150 → 等请求自然完成。 */
async function benchClose(closeGraceMs) {
  const hostDir = tempSub()
  try {
    const app = createServiceApp({ id: 'evo-close' })
    app.get('/ping', (req, res, u) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return true
    })
    app.get('/slow', (req, res, u) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true,"slow":true}')
        } catch { /* 连接已被关闭截断 */ }
      }, 150)
      return true
    })
    const info = await app.listen({ port: 0, hostDir, lockFile: path.join(hostDir, 'c.lock') })
    const agent = new http.Agent({ keepAlive: true, maxSockets: 3 })
    const ping = () => httpGet(`${info.url}/ping`, agent)
    await Promise.all([ping(), ping(), ping()])
    const slowDone = httpGet(`${info.url}/slow`, agent).then(() => true).catch(() => false)
    const started = performance.now()
    await app.close()
    const closeMs = performance.now() - started
    const requestCompleted = await slowDone
    agent.destroy()
    return { closeMs: round2(closeMs), requestCompleted }
  } finally {
    rmRf(hostDir)
  }
}

/** 吞吐：keep-alive 短请求。 */
async function benchThroughput() {
  const hostDir = tempSub()
  try {
    const app = createServiceApp({ id: 'evo-rps' })
    app.get('/ping', (req, res, u) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return true
    })
    const info = await app.listen({ port: 0, hostDir, lockFile: path.join(hostDir, 't.lock') })
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })
    const ping = () => httpGet(`${info.url}/ping`, agent)
    for (let i = 0; i < 50; i++) await ping() // 预热
    const started = performance.now()
    for (let i = 0; i < 300; i++) await ping()
    const elapsed = (performance.now() - started) / 1000
    agent.destroy()
    await app.close().catch(() => {})
    return { rps: round2(300 / elapsed) }
  } finally {
    rmRf(hostDir)
  }
}

export async function evaluateServiceHost(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)
  const trace = (name, fn) => async () => {
    const started = performance.now()
    try {
      return await fn()
    } finally {
      if (process.env.EVO_DEBUG_RPC) console.log(`[sh] ${name}: ${((performance.now() - started) / 1000).toFixed(2)}s`)
    }
  }

  const scan = await trace('scan', () => benchScan(genome.portScanLimit))()
  const blackhole = await trace('blackhole', () => benchBlackhole(genome.reuseProbeTimeoutMs))()
  const reuse = await trace('reuse', () => benchReuse())()
  const grace = await trace('grace', () => benchLockGrace(genome.lockFreshGraceMs))()
  const close = await trace('close', () => benchClose(genome.closeGraceMs))()
  const throughput = await trace('throughput', () => benchThroughput())()

  const stabilityFailures = scan.failures + blackhole.failures + reuse.failures + grace.failures

  return {
    ok: stabilityFailures === 0,
    objectives: {
      startScanMs: scan.startMs,
      startBlackholeMs: blackhole.startMs,
      closeLatencyMs: close.closeMs,
      rps: -throughput.rps,
      stabilityFailures,
    },
    meta: {
      reuseMs: reuse.reuseMs,
      scanStartMs: scan.startMs,
      blackholeMs: blackhole.startMs,
      closeMs: close.closeMs,
      closeRequestCompleted: close.requestCompleted,
      rps: throughput.rps,
      lockGraceFailures: grace.failures,
    },
  }
}

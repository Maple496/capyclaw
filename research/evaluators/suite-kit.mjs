/**
 * dsh-suite-kit 评估器：真实 allocateRuntimePorts（含端口占用压力）、
 * 真实 startRuntime（stub auth-proxy 模拟延迟就绪）、真实 stopRuntime。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  importPkg, tempDir, rmRf, freePort, occupyPort, round2,
} from '../util.mjs'

const { setTuning, resetTuning } = await importPkg('dsh-suite-kit', 'src/tuning.mjs')
const {
  allocateRuntimePorts, startRuntime, stopRuntime, saveRuntime,
} = await importPkg('dsh-suite-kit', 'src/runtime.mjs')

/** stub auth-proxy：harness 端口 800ms 后可连，content /healthz 每次响应延迟 350ms。 */
const STUB_PROXY = `
import http from 'node:http'
const harnessPort = Number(process.env.DSH_PROXY_PORT)
const contentPort = Number(process.env.DSH_CONTENT_PORT)
const respond = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true,"service":"stub-harness"}')
}
setTimeout(() => {
  http.createServer(respond).listen(harnessPort, '127.0.0.1')
}, 800)
setTimeout(() => {
  http.createServer((req, res) => setTimeout(() => respond(req, res), 350)).listen(contentPort, '127.0.0.1')
}, 1100)
`

function writeStubRuntime(storeRoot, runtimeId, harnessPort, contentPort, harnessDir) {
  const runtimeDir = path.join(storeRoot, 'runtimes', runtimeId)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(path.join(storeRoot, 'locks'), { recursive: true })
  const p = (rel) => path.join(runtimeDir, rel)
  for (const rel of ['workspace', 'logs', 'tmp', 'sessions', 'storages']) fs.mkdirSync(p(rel), { recursive: true })
  fs.writeFileSync(path.join(harnessDir, 'auth-proxy.mjs'), STUB_PROXY)
  const runtime = {
    schemaVersion: 1,
    runtimeId,
    name: runtimeId,
    domain: 'evo',
    profile: 'evo',
    harnessDir,
    storeRoot,
    workId: 'main',
    createdAt: new Date().toISOString(),
    status: 'stopped',
    ports: { harness: harnessPort, dsh: 0, content: contentPort, services: {} },
    paths: {
      root: runtimeDir,
      runtimeFile: p('runtime.json'),
      lockFile: p('auth.lock'),
      dshHome: p('dsh-home'),
      workspace: p('workspace'),
      logs: p('logs'),
      tmp: p('tmp'),
      sessions: p('sessions'),
      storages: p('storages'),
      contentState: p('content-state.json'),
    },
    store: { namespace: 'evo-ns', token: 'evo-token' },
    checks: [{ type: 'http', id: 'content', url: `http://127.0.0.1:${contentPort}/healthz` }],
    env: {},
    pids: { proxy: null },
  }
  saveRuntime(runtime)
  return runtime
}

/** 端口分配：content 首选段前 40 个端口被注册表占用 + 8 个真实绑定，必须扫到空闲段。 */
async function benchAlloc(portScanRange) {
  const storeRoot = tempDir('evo-sk-alloc-')
  const holders = []
  let failures = 0
  try {
    fs.mkdirSync(path.join(storeRoot, 'locks'), { recursive: true })
    const reserved = {}
    const base = 39311
    for (let i = 0; i < 40; i++) reserved[String(base + i)] = 'ghost-runtime'
    fs.writeFileSync(path.join(storeRoot, 'registry.json'), JSON.stringify({
      schemaVersion: 1, updatedAt: '', ports: reserved, runtimes: {},
    }))
    for (let i = 0; i < 8; i++) holders.push(await occupyPort(3100 + i))
    const started = performance.now()
    let result = null
    try {
      result = await allocateRuntimePorts({
        storeRoot,
        runtimeId: 'evo-alloc',
        preferences: { harness: 3100, dsh: 0, content: 39311 },
      })
    } catch {
      failures++
    }
    const allocMs = performance.now() - started
    let scanned = portScanRange + 9
    if (result) {
      const ok = Number.isInteger(result.harness) && Number.isInteger(result.content)
        && result.content > base + 39 && result.harness > 3107
      if (!ok) failures++
      scanned = (result.harness - 3100) + (result.content - base)
    }
    return { allocMs: round2(allocMs), failures, scanned }
  } finally {
    for (const release of holders) await release().catch(() => {})
    rmRf(storeRoot)
  }
}

/** 就绪检测：真实 startRuntime（stub 800ms/1100ms 才监听，/healthz 再延迟 350ms）。 */
async function benchReady() {
  const storeRoot = tempDir('evo-sk-ready-')
  const harnessDir = tempDir('evo-sk-harness-')
  try {
    const harnessPort = await freePort()
    const contentPort = await freePort()
    const runtimeId = 'evo-ready'
    writeStubRuntime(storeRoot, runtimeId, harnessPort, contentPort, harnessDir)
    const started = performance.now()
    const { runtime, ready } = await startRuntime({ storeRoot, runtimeId, waitMs: 15000 })
    const detectMs = performance.now() - started
    const pid = runtime.pids?.proxy
    let stopMs = 0
    if (pid) {
      /* 无论是否就绪都要回收 stub 进程，避免孤儿进程在评估期间累积。 */
      const stopStarted = performance.now()
      await stopRuntime({ storeRoot, runtimeId })
      stopMs = performance.now() - stopStarted
    }
    return { detectMs: round2(detectMs), stopMs: round2(stopMs), ready: !!ready, readyFlag: !!runtime.ready }
  } finally {
    rmRf(storeRoot)
    rmRf(harnessDir)
  }
}

export async function evaluateSuiteKit(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)

  const alloc = await benchAlloc(genome.portScanRange)
  const ready = await benchReady()

  const probeFailures = ready.ready ? 0 : 1
  const stabilityFailures = alloc.failures + probeFailures

  return {
    ok: stabilityFailures === 0,
    objectives: {
      allocMs: alloc.allocMs,
      readyDetectMs: ready.detectMs,
      stopDetectMs: ready.stopMs,
      probeCount: alloc.scanned,
      stabilityFailures,
    },
    meta: {
      allocFailures: alloc.failures,
      ready: ready.ready,
      readyFlag: ready.readyFlag,
      stopMs: ready.stopMs,
      scanned: alloc.scanned,
      scanRange: genome.portScanRange,
    },
  }
}

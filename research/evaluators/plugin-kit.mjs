/**
 * dsh-plugin-kit 评估器：真实文件锁竞争、真实 journal 轮转、真实 catalog 写、
 * 真实租约等待、真实 keep-alive HTTP。目标全部转成最小化。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  importPkg, tempDir, rmRf, percentile, median, sleep, PKG, round2, httpGet,
} from '../util.mjs'

const { setTuning, resetTuning } = await importPkg('dsh-plugin-kit', 'src/tuning.mjs')
const { withFileLock, withAsyncFileLock, readJson } = await importPkg('dsh-plugin-kit', 'src/util/fs-lock.mjs')
const { JournalStore } = await importPkg('dsh-plugin-kit', 'src/store/journal-store.mjs')
const { WorkspaceManager, WorkspaceClient } = await importPkg('dsh-plugin-kit', 'src/workspace/manager.mjs')
const { createEditorLease } = await importPkg('dsh-plugin-kit', 'src/editor/lease.mjs')
const { listen } = await importPkg('dsh-plugin-kit', 'src/service/http.mjs')

const CHILD = fileURLToPath(new URL('./fslock-child.mjs', import.meta.url))
const FS_LOCK_PATH = path.join(PKG('dsh-plugin-kit'), 'src', 'util', 'fs-lock.mjs')

/** 24 路进程内异步锁竞争：延迟 + 互斥正确性。 */
async function benchAsyncContention() {
  const dir = tempDir('evo-pk-lock-')
  const lockFile = path.join(dir, 'contention.lock')
  let active = 0
  let violations = 0
  let failures = 0
  const section = async () => {
    try {
      await withAsyncFileLock(lockFile, async () => {
        active++
        if (active > 1) violations++
        await sleep(3)
        active--
      })
    } catch {
      failures++
    }
  }
  const started = performance.now()
  await Promise.all(Array.from({ length: 24 }, () => section()))
  const wallMs = performance.now() - started
  rmRf(dir)
  return { wallMs: round2(wallMs), violations, failures }
}

/** 跨进程同步锁竞争：4 子进程 × 20 op，共享计数器必须精确等于 80。 */
function benchCrossProcess(envJson) {
  const dir = tempDir('evo-pk-xproc-')
  const lockFile = path.join(dir, 'x.lock')
  const counterFile = path.join(dir, 'counter.json')
  fs.writeFileSync(counterFile, JSON.stringify({ n: 0 }))
  const childEnv = { ...process.env, DSH_TUNING_JSON: envJson }
  const started = performance.now()
  const children = Array.from({ length: 4 }, () => new Promise((resolve) => {
    spawn(process.execPath, [CHILD, lockFile, counterFile, '20', FS_LOCK_PATH], {
      env: childEnv, stdio: 'ignore', windowsHide: true,
    }).on('exit', (code) => resolve(code))
  }))
  return Promise.all(children).then((codes) => {
    const wallMs = performance.now() - started
    const counter = readJson(counterFile, { n: -1 })
    rmRf(dir)
    return { wallMs: round2(wallMs), exitCodes: codes, counter: counter.n }
  })
}

/** journal：400 条 × 4KB 真实追加 + 轮转 + 尾读。 */
function benchJournal(journalMaxBytes, tailLimit) {
  const dir = tempDir('evo-pk-journal-')
  try {
    const store = new JournalStore({ file: path.join(dir, 'state.json'), initialDoc: { seq: 0 } })
    const payload = 'x'.repeat(4000)
    for (let i = 0; i < 30; i++) store.journal({ type: 'warm', i, payload }) // 预热
    const started = performance.now()
    for (let i = 0; i < 400; i++) store.journal({ type: 'push', seq: i, payload })
    const appendMs = performance.now() - started
    let journalBytes = 0
    for (const name of ['journal.jsonl', 'journal.jsonl.1']) {
      try { journalBytes += fs.statSync(path.join(dir, name)).size } catch { /* 无文件 */ }
    }
    const rotated = fs.existsSync(path.join(dir, 'journal.jsonl.1'))
    const tailSamples = []
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      store.journalTail(tailLimit)
      tailSamples.push(performance.now() - t)
    }
    const tail = store.journalTail(tailLimit)
    const reloaded = new JournalStore({ file: path.join(dir, 'state.json'), initialDoc: { seq: 0 } })
    const recoveryOk = reloaded.get().seq === 0 // state 快照未写，重载应回到 initialDoc
    return {
      appendMs: round2(appendMs),
      journalBytes,
      tailP95Ms: round2(percentile(tailSamples, 95)),
      tailLen: tail.length,
      rotated,
      recoveryOk,
    }
  } finally {
    rmRf(dir)
  }
}

/** catalog：120 次 putJson，统计 catalog 落盘次数与最终滞后版本数。 */
function benchCatalog() {
  const dir = tempDir('evo-pk-catalog-')
  try {
    const manager = new WorkspaceManager({ storeRoot: dir }).init()
    const ns = manager.namespaces.create('rt-evo', { ttlSec: 0 })
    const client = new WorkspaceClient({ manager, runtimeId: 'rt-evo', token: ns.token })
    let catalogWrites = 0
    const original = manager.updateCatalog.bind(manager)
    manager.updateCatalog = (manifest) => {
      catalogWrites++
      return original(manifest)
    }
    const blob = Buffer.alloc(4096, 7)
    const started = performance.now()
    for (let i = 0; i < 120; i++) client.putJson('main', `bench/file-${i}.json`, { i, blob: blob.toString('base64') })
    const wallMs = performance.now() - started
    const catalog = readJson(manager.catalogFile, null)
    const manifest = manager.readManifest('rt-evo', 'main')
    const staleVersions = manifest && catalog?.works?.['rt-evo/main']
      ? manifest.version - catalog.works['rt-evo/main'].version
      : 99
    rmRf(dir)
    return { wallMs: round2(wallMs), catalogWrites, staleVersions }
  } catch (error) {
    rmRf(dir)
    throw error
  }
}

/** 租约等待：wait() 挂起后 120ms 才 claim，检测延迟 = 120ms + 轮询量化。 */
async function benchLeaseWait() {
  const samples = []
  for (let i = 0; i < 8; i++) {
    const lease = createEditorLease()
    const t0 = performance.now()
    const pending = lease.wait({ timeoutMs: 5000 }).then(() => performance.now() - t0)
    await sleep(120)
    lease.claim('e1')
    samples.push(await pending)
    await sleep(10)
  }
  return round2(median(samples))
}

/** keep-alive：50 个请求，中间空闲 1.4s，看服务端需要接受几次连接。 */
async function benchKeepAlive(keepAliveTimeoutMs) {
  let connections = 0
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  }
  const server = await listen(0, { keepAliveTimeoutMs, handler })
  server.on('connection', () => { connections++ })
  try {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const base = `http://127.0.0.1:${server.address().port}/`
    for (let i = 0; i < 15; i++) await httpGet(base, agent)
    await sleep(1400)
    for (let i = 0; i < 15; i++) await httpGet(base, agent)
    agent.destroy()
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
      /* 兜底：即使还有残留 socket 也不能挂死评估器 */
      setTimeout(resolve, 500).unref?.()
    })
  }
  return { connections }
}

export async function evaluatePluginKit(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)
  const envJson = JSON.stringify({ 'dsh-plugin-kit': tuningPatch })

  const [asyncLock, xproc, journal, catalog, leaseDetect, keepAlive] = await Promise.all([
    benchAsyncContention(),
    Promise.resolve(benchCrossProcess(envJson)),
    Promise.resolve(benchJournal(tuningPatch.journalMaxBytes, tuningPatch.journalTailLimit)),
    Promise.resolve(benchCatalog()),
    benchLeaseWait(),
    benchKeepAlive(genome.keepAliveTimeoutMs),
  ])

  const stabilityFailures = (asyncLock.violations + asyncLock.failures)
    + (xproc.counter === 80 && xproc.exitCodes.every((c) => c === 0) ? 0 : 1)
    + (journal.rotated || tuningPatch.journalMaxBytes >= 400 * 4200 ? 0 : 1)
    + (journal.tailLen > 0 && journal.tailLen <= tuningPatch.journalTailLimit && journal.recoveryOk ? 0 : 1)
    + (catalog.catalogWrites > 0 && catalog.staleVersions >= 0 ? 0 : 1)
    + (leaseDetect < 5000 && keepAlive.connections >= 1 && keepAlive.connections <= 15 ? 0 : 1)

  return {
    ok: stabilityFailures === 0,
    objectives: {
      contentionMs: asyncLock.wallMs,
      storageMs: round2(journal.appendMs + catalog.wallMs),
      storageBytes: journal.journalBytes,
      metaLatencyMs: round2(journal.tailP95Ms + leaseDetect),
      catalogCost: round2(catalog.catalogWrites + 0.2 * catalog.staleVersions),
      connections: keepAlive.connections,
      stabilityFailures,
    },
    meta: {
      xprocWallMs: xproc.wallMs, xprocCounter: xproc.counter,
      tailP95Ms: journal.tailP95Ms, leaseDetectMs: leaseDetect,
      catalogWrites: catalog.catalogWrites, staleVersions: catalog.staleVersions,
      rotated: journal.rotated,
    },
  }
}

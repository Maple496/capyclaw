/** 模块基准评估器：真实启动 relay / 真实读写 store，不用模型估算。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..', '..', 'plugin', 'dsh-ppt-workbench')
const pkgUrl = (rel) => pathToFileURL(path.join(PKG, rel)).href

const { setTuning, resetTuning } = await import(pkgUrl('server/tuning.mjs'))
const { startRelay } = await import(pkgUrl('server/relay.mjs'))
const { BridgeStore } = await import(pkgUrl('server/store.mjs'))
const { createJsonPptApp } = await import(pkgUrl('server/ppt-shim.mjs'))
const { applyOp } = await import(pathToFileURL(path.join(PKG, 'core', 'ops.js')).href)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index] * 100) / 100
}

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 5000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, bytes: Buffer.byteLength(text) }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function dirSize(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += dirSize(full)
      else total += fs.statSync(full).size
    }
  } catch { /* 空目录 */ }
  return total
}

/** relay / workbench：状态延迟、push 延迟、空闲 CPU、并发稳定性。 */
export async function evaluateRelay(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)
  const hostDir = tempDir('ppt-evolve-relay-')
  let relay = null
  try {
    relay = await startRelay({
      port: 0,
      hostDir,
      packageDir: PKG,
      lockFile: path.join(hostDir, 'relay.lock'),
      allowReuse: false,
    })
    const base = relay.url
    /* 预热，排除首次 JIT/构建缓存影响。 */
    for (let i = 0; i < 15; i++) await getJson(`${base}/status`)

    const statusLatency = []
    let responseBytes = 0
    for (let i = 0; i < 80; i++) {
      const started = performance.now()
      const res = await getJson(`${base}/status`)
      statusLatency.push(performance.now() - started)
      responseBytes += res.bytes
    }

    const pushLatency = []
    /* 预热 push 路径（首次会触发 op 模块 JIT 与模板初始化）。 */
    for (let i = 0; i < 5; i++) {
      await getJson(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cmds: [{ op: 'load', deck: { title: 'warm', slides: [{ id: `w${i}`, elements: [] }] } }],
          title: 'warm',
        }),
      })
    }
    for (let i = 0; i < 15; i++) {
      const body = {
        cmds: [{
          op: 'load',
          deck: { title: 'bench', slides: [{ id: `s${i}`, elements: [] }] },
        }],
        title: 'bench',
      }
      const started = performance.now()
      const res = await getJson(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      pushLatency.push(performance.now() - started)
      if (res.status !== 200) throw new Error(`push 返回 ${res.status}`)
    }

    /* 编辑器更新延迟：watch 打开后推一条指令，测 watch 多久返回。
     * 取 5 次中位数，避免单次 timer 抖动。 */
    const watchSamples = []
    for (let i = 0; i < 5; i++) {
      const watchBase = await getJson(`${base}/status`)
      const watchPromise = fetch(`${base}/watch?seq=${watchBase.json?.seq ?? 0}&shot=0&timeout=5`, {
        signal: AbortSignal.timeout(6000),
      }).then((res) => res.text()).catch(() => '')
      /* 等长轮询真正挂上再推变更；否则请求尚未到达服务端时会测出“0ms 返回”的假值。 */
      await sleep(200)
      const changeStarted = performance.now()
      await getJson(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cmds: [{ op: 'load', deck: { title: 'watch', slides: [{ id: 'w1', elements: [] }] } }],
          title: 'watch',
        }),
      })
      await watchPromise
      watchSamples.push(performance.now() - changeStarted)
      await sleep(20)
    }
    watchSamples.sort((a, b) => a - b)
    const watchLatencyMs = Math.round(watchSamples[Math.floor(watchSamples.length / 2)] * 100) / 100

    /* 空闲 CPU 仅作诊断（Windows 计时器分辨率粗，不参与选择）。 */
    const cpuStart = process.cpuUsage()
    await sleep(300)
    const cpu = process.cpuUsage(cpuStart)
    const idleCpuMs = Math.round((cpu.user + cpu.system) / 1000 * 100) / 100

    /* 并发稳定性：6 个 push 同时打进来，服务端必须串行且最终状态一致。 */
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => getJson(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cmds: [{
          op: 'load',
          deck: {
            title: `C${i}`,
            slides: Array.from({ length: 10 }, (_, j) => ({ id: `c${i}-${j}`, elements: [] })),
          },
        }],
        title: `C${i}`,
      }),
      timeoutMs: 15000,
    }).catch((error) => ({ status: 0, error }))))
    const statuses = concurrent.map((item) => item.status)
    const final = await getJson(`${base}/deck`)
    const slides = final.json?.deck?.slides?.length || 0
    const stabilityFailures = statuses.filter((code) => code !== 200).length + (slides === 10 ? 0 : 1)

    return {
      ok: true,
      objectives: {
        p95StatusMs: percentile(statusLatency, 95),
        pushP95Ms: percentile(pushLatency, 95),
        watchLatencyMs,
        watchWakeupsPerSec: Math.round(1000 / Math.max(10, Number(genome.watchPollMs) || 50)),
        stabilityFailures,
        responseBytes: Math.round(responseBytes / 80),
      },
      meta: {
        port: relay.port, statuses, slides, seq: final.json?.seq,
        idleCpuMs, watchSamples, watchPollMs: genome.watchPollMs,
      },
    }
  } finally {
    try { await relay?.stop() } catch { /* 忽略 */ }
    try { fs.rmSync(hostDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

/** store / persistence：批次吞吐、state/journal 体积、重载恢复。 */
export async function evaluateStore(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)
  const dir = tempDir('ppt-evolve-store-')
  try {
    const file = path.join(dir, 'state.json')
    const store = new BridgeStore(file)
    const jsonP = createJsonPptApp(store)
    const batches = 60
    const opsPerBatch = 8
    const runBatch = async (i, checkpoint = false) => {
      const cmds = [{
        op: 'load',
        deck: { title: 'bench', slides: [{ id: `base-${i}`, elements: [] }] },
      }]
      for (let j = 0; j < opsPerBatch - 1; j++) {
        cmds.push({ op: 'add-slide', slide: { id: `s-${i}-${j}`, elements: [] } })
      }
      const doc = store.push(cmds, 'bench')
      for (const cmd of cmds) {
        await applyOp(jsonP, cmd, { templates: () => store.getTemplates() })
      }
      store.applyServer(doc.seq, cmds.length, '')
      if (checkpoint) store.checkpoint(`cp-${i}`, { i })
    }
    /* 预热：首批包含模块加载/JIT，不计入吞吐。 */
    for (let i = 0; i < 30; i++) await runBatch(-1 - i)
    const started = performance.now()
    for (let i = 0; i < batches; i++) await runBatch(i, i % 15 === 0)
    const elapsedMs = performance.now() - started
    const stateBytes = fs.statSync(file).size
    const journalBytes = ['journal.jsonl', 'journal.jsonl.1']
      .reduce((sum, name) => {
        try { return sum + fs.statSync(path.join(dir, name)).size } catch { return sum }
      }, 0)
    const reloaded = new BridgeStore(file)
    const deck = reloaded.get().deck
    const recoveryFailures = deck && Array.isArray(deck.slides) && deck.slides.length === opsPerBatch ? 0 : 1
    return {
      ok: true,
      objectives: {
        msPerBatch: Math.round((elapsedMs / batches) * 100) / 100,
        stateBytes,
        journalBytes,
        recoveryFailures,
      },
      meta: { batches, opsPerBatch, elapsedMs: Math.round(elapsedMs), slides: deck?.slides?.length || 0 },
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    resetTuning()
  }
}

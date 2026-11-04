/**
 * PPT 编辑链路评估器：真实启动 relay、真实 push 混合 op、真实跑 ppt-shim op 引擎、
 * 真实 journal 持久化与恢复。目标全部转成最小化。
 */
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
const { buildDeck } = await import(pathToFileURL(path.join(PKG, 'core', 'deck-layout.js')).href)

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
  return { status: res.status, json }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 底稿：clean 预设 12 页混合版式（编辑负载的底座 + 审计干净语料）。 */
function baseDeck(preset = 'clean', slides = 12) {
  const specs = []
  const kinds = ['cover', 'bullets', 'two', 'stat', 'quote', 'bullets', 'section', 'bullets', 'stat', 'two', 'quote', 'end']
  for (let i = 0; i < slides; i++) {
    const kind = kinds[i % kinds.length]
    if (kind === 'stat') {
      specs.push({ layout: kind, title: `数据页 ${i}`, stat: [
        { value: '42%', label: '增长率' }, { value: '3.2x', label: '效率' }, { value: '128', label: '客户' },
      ] })
    } else if (kind === 'quote') {
      specs.push({ layout: kind, quote: '好的设计是把复杂留给自己，把简单留给用户。', author: '设计团队' })
    } else if (kind === 'cover') {
      specs.push({ layout: kind, title: `季度汇报 ${i}`, subtitle: '增长 · 效率 · 稳定' })
    } else if (kind === 'end') {
      specs.push({ layout: kind, title: '谢谢观看', subtitle: '欢迎提问' })
    } else if (kind === 'section') {
      specs.push({ layout: kind, title: `第二章 · 展望 ${i}` })
    } else {
      specs.push({ layout: kind, title: `要点页 ${i}`, bullets: [
        '先把问题定义清楚，再动手解决',
        '用数据驱动每一次取舍与验证',
        '保持小步快跑，随时可以回退',
      ] })
    }
  }
  return buildDeck({ preset, title: '进化基准底稿', slides: specs })
}

/** 一批真实编辑 op：目标从**实时** deck 派生（编辑器语义：改的是当前状态，
 * duplicate/move 之后静态索引会漂移）。 */
function mixedOps(liveSlides, batchIndex, rnd) {
  const slideCount = liveSlides.length
  const slideNo = Math.floor(rnd() * slideCount)
  const slide = liveSlides[slideNo]
  const textEls = (slide?.elements || []).filter((el) => el.type === 'text')
  const target = textEls[rnd() < 0.5 ? 0 : Math.floor(rnd() * textEls.length)] || textEls[0]
  const ops = []
  const roll = rnd()
  if (roll < 0.3 && target) {
    ops.push({ op: 'set-text', index: slideNo, elementId: target.id, text: `批次${batchIndex}：把复杂留给自己，把简单留给用户，用数据验证每一次取舍。` })
  } else if (roll < 0.45 && target) {
    ops.push({ op: 'fill-slot', slide: slideNo, slot: 0, text: `槽位更新 ${batchIndex}-${Math.floor(rnd() * 100)}` })
  } else if (roll < 0.6) {
    ops.push({ op: 'add-element', slide: slideNo, element: {
      id: `ev_${batchIndex}_${Math.floor(rnd() * 1e6).toString(36)}`, type: 'text',
      left: 100 + rnd() * 400, top: 200 + rnd() * 200, width: 320, height: 60,
      content: '<p style="font-size:18px">新增标注文本</p>' } })
  } else if (roll < 0.7) {
    ops.push({ op: 'set-notes', slide: slideNo, notes: `演讲备注：第 ${batchIndex} 批编辑的要点提醒。` })
  } else if (roll < 0.8) {
    ops.push({ op: 'set-background', indices: [slideNo], color: rnd() < 0.5 ? '#ffffff' : '#f7f8fa' })
  } else if (roll < 0.9) {
    ops.push({ op: 'duplicate-slide', index: slideNo })
  } else {
    ops.push({ op: 'move-slide', from: 0, to: 1 })
  }
  return ops
}

/** 编辑链路：relay push 混合 op + op 引擎直测 + watch 延迟 + 并发一致性 + 恢复。 */
export async function evaluateEditing(genome, tuningPatch) {
  resetTuning()
  setTuning(tuningPatch)
  const hostDir = tempDir('ppt-evolve-edit-')
  let relay = null
  try {
    const deck = baseDeck()
    /* 预热（JIT/模块加载不入测量） */
    for (let i = 0; i < 8; i++) {
      const dir = tempDir('ppt-evolve-warm-')
      try {
        const store = new BridgeStore(path.join(dir, 'state.json'))
        const jsonP = createJsonPptApp(store)
        await applyOp(jsonP, { op: 'load', deck }, { templates: () => store.getTemplates() })
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    }

    relay = await startRelay({
      port: 0, hostDir, packageDir: PKG,
      lockFile: path.join(hostDir, 'relay.lock'), allowReuse: false,
    })
    const base = relay.url
    for (let i = 0; i < 12; i++) await getJson(`${base}/status`)

    /* 1) op 引擎直测：60 批 × 真实混合 op（不经 HTTP，测服务端编辑引擎纯吞吐）。
     * 预热必须用同样的混合 op 跑到计时稳定：只预热 load 会让 JIT 顺序效应
     * 被误读成基因信号（2026-11-01 第一轮的教训）。 */
    let rndSeed = 2026
    const rnd = () => { rndSeed = (rndSeed * 1103515245 + 12345) % 2147483648; return rndSeed / 2147483648 }
    const dir2 = tempDir('ppt-evolve-engine-')
    let opsApplyMsPerBatch = 0
    let engineFailures = 0
    try {
      const store = new BridgeStore(path.join(dir2, 'state.json'))
      const jsonP = createJsonPptApp(store)
      await applyOp(jsonP, { op: 'load', deck }, { templates: () => store.getTemplates() })
      const runBatch = async (b) => {
        const cmds = mixedOps(jsonP.getSlides(), b, rnd)
        for (const cmd of cmds) {
          try {
            await applyOp(jsonP, cmd, { templates: () => store.getTemplates() })
          } catch {
            /* move-slide/duplicate 等在边界状态可能合法失败：不计为引擎失败 */
            if (!['move-slide', 'remove-slide', 'remove-element'].includes(cmd.op)) engineFailures++
          }
        }
        const doc = store.push(cmds, 'evo')
        store.applyServer(doc.seq, cmds.length, '')
      }
      /* 混合 op 预热：直到连续 3 批的耗时波动 < 15% 或跑满 30 批 */
      let warmTimes = []
      for (let b = 0; b < 30; b++) {
        const t0 = performance.now()
        await runBatch(-1 - b)
        warmTimes.push(performance.now() - t0)
        if (warmTimes.length >= 3) {
          const last3 = warmTimes.slice(-3)
          const spread = (Math.max(...last3) - Math.min(...last3)) / Math.max(...last3)
          if (spread < 0.15) break
        }
      }
      const batches = 60
      const started = performance.now()
      for (let b = 0; b < batches; b++) {
        await runBatch(b)
      }
      opsApplyMsPerBatch = Math.round(((performance.now() - started) / batches) * 100) / 100
      const reloaded = new BridgeStore(path.join(dir2, 'state.json'))
      const reloadedSlides = reloaded.get()?.deck?.slides?.length || 0
      if (!Number.isInteger(reloadedSlides) || reloadedSlides < 1) engineFailures++
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true })
    }

    /* 2) relay push 路径：40 批 × 混合 op（HTTP 全链路，测编辑端到端延迟） */
    const pushLatency = []
    let pushFailures = 0
    let liveDeck = deck
    await getJson(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmds: [{ op: 'load', deck }], title: 'evo-edit' }),
    })
    for (let b = 0; b < 40; b++) {
      const live = await getJson(`${base}/deck`)
      const liveSlides = live.json?.deck?.slides || deck.slides
      const cmds = mixedOps(liveSlides, 1000 + b, rnd)
      const started = performance.now()
      const res = await getJson(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmds, title: 'evo-edit' }),
        timeoutMs: (tuningPatch.pushBaseDeadlineMs || 12000) + 5000,
      })
      pushLatency.push(performance.now() - started)
      if (res.status !== 200) pushFailures++
    }
    const pushP95Ms = percentile(pushLatency, 95)
    const finalDeck = await getJson(`${base}/deck`)
    const liveSlides = finalDeck.json?.deck?.slides?.length || 0
    if (!Number.isInteger(liveSlides) || liveSlides < 1) pushFailures++
    liveDeck = finalDeck.json?.deck || deck

    /* 3) watch 更新延迟（5 次中位数）。
     * 挂载竞态防护：等待时长必须 > watchPollMs（轮询间隔），否则 push 会落在
     * watch 挂载之前，读到立即返回的假快值——第一轮 poll=225 的 19ms 即此伪影。 */
    const attachWaitMs = Math.max(350, (Number(genome.watchPollMs) || 50) + 150)
    const watchSamples = []
    for (let i = 0; i < 5; i++) {
      const watchBase = await getJson(`${base}/status`)
      const watchPromise = fetch(`${base}/watch?seq=${watchBase.json?.seq ?? 0}&shot=0&timeout=8`, {
        signal: AbortSignal.timeout(12000),
      }).then((res) => res.text()).catch(() => '')
      await sleep(attachWaitMs)
      const changeStarted = performance.now()
      await getJson(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmds: [{ op: 'set-notes', slide: 0, notes: `watch 探针 ${i}` }], title: 'evo-edit' }),
      })
      await watchPromise
      watchSamples.push(performance.now() - changeStarted)
      await sleep(20)
    }
    watchSamples.sort((a, b) => a - b)
    const watchLatencyMs = Math.round(watchSamples[Math.floor(watchSamples.length / 2)] * 100) / 100

    /* 4) 并发稳定性：6 个混合编辑批次同时打进来，服务端必须串行且最终一致 */
    const concurrentDeck = (await getJson(`${base}/deck`)).json?.deck || liveDeck
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => getJson(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cmds: mixedOps(concurrentDeck.slides, 2000 + i, rnd),
        title: 'evo-edit',
      }),
      timeoutMs: 20000,
    }).catch(() => ({ status: 0 }))))
    const concurrentFailures = concurrent.filter((item) => item.status !== 200).length
    const after = await getJson(`${base}/deck`)
    const slidesOk = (after.json?.deck?.slides?.length || 0) >= 1 ? 0 : 1

    /* 5) journal 体积 */
    let journalBytes = 0
    for (const name of ['journal.jsonl', 'journal.jsonl.1']) {
      try { journalBytes += fs.statSync(path.join(hostDir, name)).size } catch { /* 无文件 */ }
    }

    const stabilityFailures = engineFailures + pushFailures + concurrentFailures + slidesOk
    return {
      ok: stabilityFailures === 0,
      objectives: {
        opsApplyMsPerBatch,
        pushP95Ms,
        watchLatencyMs,
        watchWakeupsPerSec: Math.round(1000 / Math.max(10, Number(genome.watchPollMs) || 50)),
        journalBytes,
        stabilityFailures,
      },
      meta: { opsApplyMsPerBatch, pushP95Ms, watchLatencyMs, liveSlides, engineFailures, pushFailures, concurrentFailures },
    }
  } finally {
    try { await relay?.stop() } catch { /* 忽略 */ }
    try { fs.rmSync(hostDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    resetTuning()
  }
}

export { baseDeck }

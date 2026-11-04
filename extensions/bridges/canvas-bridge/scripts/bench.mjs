/**
 * scripts/bench.mjs — 交互实时性基准：
 *   起 relay（随机端口）+ 真实 headless Chromium 编辑器页，
 *   按 ppt-bridge bench 方法论逐工具测量 p50/p95/max。
 *
 * 用法：node scripts/bench.mjs [--n 20] [--json dist/bench.json] [--label <名字>]
 *
 * 指标：
 *   pipeline   —— 裸桥往返：POST cmds → /status 轮询至 applied（实时性地板）
 *   mirror     —— applied → 编辑器镜像回推（state_seq 追上）
 *   tools      —— 各 MCP 工具端到端（真实 fetch /mcp）
 *   concurrent —— 并发追加的尾延迟
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKBENCH = join(ROOT, 'plugin', 'capyclaw-canvas-workbench')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const N = Math.max(3, Number(arg('--n', 20)) || 20)
const LABEL = arg('--label', 'run')
const OUT = arg('--json', null)
const PORT = 39500 + (Date.now() % 400)

const BASE = `http://127.0.0.1:${PORT}`
const MCP = `${BASE}/mcp`
const BRIDGE = `${BASE}/api/desktop/works/canvas-bridge`

/* ---------- 统计 ---------- */
function stats(list) {
  const s = [...list].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return {
    n: s.length, p50: Math.round(q(0.50)), p95: Math.round(q(0.95)),
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), max: Math.round(s[s.length - 1]),
  }
}

/* ---------- MCP 客户端（与真实客户端同路：fetch streamable-http） ---------- */
let rpcId = 0
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args })
const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

/* ---------- 裸桥：push → applied → mirror ---------- */
async function bridgePush(cmds, title) {
  const t0 = performance.now()
  const pushed = await fetch(BRIDGE, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmds, title: title || '' }),
  }).then((r) => r.json())
  const seq = pushed.seq
  let appliedAt = null
  let mirrorAt = null
  for (;;) {
    const st = await fetch(`${BRIDGE}/status`).then((r) => r.json())
    if (appliedAt === null && st.applied_seq >= seq) appliedAt = performance.now()
    if (appliedAt !== null && st.state_seq >= seq) { mirrorAt = performance.now(); break }
    if (performance.now() - t0 > 30000) break
    await sleep(25)
  }
  return {
    appliedMs: appliedAt === null ? 30000 : appliedAt - t0,
    mirrorMs: mirrorAt === null ? 30000 : mirrorAt - t0,
  }
}

/* ---------- 环境 ---------- */
const DIR = join(ROOT, 'dist', 'bench-state')
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const relay = spawn(process.execPath, [join(WORKBENCH, 'server', 'relay.mjs'), '--port', String(PORT), '--dir', DIR], { stdio: ['ignore', 'ignore', 'pipe'] })
relay.stderr.on('data', (d) => console.error('[relay!]', String(d).trim()))
await sleep(1200)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(async (bridgeUrl) => {
  const r = await fetch(`${bridgeUrl}/status`).then((x) => x.json()).catch(() => null)
  return !!(r && r.owner && r.owner.age <= 10)
}, BRIDGE, { timeout: 20000 })

const report = { label: LABEL, n: N, at: new Date().toISOString(), pipeline: {}, tools: {}, concurrent: {}, pageErrors: 0 }

try {
  /* 预热：一次成稿 */
  await call('canvas_write_document', {
    title: 'bench 基准文档',
    blocks: [
      { type: 'heading', level: 1, text: '交互实时性基准' },
      { type: 'paragraph', text: '本文档用于测量工具链路延迟。' },
      { type: 'heading', level: 2, text: '第一章' },
      { type: 'paragraph', text: '内容内容内容内容内容内容内容内容。'.repeat(3) },
      { type: 'bullet', text: '要点一' }, { type: 'bullet', text: '要点二' },
      { type: 'quote', text: '引用一段文字。' },
    ],
  })
  await sleep(500)

  /* 1. 裸桥管线（实时性地板） */
  const pushLat = []
  const mirrorLat = []
  for (let i = 0; i < N; i++) {
    const r = await bridgePush([{ cmd: 'appendElementList', args: [[{ value: `管线探针 ${i} ` }, { value: '\n' }]] }], 'bench-pipeline')
    pushLat.push(r.appliedMs)
    mirrorLat.push(r.mirrorMs)
    await sleep(30)
  }
  report.pipeline.push_to_applied = stats(pushLat)
  report.pipeline.push_to_mirror = stats(mirrorLat)

  /* 2. 逐工具 */
  const bench = async (name, fn, n = N) => {
    const list = []
    let err = null
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      try { await fn(i) } catch (e) { err = String(e && e.message || e); break }
      list.push(performance.now() - t)
      await sleep(20)
    }
    report.tools[name] = err ? { error: err } : stats(list)
    console.log(`${name.padEnd(26)} ${err ? 'ERROR ' + err : `p50 ${report.tools[name].p50}ms  p95 ${report.tools[name].p95}ms  max ${report.tools[name].max}ms`}`)
  }

  console.log(`\n== 工具端到端（n=${N}，含 MCP 封装 + 工具内部等待）==`)
  await bench('canvas_write_document', (i) => call('canvas_write_document', {
    title: `bench-${i}`,
    blocks: [
      { type: 'heading', level: 1, text: `基准稿 ${i}` },
      { type: 'paragraph', text: '一段正文。'.repeat(6) },
      { type: 'bullet', text: 'a' }, { type: 'bullet', text: 'b' },
    ],
  }), Math.min(N, 12))

  await bench('canvas_append_blocks', (i) => call('canvas_append_blocks', {
    blocks: [{ type: 'paragraph', text: `追加段 ${i}，用于测量续写延迟。` }],
  }))

  await bench('canvas_replace_text', (i) => call('canvas_replace_text', {
    find: `追加段 ${Math.max(0, i - 1)}`, replace: `已改 ${i}`,
  }))

  await bench('canvas_style', (i) => call('canvas_style', {
    find: `基准稿`, style: { bold: true, color: i % 2 ? '#c2410c' : '#1d4ed8' },
  }), Math.min(N, 12))

  await bench('canvas_read_summary', () => call('canvas_read', { mode: 'summary' }))
  await bench('canvas_read_text', () => call('canvas_read', { mode: 'text' }))

  await bench('canvas_insert_table', (i) => call('canvas_insert_table', {
    headers: ['A', 'B', 'C'], rows: [[String(i), 'x', 'y']],
  }), Math.min(N, 10))

  await bench('canvas_audit', () => call('canvas_audit'), Math.min(N, 10))
  await bench('canvas_capabilities', () => call('canvas_capabilities'), Math.min(N, 30))
  await bench('canvas_screenshot', () => call('canvas_screenshot'), 5)

  /* 3. 并发追加（5 路同时） */
  console.log(`\n== 并发（5 路并行追加 × ${Math.ceil(N / 5)} 轮）==`)
  const perOp = []
  const rounds = Math.max(1, Math.ceil(N / 5))
  for (let round = 0; round < rounds; round++) {
    const t0 = performance.now()
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, k) =>
      call('canvas_append_blocks', { blocks: [{ type: 'paragraph', text: `并发 ${round}-${k}` }] })))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) { report.concurrent.error = `${failed} 个并发调用失败`; break }
    perOp.push((performance.now() - t0))
    await sleep(50)
  }
  report.concurrent.batch_of_5 = stats(perOp)
  console.log(`5 路并发整批    p50 ${report.concurrent.batch_of_5.p50}ms  p95 ${report.concurrent.batch_of_5.p95}ms`)

  /* 4. 镜像体积（读路径优化的意义） */
  const docRes = await fetch(`${BRIDGE}/doc`)
  const docBytes = (await docRes.text()).length
  report.mirrorBytes = docBytes
  console.log(`\n镜像大小：${(docBytes / 1024).toFixed(1)} KB`)

  /* 5. 大文档阶段：暴露读放大（summary 拉全量镜像 / 追加读改写全量） */
  console.log(`\n== 大文档（~600KB 镜像，n=8）==`)
  const bigBlocks = [{ type: 'heading', level: 1, text: '大文档基准' }]
  for (let s = 0; s < 12; s++) {
    bigBlocks.push({ type: 'heading', level: 2, text: `第 ${s} 章` })
    for (let p = 0; p < 14; p++) {
      bigBlocks.push({ type: 'paragraph', text: `第 ${s} 章第 ${p} 段：${'长文本内容测试。'.repeat(22)}` })
    }
  }
  report.large = {}
  const t0 = performance.now()
  await call('canvas_write_document', { title: 'big', blocks: bigBlocks })
  report.large.write_ms = Math.round(performance.now() - t0)
  await sleep(600)
  const bigDoc = await fetch(`${BRIDGE}/doc`).then((r) => r.text())
  report.large.mirrorKb = Math.round(bigDoc.length / 1024)
  console.log(`大文档镜像：${report.large.mirrorKb} KB（写入 ${report.large.write_ms}ms）`)

  const benchLarge = async (name, fn, n = 8) => {
    const list = []
    let err = null
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      try { await fn(i) } catch (e) { err = String(e && e.message || e); break }
      list.push(performance.now() - t)
      await sleep(20)
    }
    report.large[name] = err ? { error: err } : stats(list)
    console.log(`${name.padEnd(26)} ${err ? 'ERROR ' + err : `p50 ${report.large[name].p50}ms  p95 ${report.large[name].p95}ms  max ${report.large[name].max}ms`}`)
  }
  await benchLarge('read_summary', () => call('canvas_read', { mode: 'summary' }))
  await benchLarge('read_text', () => call('canvas_read', { mode: 'text' }))
  await benchLarge('append_blocks', (i) => call('canvas_append_blocks', { blocks: [{ type: 'paragraph', text: `大文档追加 ${i}。` }] }))
  await benchLarge('replace_text', (i) => call('canvas_replace_text', { find: `大文档追加 ${Math.max(0, i - 1)}`, replace: `改 ${i}` }))
  await benchLarge('insert_table', (i) => call('canvas_insert_table', { headers: ['A', 'B'], rows: [[String(i), 'v']] }), 5)

  report.pageErrors = pageErrors.length
  report.pageErrorSample = pageErrors.slice(0, 2)
} finally {
  await browser.close().catch(() => {})
  relay.kill()
}

console.log(`\n管线：push→applied p50 ${report.pipeline.push_to_applied.p50}ms / p95 ${report.pipeline.push_to_applied.p95}ms；push→镜像 p50 ${report.pipeline.push_to_mirror.p50}ms`)
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(`已写入 ${OUT}`)
}
process.exit(0)

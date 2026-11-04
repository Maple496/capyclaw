#!/usr/bin/env node
/**
 * MCP 压测：并发读、并发写、非法参数洪流、超大参数、并发截图、UI 命令风暴。
 * 结束时恢复原 deck。
 *
 * 用法：
 *   node scripts/stress-mcp.mjs --mcp http://127.0.0.1:39414/mcp --editor http://127.0.0.1:39414/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const MCP = arg('--mcp', 'http://127.0.0.1:39414/mcp')
const EDITOR = arg('--editor', 'http://127.0.0.1:39414/').replace(/\/+$/, '')
const BASE = EDITOR + '/api/desktop/works/ppt-bridge'
const CONCURRENCY = Math.max(1, Number(arg('--concurrency', '20')))
const READ_ROUNDS = Math.max(1, Number(arg('--read-rounds', '10')))
const WRITE_ROUNDS = Math.max(1, Number(arg('--write-rounds', '5')))
const INVALID_CALLS = Math.max(10, Number(arg('--invalid', '100')))
const SCREENSHOTS = Math.max(1, Number(arg('--screenshots', '3')))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
}

async function callTool(name, arguments_ = {}) {
  const started = performance.now()
  try {
    const response = await fetch(MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
    })
    const doc = await response.json()
    const text = doc?.result?.content?.[0]?.text || ''
    return { ok: !doc?.result?.isError && response.ok, ms: performance.now() - started, doc, text }
  } catch (error) {
    return { ok: false, ms: performance.now() - started, error: String(error.message || error) }
  }
}

async function runPool(name, count, task) {
  const latencies = []
  const errors = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, count) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= count) return
      const result = await task(index)
      latencies.push(result.ms)
      if (!result.ok) errors.push(result.error || result.text?.slice(0, 120) || `HTTP ${result.doc?.error?.code || '?'}`)
    }
  })
  const started = performance.now()
  await Promise.all(workers)
  const elapsed = performance.now() - started
  latencies.sort((a, b) => a - b)
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] || 0
  record(name, errors.length === 0, `${count} calls / ${Math.round(elapsed)}ms · p50=${Math.round(p(.5))}ms p95=${Math.round(p(.95))}ms max=${Math.round(p(1))}ms errors=${errors.length}`)
  if (errors.length) console.log('  errors:', [...new Set(errors)].slice(0, 5).join(' | '))
  return { errors, elapsed, latencies }
}

async function getJson(pathname) {
  return fetch(BASE + pathname).then((r) => r.json())
}

let backup = null
try {
  backup = await getJson('/deck')
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'dist', `stress-backup-${Date.now()}.json`), JSON.stringify(backup.deck, null, 2))

  /* 1. 并发读 */
  await runPool('并发读 capabilities/get_deck/audit', CONCURRENCY * READ_ROUNDS, async (i) => {
    const name = ['ppt_capabilities', 'ppt_get_deck', 'ppt_audit'][i % 3]
    return callTool(name, name === 'ppt_get_deck' ? { detailed: i % 2 === 0 } : {})
  })

  /* 2. 先建一个足够大的 deck，再并发写不同页 */
  const slides = Array.from({ length: 20 }, (_, i) => ({
    layout: i === 0 ? 'cover' : 'bullets',
    title: `压力页 ${i}`,
    bullets: ['A', 'B', 'C'],
  }))
  const seed = await callTool('ppt_deck', { title: '压力测试', preset: 'clean', slides })
  record('压力 deck 初始化', seed.ok, `20 页 · ${seed.error || seed.text?.slice(0, 60)}`)

  await runPool('并发写不同页 ppt_text', CONCURRENCY * WRITE_ROUNDS, async (i) => {
    return callTool('ppt_text', { text: `压力文本 ${i}`, slide: i % 20 })
  })

  /* 3. 非法参数洪流 */
  await runPool('非法参数洪流', INVALID_CALLS, async () => {
    const result = await callTool('ppt_text', { slide: 'not-an-integer', extra: 'x' })
    const isExpectedError = result.doc?.result?.isError === true && /参数不合法/.test(result.text)
    return { ...result, ok: isExpectedError, error: isExpectedError ? '' : result.text?.slice(0, 120) }
  })

  /* 4. 超大参数：31 页应被 schema maxItems 拦截；30 页应通过 */
  const oversize = await callTool('ppt_deck', {
    title: '31 页压测',
    preset: 'clean',
    slides: Array.from({ length: 31 }, (_, i) => ({ layout: 'bullets', title: `页 ${i + 1}`, bullets: ['A'] })),
  })
  record('超大参数 31 页被拦截', !oversize.ok && /最多 30|参数不合法/.test(oversize.text), oversize.text?.slice(0, 80) || oversize.error)

  const maxed = await callTool('ppt_deck', {
    title: '30 页压测',
    preset: 'clean',
    slides: Array.from({ length: 30 }, (_, i) => ({
      layout: 'bullets',
      title: `页 ${i + 1}`,
      bullets: [
        { text: '第一条要点内容'.repeat(2).slice(0, 30), detail: '补充说明内容'.repeat(2).slice(0, 50) },
        { text: '第二条要点内容'.repeat(2).slice(0, 30), detail: '补充说明内容'.repeat(2).slice(0, 50) },
      ],
    })),
  })
  record('最大合法参数 30 页', maxed.ok, maxed.error || maxed.text?.slice(0, 80))

  /* 5. 并发截图（编辑器侧应串行，不应互相踩掉） */
  await runPool('并发截图', SCREENSHOTS, async () => callTool('ppt_screenshot', {}))

  /* 6. UI 命令风暴 */
  await runPool('UI 命令风暴 select', CONCURRENCY * 2, async (i) => {
    return callTool('ppt_slide', { action: 'select', index: i % 20 })
  })

  /* 7. 压测后审计 */
  const audit = await callTool('ppt_audit', {})
  const auditJson = JSON.parse(audit.text || '{}')
  record('压测后审计', audit.ok && typeof auditJson.score === 'number', `score=${auditJson.score} issues=${auditJson.issues?.length}`)

  const health = await fetch(EDITOR + '/healthz').then((r) => r.json())
  record('压测后 healthz', health.ok === true, `slides=${health.slides} seq=${health.seq} editorConnected=${health.editorConnected}`)
} catch (error) {
  record('压测异常', false, String(error.message || error))
} finally {
  if (backup?.deck) {
    const restore = await callTool('ppt_apply', { ops: [{ op: 'load', deck: backup.deck }] })
    record('恢复原 deck', restore.ok, restore.error || restore.text?.slice(0, 80))
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} passed`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

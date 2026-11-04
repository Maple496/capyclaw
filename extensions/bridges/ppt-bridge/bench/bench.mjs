/**
 * PPT 中间件结构基准（2026-10-22）
 * 测三层：L0 本地快捷解析/应用、L1 MCP 工具端到端、L2 载荷/上下文。
 * 运行：node bench/bench.mjs
 */
import { parseQuick } from '../src/core/quick.js'
import { applyOp } from '../src/core/ops.js'
import { TOOLS } from '../src/mcp/tools.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:3311/api/desktop/works/ppt-bridge'
const out = { timestamp: new Date().toISOString(), layers: {}, payloads: {}, toolSchema: {} }

function stats(arr) {
  const a = arr.slice().sort((x, y) => x - y)
  const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))]
  return { n: a.length, min: a[0], p50: q(0.5), p95: q(0.95), max: a[a.length - 1], avg: a.reduce((s, x) => s + x, 0) / a.length }
}

function fakeP(slides) {
  const state = { slides: JSON.parse(JSON.stringify(slides)), theme: {}, title: 't' }
  return {
    isMounted: () => true,
    getSlides: () => state.slides,
    updateSlide: (i, s) => { state.slides[i] = s; return true },
    addSlide: s => state.slides.push(s),
    removeSlide: i => state.slides.splice(i, 1),
    moveSlide: () => true, duplicateSlide: () => true, selectSlide: () => true,
    load: async d => { state.slides = d.slides }, setTitle: () => {}, getTheme: () => state.theme, setTheme: t => { state.theme = t },
    undo: async () => {}, redo: async () => {}, present: () => {}, exitPresent: () => {},
  }
}

// ---------- L0：本地快捷路径 ----------
const deck9 = { slides: Array.from({ length: 9 }, (_, i) => ({
  id: 's' + i, background: { type: 'solid', color: '#000000' },
  elements: [
    { type: 'text', id: 't' + i, content: '<p style="color:#fff">标题</p>', defaultColor: '#fff', left: 60, top: 40, width: 800, height: 60 },
    { type: 'shape', id: 'sh' + i, fill: '#5b9bd5', left: 60, top: 120, width: 100, height: 4 },
  ],
})) }

const parseTimes = []
for (let i = 0; i < 5000; i++) {
  const t0 = performance.now()
  parseQuick('把背景全部改成白色')
  parseTimes.push(performance.now() - t0)
}
const applyTimes = []
for (let i = 0; i < 200; i++) {
  const P = fakeP(deck9.slides)
  const t0 = performance.now()
  await applyOp(P, { op: 'set-background', color: '#ffffff', contrast: true })
  applyTimes.push(performance.now() - t0)
}
const recolorTimes = []
for (let i = 0; i < 200; i++) {
  const P = fakeP(deck9.slides)
  const t0 = performance.now()
  await applyOp(P, { op: 'recolor', background: '#c0392b' })
  recolorTimes.push(performance.now() - t0)
}
out.layers.L0_quick = {
  parse_ms: stats(parseTimes),
  apply_setbg_9pages_ms: stats(applyTimes),
  apply_recolor_9pages_ms: stats(recolorTimes),
  note: '纯本地 JS，浏览器内执行；无网络、无模型',
}

// ---------- L1：MCP 工具端到端 ----------
function mcpClient() {
  const p = spawn('node', ['src/mcp/index.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiters = new Map()
  p.stdout.on('data', c => {
    buf += c.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } catch {}
    }
  })
  let id = 0
  const rpc = (method, params) => new Promise(res => { const my = ++id; waiters.set(my, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n') })
  return { rpc, close: () => p.kill() }
}

const mcp = mcpClient()
await mcp.rpc('initialize', { protocolVersion: '2024-11-05' })
async function callTool(name, args) {
  const t0 = performance.now()
  const r = await mcp.rpc('tools/call', { name, arguments: args })
  const dt = performance.now() - t0
  return { ms: dt, text: (r.result?.content?.[0]?.text || '').slice(0, 120), isError: !!r.result?.isError }
}
const styleRuns = [], deckRuns = []
for (let i = 0; i < 8; i++) styleRuns.push((await callTool('ppt_style', { background: '#000000', contrast: true })).ms)
for (let i = 0; i < 8; i++) deckRuns.push((await callTool('ppt_get_deck', {})).ms)
const shot = await callTool('ppt_screenshot', {})
mcp.close()
out.layers.L1_mcp = {
  ppt_style_ms: stats(styleRuns),
  ppt_get_deck_ms: stats(deckRuns),
  ppt_screenshot_ms: shot.ms,
  ppt_screenshot_ok: !shot.isError,
}

// ---------- L2：载荷 ----------
async function size(path) {
  const r = await fetch(BASE + path); const b = await r.arrayBuffer(); return b.byteLength
}
out.payloads = {
  full: await size(''),
  status: await size('/status'),
  deck: await size('/deck'),
  summary: await size('/summary'),
  shot: await size('/shot'),
}
out.toolSchema = {
  ppt_tools_chars: JSON.stringify(TOOLS).length,
  ppt_tool_count: TOOLS.length,
  old_session_tools: 43,
  old_session_schema_chars: 29101,
  est_new_schema_chars: JSON.stringify(TOOLS).length + 600,
  note: '旧会话 43 个工具（含 shell/文件/搜索/子代理/网页）；新预设仅 ppt + 提问',
}

fs.writeFileSync(new URL('./bench-result.json', import.meta.url), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))

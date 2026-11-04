#!/usr/bin/env node
/**
 * 高频节点热点基准：量化本机进程间通信与状态同步的真实开销上限。
 *   H1 loopback HTTP RTT（MCP 传输层上限，keep-alive，200B/4KB/100KB）
 *   H2 MCP 工具调用全路径（createMcpHandler 真实代码：JSON-RPC→校验→回调）
 *   H3 relay 代理附加开销（tempkey 型中转：多一跳 loopback 转发）
 *   H4 JSON 编解码吞吐（1KB/100KB/1MB）
 *   H5 深拷贝两种实现（JSON.parse(stringify) vs structuredClone，200KB/1MB）
 *   H6 状态落盘策略（全文件重写 vs 追加，200KB 状态 × 1000 次更新）
 *   H7 sha256 吞吐（1MB）
 *
 * 用法：node evolution/hotpath-bench.mjs [--json out.json]
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createMcpHandler } from '../packages/dsh-plugin-kit/src/service/mcp-http.mjs'

const results = []
function record(name, metric, value, unit) {
  results.push({ name, metric, value, unit })
  console.log(`${name.padEnd(46)} ${String(metric).padStart(10)} ${unit}`)
}
function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** 顺序请求 RTT 采样（keep-alive，单连接）。返回 {p50ms,p95ms,meanMs,reqPerSec}。 */
async function measureRoundTrip({ port, payload, requests = 300, pathName = '/' }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const body = JSON.stringify(payload)
  const samples = []
  const totalStart = performance.now()
  for (let i = 0; i < requests; i++) {
    const t0 = performance.now()
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: pathName, method: 'POST', agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.end(body)
    })
    samples.push(performance.now() - t0)
  }
  const totalMs = performance.now() - totalStart
  agent.destroy()
  return {
    p50ms: percentile(samples, 0.5),
    p95ms: percentile(samples, 0.95),
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    reqPerSec: Math.round((requests / totalMs) * 1000),
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function makeSizedPayload(bytes) {
  // 生成接近目标字节数的 JSON（工具参数形态）
  const pad = 'x'.repeat(Math.max(8, bytes - 40))
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: pad } } }
}

/* ------------------------------------------------------------------ H1/H2 */
const mcpHandler = createMcpHandler({
  tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  callTool: async (_name, args) => ({ content: [{ type: 'text', text: String(args.text || '').slice(0, 8) }] }),
})
const mcpServer = await startServer(mcpHandler)

for (const [label, bytes] of [['200B', 200], ['4KB', 4 * 1024], ['100KB', 100 * 1024]]) {
  const payload = makeSizedPayload(bytes)
  const r = await measureRoundTrip({ port: mcpServer.address().port, payload })
  record(`H2 MCP 工具调用 ${label}`, `p50 ${r.p50ms.toFixed(2)}ms`, `p95 ${r.p95ms.toFixed(2)}ms`, `${r.reqPerSec} req/s`)
}
mcpServer.close()

/* ------------------------------------------------------------------ H3 relay */
const upstream = await startServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
const proxy = await startServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: upstream.address().port, path: req.url, method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')) }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })
  req.pipe(up)
})
const relayPayload = makeSizedPayload(200)
const direct = await measureRoundTrip({ port: upstream.address().port, payload: relayPayload })
const viaProxy = await measureRoundTrip({ port: proxy.address().port, payload: relayPayload })
record('H3 relay 一跳附加（直接 p50 → 代理 p50）', `${direct.p50ms.toFixed(2)} → ${viaProxy.p50ms.toFixed(2)}ms`, `+${(viaProxy.p50ms - direct.p50ms).toFixed(2)}ms`, `${(direct.p50ms / viaProxy.p50ms).toFixed(2)}x`)
upstream.close(); proxy.close()

/* ------------------------------------------------------------------ H4 JSON */
for (const [label, bytes] of [['1KB', 1024], ['100KB', 100 * 1024], ['1MB', 1024 * 1024]]) {
  const value = makeSizedPayload(bytes)
  const text = JSON.stringify(value)
  const rounds = bytes > 200 * 1024 ? 200 : 2000
  let t0 = performance.now()
  for (let i = 0; i < rounds; i++) JSON.parse(text)
  const parseMs = (performance.now() - t0)
  t0 = performance.now()
  for (let i = 0; i < rounds; i++) JSON.stringify(value)
  const stringifyMs = (performance.now() - t0)
  record(`H4 JSON ${label}`, `parse ${(parseMs / rounds).toFixed(3)}ms`, `stringify ${(stringifyMs / rounds).toFixed(3)}ms`, '')
}

/* ------------------------------------------------------------------ H5 clone */
const deck = { slides: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: '标题', elements: Array.from({ length: 40 }, (_, j) => ({ type: 'text', text: 'x'.repeat(60), x: j, y: i })) })) }
const deckBytes = Buffer.byteLength(JSON.stringify(deck))
for (const [label, fn, rounds] of [
  ['H5 深拷贝 JSON.parse(stringify)', (v) => JSON.parse(JSON.stringify(v)), 300],
  ['H5 深拷贝 structuredClone', (v) => structuredClone(v), 300],
]) {
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) fn(deck)
  const ms = (performance.now() - t0) / rounds
  record(`${label}（${Math.round(deckBytes / 1024)}KB）`, `${ms.toFixed(2)}ms`, `${Math.round(1000 / ms)} ops/s`, '')
}

/* ------------------------------------------------------------------ H6 落盘 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpath-'))
const stateFile = path.join(dir, 'state.json')
const journalFile = path.join(dir, 'journal.jsonl')
const stateValue = deck
const stateText = JSON.stringify(stateValue)
const updates = 300
let t0 = performance.now()
for (let i = 0; i < updates; i++) {
  fs.writeFileSync(stateFile, stateText)
}
record(`H6 全文件重写（${Math.round(Buffer.byteLength(stateText) / 1024)}KB × ${updates} 次）`, `${((performance.now() - t0) / updates).toFixed(2)}ms`, `${Math.round(1000 / ((performance.now() - t0) / updates))} ops/s`, '')
const line = JSON.stringify({ seq: 1, op: 'set', patch: { text: 'x'.repeat(120) } }) + '\n'
t0 = performance.now()
for (let i = 0; i < updates; i++) {
  fs.appendFileSync(journalFile, line)
}
record(`H6 追加写（${Buffer.byteLength(line)}B × ${updates} 次）`, `${((performance.now() - t0) / updates).toFixed(3)}ms`, `${Math.round(1000 / ((performance.now() - t0) / updates))} ops/s`, '')

/* ------------------------------------------------------------------ H8 命名管道 */
// Windows 上 http server 可直接监听命名管道（\\.\pipe\<name>），Node 底层走 IOCP，绕开 TCP 栈。
const pipeName = '\\\\.\\pipe\\dsh-bench-' + process.pid + '-' + Date.now()
const pipeServer = http.createServer(mcpHandler)
await new Promise((resolve) => pipeServer.listen(pipeName, resolve))
const pipePayload = makeSizedPayload(200)
const pipeSamples = []
const pipeBody = JSON.stringify(pipePayload)
for (let i = 0; i < 300; i++) {
  const t0 = performance.now()
  await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: pipeName, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(pipeBody) } }, (res) => {
      res.resume(); res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(pipeBody)
  })
  pipeSamples.push(performance.now() - t0)
}
const tcpSamples = []
{
  const tcpPayload = makeSizedPayload(200)
  const tcpBody = JSON.stringify(tcpPayload)
  const srv = await startServer(mcpHandler)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now()
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/', method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(tcpBody) } }, (res) => {
        res.resume(); res.on('end', resolve)
      })
      req.on('error', reject)
      req.end(tcpBody)
    })
    tcpSamples.push(performance.now() - t0)
  }
  agent.destroy(); srv.close()
}
record('H8 传输：TCP loopback p50 → 命名管道 p50', `${percentile(tcpSamples, 0.5).toFixed(3)} → ${percentile(pipeSamples, 0.5).toFixed(3)}ms`, `p95 ${percentile(tcpSamples, 0.95).toFixed(2)} / ${percentile(pipeSamples, 0.95).toFixed(2)}ms`, '')
pipeServer.close()

/* ------------------------------------------------------------------ H9 批处理 */
{
  const srv = await startServer(mcpHandler)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const single = makeSizedPayload(200)
  const singleBody = JSON.stringify(single)
  const batchBody = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ ...single, id: i + 1 })))
  const timeRequests = async (body, count) => {
    const t0 = performance.now()
    for (let i = 0; i < count; i++) {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/', method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
          res.resume(); res.on('end', resolve)
        })
        req.on('error', reject)
        req.end(body)
      })
    }
    return performance.now() - t0
  }
  const perCallMs = (await timeRequests(singleBody, 200)) / 200
  const batchedPerCallMs = (await timeRequests(batchBody, 20)) / (20 * 10)
  record('H9 批处理：单请求/次 → JSON-RPC batch(10)', `${perCallMs.toFixed(3)} → ${batchedPerCallMs.toFixed(3)}ms`, `${(perCallMs / batchedPerCallMs).toFixed(1)}x`, '单次调用成本')
  agent.destroy(); srv.close()
}

/* ------------------------------------------------------------------ H10 状态写入语义 */
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpath-state-'))
  const file = path.join(dir2, 'state.json')
  const text = JSON.stringify(deck)
  const rounds = 100
  // 无 fsync：write tmp + rename
  let t = performance.now()
  for (let i = 0; i < rounds; i++) {
    const tmp = `${file}.tmp-${i}`
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  }
  const noFsync = (performance.now() - t) / rounds
  // 有 fsync：write tmp + fsync + rename（当前 state-service 行为）
  t = performance.now()
  for (let i = 0; i < rounds; i++) {
    const tmp = `${file}.tmp-f-${i}`
    fs.writeFileSync(tmp, text)
    try { const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch {}
    fs.renameSync(tmp, file)
  }
  const withFsync = (performance.now() - t) / rounds
  record(`H10 状态写（157KB）无 fsync → 有 fsync`, `${noFsync.toFixed(2)} → ${withFsync.toFixed(2)}ms`, `fsync 占 ${(withFsync - noFsync).toFixed(2)}ms（每批 2 次写）`, '')
  fs.rmSync(dir2, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ H11 校验器与克隆 */
{
  const { validateToolArguments } = await import('../packages/dsh-plugin-kit/src/tools/validate.mjs')
  const tool = {
    name: 'bench_tool',
    inputSchema: {
      type: 'object',
      required: ['slideIndex'],
      additionalProperties: false,
      properties: {
        slideIndex: { type: 'integer' },
        title: { type: 'string', maxLength: 200 },
        elements: {
          type: 'array', maxItems: 200,
          items: { type: 'object', properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
        },
      },
    },
  }
  const args = { slideIndex: 3, title: 'x'.repeat(20), elements: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, x: i, y: i * 2 })) }
  const rounds = 5000
  let t = performance.now()
  for (let i = 0; i < rounds; i++) validateToolArguments(tool, args)
  const perCall = (performance.now() - t) / rounds
  record('H11 参数校验（50 元素数组）', `${perCall.toFixed(4)}ms`, `${Math.round(1000 / perCall)} ops/s`, '')

  // 递归克隆 vs JSON 克隆
  const recursiveClone = (value) => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(recursiveClone)
    const out = {}
    for (const key of Object.keys(value)) out[key] = recursiveClone(value[key])
    return out
  }
  const cloneRounds = 300
  t = performance.now()
  for (let i = 0; i < cloneRounds; i++) recursiveClone(deck)
  const recMs = (performance.now() - t) / cloneRounds
  record('H11 深拷贝 递归实现（157KB）', `${recMs.toFixed(2)}ms`, `${Math.round(1000 / recMs)} ops/s`, '')
}

/* ------------------------------------------------------------------ H12 真实 state-service */
{
  const { FileStateBackend } = await import('../packages/dsh-state-service/src/index.mjs')
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpath-fsb-'))
  const doc = { seq: 1, applied_seq: 1, deck }
  const rounds = 100
  for (const [label, fsyncEvery] of [['fsyncEvery=1（旧行为）', 1], ['fsyncEvery=16（新默认）', 16]]) {
    const backend = new FileStateBackend(path.join(dir2, `state-${fsyncEvery}.json`), { fsyncEvery, journalMaxBytes: 512 * 1024 })
    backend.writeState(doc) // 预热
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) backend.writeState(doc)
    const ms = (performance.now() - t0) / rounds
    record(`H12 FileStateBackend.writeState（157KB，${label}）`, `${ms.toFixed(2)}ms`, `${Math.round(1000 / ms)} ops/s`, '')
  }
  fs.rmSync(dir2, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ H7 sha256 */
const blob = crypto.randomBytes(1024 * 1024)
const hashRounds = 200
t0 = performance.now()
for (let i = 0; i < hashRounds; i++) crypto.createHash('sha256').update(blob).digest('hex')
const hashMs = (performance.now() - t0) / hashRounds
record('H7 sha256（1MB）', `${hashMs.toFixed(2)}ms`, `${Math.round(1000 / hashMs)} ops/s`, '')

fs.rmSync(dir, { recursive: true, force: true })

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex >= 0) {
  fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
  console.log(`\n已写入 ${process.argv[jsonIndex + 1]}`)
}

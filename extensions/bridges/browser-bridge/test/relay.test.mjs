/**
 * relay 服务契约单测（mock 引擎，不拉浏览器）：
 * healthz（诚实能力标志）/ metrics / MCP 握手（15 工具 + capabilities 调用）/
 * 工作台静态页 / 演示页 / api 路由 / 未知接口 404 / 干净关停。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKBENCH = path.resolve(HERE, '..', 'plugin', 'capyclaw-browser-workbench')
const { startRelay } = await import(pathToFileURL(path.join(WORKBENCH, 'server', 'relay.mjs')).href)

function randomPort() {
  return 20000 + Math.floor(Math.random() * 18000)
}

function mockEngine() {
  const counters = { actions: 3, errors: 1, snapshots: 2 }
  return {
    config: { headless: false, allowEvaluate: false },
    status: () => ({
      running: false, launching: false, headless: false, channel: '',
      tabs: [], activeTab: null, counters, evaluateEnabled: false,
    }),
    actionLog: () => [{ tool: 'browser_navigate', detail: 'https://example.com/', ms: 120, ok: true, error: '', at: new Date().toISOString() }],
    close: async () => ({ closed: true }),
  }
}

async function withRelay(testFn, options = {}) {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-relay-test-'))
  const port = randomPort()
  const relay = await startRelay({ port, hostDir, engine: mockEngine(), ...options })
  assert.equal(relay.reused, false)
  try {
    await testFn(port, relay)
  } finally {
    await relay.stop()
    fs.rmSync(hostDir, { recursive: true, force: true })
  }
}

const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(5000) })).json()
const rpc = async (port, method, params = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(r.status, 200)
  return r.json()
}

test('healthz：标准契约 + 诚实能力标志', () => withRelay(async (port) => {
  const h = await getJson(`http://127.0.0.1:${port}/healthz`)
  assert.equal(h.ok, true)
  assert.equal(h.name, 'browser-workbench')
  assert.equal(typeof h.pid, 'number')
  assert.equal(h.contractsOk, true)
  assert.equal(h.capabilities.engine, 'playwright')
  assert.equal(h.capabilities.evaluate, false, 'evaluate 默认关闭要如实上报')
  assert.equal(h.capabilities.headless, false)
  assert.equal(h.engine.running, false)
  assert.equal(h.injected.assets, true)
}))

test('metrics：browser_workbench_* Prometheus 指标', () => withRelay(async (port) => {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
  assert.match(text, /browser_workbench_up 1/)
  assert.match(text, /browser_workbench_actions_total 3/)
  assert.match(text, /browser_workbench_engine_running 0/)
}))

test('MCP：initialize + tools/list=15 + capabilities 真实调用', () => withRelay(async (port) => {
  const init = await rpc(port, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} })
  assert.equal(init.result.serverInfo.name, 'browser-workbench')
  const listed = await rpc(port, 'tools/list')
  assert.equal(listed.result.tools.length, 15)
  const cap = await rpc(port, 'tools/call', { name: 'browser_capabilities', arguments: {} })
  const report = JSON.parse(cap.result.content[0].text)
  assert.equal(report.contractVersion, '1.0.0')
  assert.equal(report.toolCount, 15)
  assert.equal(report.engineRunning, false)
  assert.ok(report.editorUrl.includes('127.0.0.1'), 'capabilities 报告工作台地址')
}))

test('工作台静态页与演示页（白名单）', () => withRelay(async (port) => {
  const base = `http://127.0.0.1:${port}`
  for (const [file, expect] of [
    ['/', 'DSH 浏览器操控工作台'],
    ['/app.js', 'pollStatus'],
    ['/style.css', '--accent'],
    ['/demo/form.html', '演示表单'],
  ]) {
    const r = await fetch(base + file)
    assert.equal(r.status, 200, file)
    assert.ok((await r.text()).includes(expect), file)
  }
  const missing = await fetch(`${base}/../etc/passwd`)
  assert.notEqual(missing.status, 200)
}))

test('api 路由：status 带 mock 计数；screenshot 未运行 503；未知 api 404', () => withRelay(async (port) => {
  const base = `http://127.0.0.1:${port}`
  const status = await getJson(`${base}/api/status`)
  assert.equal(status.ok, true)
  assert.equal(status.status.counters.actions, 3)
  assert.equal(status.actions.length, 1)

  const shot = await fetch(`${base}/api/screenshot`)
  assert.equal(shot.status, 503)
  const shotBody = await shot.json()
  assert.equal(shotBody.error.code, 'ENGINE_NOT_RUNNING')

  const unknown = await fetch(`${base}/api/nope`)
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'NOT_FOUND')
}))

test('stop() 后端口释放、进程退出干净（不残留）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-relay-stop-'))
  const port = randomPort()
  const relay = await startRelay({ port, hostDir, engine: mockEngine() })
  await fetch(`http://127.0.0.1:${port}/healthz`)
  await relay.stop()
  fs.rmSync(hostDir, { recursive: true, force: true })
  const gone = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)
  assert.equal(gone, true, '端口应已释放')
})

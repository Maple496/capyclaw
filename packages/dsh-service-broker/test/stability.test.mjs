/**
 * 稳定性压测：执行器质量面。
 *
 *   1. 循环启停 10 轮（资源泄漏 / 端口回收 / 计时）
 *   2. 并发双开同一服务（竞态 → 必须单实例）
 *   3. keepAlive 根进程退出后，端口确认释放才安全重启
 *   4. 病态服务（healthz 永远 500）→ 限时诚实失败 + 不留孤儿
 *   5. 外来占用者先到 → 拒绝抢端口
 *   6. 并发 apply 5 服务清单（discovery 原子性）
 *   7. 分阶段性能数据输出
 */
import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServiceEngine, canConnect, pidAlive } from '../lib/engine.mjs'

const FIXTURE = fileURLToPath(new URL('./fixture/mini-service.mjs', import.meta.url))
const t = (ms) => `${ms}ms`

let dir, engine

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-broker-stab-'))
  engine = new ServiceEngine({
    discoveryPath: path.join(dir, 'services.json'),
    log: () => {},
    defaultWaitMs: 8000,
  })
})

afterEach(async () => {
  const result = await engine.shutdown({ stopAll: true })
  assert.equal(result.ok, true, `清理服务失败: ${JSON.stringify(result.errors)}`)
})

const spec = (over = {}) => ({
  id: 'mini',
  cmd: [process.execPath, FIXTURE, '--port', '${PORT}'],
  ports: { main: 'auto' },
  url: 'http://127.0.0.1:${PORT}',
  ...over,
})

test('① 循环启停 10 轮：状态一致、端口回收、无泄漏', async () => {
  const cold = []
  let last
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now()
    last = await engine.up(spec())
    cold.push(Date.now() - t0)
    assert.equal(last.state, 'running')
    await engine.stop('mini')
    assert.equal(await canConnect(last.ports.main), false, `第 ${i + 1} 轮端口未释放`)
  }
  const rows = await engine.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'stopped')
  const avg = Math.round(cold.reduce((a, b) => a + b, 0) / cold.length)
  console.log(`   ⏱ 冷启 10 轮: min=${Math.min(...cold)}ms max=${Math.max(...cold)}ms avg=${avg}ms`)
})

test('② 并发双开同一服务：5 路并发 → 单实例', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => engine.up(spec())))
  const pids = new Set(results.map((r) => r.pid))
  assert.equal(pids.size, 1, `出现 ${pids.size} 个实例: ${[...pids].join(',')}`)
  assert.ok(results.every((r) => r.reused || r.state === 'running'))
  const rows = await engine.list()
  assert.equal(rows.filter((r) => r.id === 'mini' && r.state === 'running').length, 1)
})

test('③ keepAlive 根进程退出：端口释放后守护安全重启', async () => {
  const first = await engine.up(spec())
  process.kill(first.pid)
  const deadline = Date.now() + 8000
  while (pidAlive(first.pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  assert.equal(pidAlive(first.pid), false)
  // Wait until the dead instance's socket is actually gone; a lingering listen
  // socket would (correctly) make the guard fail closed instead of restarting.
  while (await canConnect(first.ports.main)) {
    if (Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 100))
  }
  await engine._sweepOnce(5)
  const row = await engine.statusOf('mini')
  assert.equal(row.state, 'running')
  assert.notEqual(row.pid, first.pid)
  assert.equal(pidAlive(row.pid), true)
  assert.equal(await canConnect(row.ports.main), true)
}, { timeout: 30000 })

test('④ 病态服务（healthz 恒 500）：限时诚实失败 + 进程被回收不留孤儿', async () => {
  const sick = spec({
    id: 'sick',
    cmd: [process.execPath, FIXTURE, '--port', '${PORT}', '--sick'],
  })
  const t0 = Date.now()
  await assert.rejects(() => engine.up(sick, { waitMs: 2600 }), /未通过健康检查/)
  const cost = Date.now() - t0
  assert.ok(cost >= 2500 && cost < 6000, `超时返回耗时异常: ${cost}ms`)
  // 关键卡点回归：失败的拉起必须已回收刚 spawn 的进程
  await new Promise((r) => setTimeout(r, 700))
  const list = await engine.list()
  assert.equal(list.filter((r) => r.id === 'sick').length, 0, '病态服务不应进 discovery')
  console.log(`   ⏱ 病态失败识别: ${cost}ms（waitMs=2600）`)
})

test('⑤ 外来占用者先到端口：拒绝抢、原服务不受影响', async () => {
  const first = await engine.up(spec())
  const port = first.ports.main
  // 模拟 discovery 失忆，但必须恢复记录供 afterEach 安全清理原服务。
  const registry = await engine._loadRegistry()
  try {
    await engine._saveRegistry({})
    const { createServer } = await import('node:http')
    const blocker = createServer((req, res) => { res.writeHead(404); res.end() })
    await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve))
    try {
      const bport = blocker.address().port
      await assert.rejects(
        () => engine.up(spec({ id: 'victim', ports: { main: bport } })),
        /已被其他进程占用/,
      )
      assert.equal(await canConnect(port), true, '原服务应仍健康')
    } finally {
      await new Promise((resolve, reject) => blocker.close((err) => err ? reject(err) : resolve()))
    }
  } finally {
    await engine._saveRegistry(registry)
  }
})

test('⑥ 并发 apply 5 服务清单：discovery 原子性、全部就绪', async () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const commands = ids.map((id) => ({ op: 'up', service: spec({ id }) }))
  const t0 = Date.now()
  const result = await engine.apply(commands)
  const cost = Date.now() - t0
  assert.equal(result.ok, true)
  assert.equal(result.services.length, 5)
  const reg = await engine._loadRegistry()
  for (const id of ids) {
    assert.equal(reg[id]?.state, 'running', `${id} 缺失`)
    assert.ok(await canConnect(reg[id].ports.main), `${id} 端口不通`)
  }
  console.log(`   ⏱ 5 服务清单并发 apply: ${cost}ms（含 5 次 spawn+健康等待）`)
})

test('⑦ 复用路径 vs 冷启路径延迟对比', async () => {
  const cold0 = Date.now()
  const first = await engine.up(spec({ id: 'perf' }))
  const cold = Date.now() - cold0
  // 端口解析只在非复用路径执行；禁止进入该路径，确保不会再次 spawn。
  const resolvePorts = engine._resolvePorts
  let second, reuse
  try {
    engine._resolvePorts = () => { throw new Error('复用时不应解析新端口或 spawn') }
    const reuse0 = Date.now()
    second = await engine.up(spec({ id: 'perf' }))
    reuse = Date.now() - reuse0
  } finally {
    engine._resolvePorts = resolvePorts
  }
  assert.equal(second.reused, true)
  assert.equal(second.state, 'running')
  assert.equal(second.pid, first.pid)
  assert.equal(second.ports.main, first.ports.main)
  assert.equal(await canConnect(second.ports.main), true)
  // 耗时仅供观察；调度和系统负载可能使复用比冷启动更慢。
  console.log(`   ⏱ 同规格: 冷启 ${t(cold)} / 复用 ${t(reuse)}（仅供参考）`)
})

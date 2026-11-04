/** e2e：引擎拉起/复用/停止/守护/拓扑/控制端点全链路（全部走本机回环 + 临时目录）。 */
import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { ServiceEngine, allocatePort, canConnect, pidAlive, processIdentity } from '../lib/engine.mjs'
import { createControlServer } from '../lib/control.mjs'
import { receiptPath, writeReceipt } from '../lib/recovery.mjs'

const FIXTURE = fileURLToPath(new URL('./fixture/mini-service.mjs', import.meta.url))

let dir, engine

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-broker-e2e-'))
  engine = new ServiceEngine({
    discoveryPath: path.join(dir, 'services.json'),
    log: () => {},
    defaultWaitMs: 10000,
  })
})

afterEach(async () => {
  const result = await engine.shutdown({ stopAll: true })
  assert.equal(result.ok, true, `清理服务失败: ${JSON.stringify(result.errors)}`)
})

function spec(over = {}) {
  return {
    id: 'mini',
    cmd: [process.execPath, FIXTURE, '--port', '${PORT}'],
    ports: { main: 'auto' },
    url: 'http://127.0.0.1:${PORT}',
    ...over,
  }
}

test('旧 pending 收据阻止重启，即使 discovery 中有健康实例', async () => {
  const row = await engine.up(spec())
  writeReceipt(engine.discoveryPath, 'mini', { id: 'mini', brokerPid: 99999999, brokerMarker: 'old', state: 'pending' })
  const restarted = new ServiceEngine({ discoveryPath: engine.discoveryPath, log: () => {} })
  await assert.rejects(restarted.up(spec()), /未解决的归属记录/)
  assert.equal(pidAlive(row.pid), true)
})

test('健康检查超时保留收据；根进程确认退出且端口空闲后允许再次尝试', async () => {
  const slow = spec({ cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
  await assert.rejects(engine.up(slow, { waitMs: 500 }), /子进程清理未验证|未能安全回收/)
  const receipt = JSON.parse(readFileSync(receiptPath(engine.discoveryPath, 'mini'), 'utf8'))
  assert.equal(receipt.state, 'spawned')
  assert.ok(receipt.pid && receipt.identity)
  // Reap verified the root exit and the declared port is free, so the next
  // attempt may run (it must not be blocked forever by a dead service).
  await assert.rejects(engine.up(slow, { waitMs: 300 }), /未通过健康检查/)
})

test('up → 就绪 → 幂等复用（同一 pid）', async () => {
  const first = await engine.up(spec())
  assert.equal(first.state, 'running')
  assert.ok(pidAlive(first.pid), 'discovery 记录 pid 存活')
  const second = await engine.up(spec())
  assert.equal(second.pid, first.pid, '第二次 up 应复用同一实例')
  assert.equal(second.reused, true)
})

test('借用和身份不匹配均不能停止，失败保留状态', async () => {
  const first = await engine.up(spec())
  assert.equal(first.ownership, 'owned')
  const other = new ServiceEngine({ discoveryPath: engine.discoveryPath, log: () => {} })
  const borrowed = await other.up(spec())
  assert.equal(borrowed.ownership, 'borrowed')
  assert.equal((await engine.statusOf('mini')).ownership, 'owned', '借用不能覆盖所有权记录')
  assert.equal((await other.stop('mini', { verifyIdentity: false })).stopped, false)
  assert.equal((await other.apply([{ op: 'stop', id: 'mini' }])).ok, false)
  assert.equal(pidAlive(first.pid), true)
  // 模拟 PID 复用或身份获取失败；不能因为调用方禁用健康检查而绕过。
  const original = engine._owned.get('mini')
  engine._owned.set('mini', { ...original, identity: 'wrong' })
  try {
    await assert.rejects(engine.stop('mini', { verifyIdentity: false }), /身份/)
    assert.equal((await engine.statusOf('mini')).state, 'running')
    assert.equal(pidAlive(first.pid), true)
  } finally {
    engine._owned.set('mini', original)
  }
})

test('无法验证身份时停止失败并可由 apply 报告', async () => {
  const row = await engine.up(spec())
  const owned = engine._owned.get('mini')
  engine._owned.set('mini', { ...owned, identity: null })
  try {
    const result = await engine.apply([{ op: 'stop', id: 'mini' }])
    assert.equal(result.ok, false)
    assert.match(result.errors[0].error, /身份/)
    assert.equal((await engine.statusOf('mini')).state, 'running')
    assert.equal(pidAlive(row.pid), true)
  } finally {
    engine._owned.set('mini', owned)
  }
})

test('stop → 端口释放、状态 stopped；再 up → 新实例', async () => {
  const first = await engine.up(spec())
  const port = first.ports.main
  await engine.stop('mini')
  assert.equal(existsSync(receiptPath(engine.discoveryPath, 'mini')), false)
  assert.equal(await canConnect(port), false, '停止后端口应释放')
  const row = await engine.statusOf('mini')
  assert.equal(row.state, 'stopped')
  const again = await engine.up(spec({ ports: { main: port } }))
  assert.notEqual(again.pid, first.pid)
})

test('进程被外杀 → up 收编端口上的健康实例；端口被占且不健康 → 诚实失败', async () => {
  const first = await engine.up(spec())
  const port = first.ports.main
  // 模拟 broker 失忆，测试失败时也恢复记录以供清理。
  const registry = await engine._loadRegistry()
  try {
    await engine._saveRegistry({})
    const adopted = await engine.up(spec({ ports: { main: port } }))
    assert.equal(adopted.reused, true, '应收编端口上的健康实例')
    const blocker = http.createServer(() => {})
    await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve))
    try {
      const bport = blocker.address().port
      await assert.rejects(
        () => engine.up(spec({ id: 'blocked', ports: { main: bport } })),
        /已被其他进程占用/,
      )
    } finally {
      await new Promise((resolve, reject) => blocker.close((err) => err ? reject(err) : resolve()))
    }
  } finally {
    await engine._saveRegistry(registry)
  }
})

test('apply：requires 拓扑排序（被依赖者先起）', async () => {
  const result = await engine.apply([
    { op: 'up', service: spec({ id: 'app', requires: ['dep'] }) },
    { op: 'up', service: spec({ id: 'dep' }) },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.services[0].id, 'dep', '依赖应先于应用拉起')
  const list = await engine.list()
  assert.deepEqual(list.map((s) => s.id).sort(), ['app', 'dep'])
})

test('apply：stop 命令 + 坏 op 报错', async () => {
  await engine.up(spec())
  const result = await engine.apply([{ op: 'stop', id: 'mini' }])
  assert.equal(result.ok, true)
  assert.equal((await engine.statusOf('mini')).state, 'stopped')
  await assert.rejects(() => engine.apply([{ op: 'restart', id: 'mini' }]), /未知命令/)
  await assert.rejects(
    () => engine.apply([
      { op: 'up', service: spec({ id: 'a', requires: ['b'] }) },
      { op: 'up', service: spec({ id: 'b', requires: ['a'] }) },
    ]),
    /成环/,
  )
})

test('连续三次启动停止不遗留归属记录', async () => {
  for (let i = 0; i < 3; i++) {
    const row = await engine.up(spec())
    assert.equal(row.ownership, 'owned')
    assert.equal((await engine.stop('mini')).stopped, true)
    assert.equal(existsSync(receiptPath(engine.discoveryPath, 'mini')), false)
    assert.equal(await canConnect(row.ports.main), false)
  }
})

test('守护使用过期运行快照时不能在显式停止后重启', async () => {
  const first = await engine.up(spec())
  let releaseStop, stopReady
  const stopPaused = new Promise(resolve => { stopReady = resolve })
  const resume = new Promise(resolve => { releaseStop = resolve })
  const locked = engine._locked.bind(engine)
  let intercept = true
  engine._locked = async fn => {
    if (intercept) {
      intercept = false
      stopReady()
      await resume
    }
    return locked(fn)
  }
  const stopping = engine.stop('mini')
  await stopPaused // child is gone, but discovery still says running
  assert.equal(pidAlive(first.pid), false)
  const sweep = engine._sweepOnce(3)
  // Let the sweep reach the per-service queue while stop holds it.
  await new Promise(resolve => setTimeout(resolve, 500))
  releaseStop()
  assert.equal((await stopping).stopped, true)
  await sweep
  assert.equal((await engine.statusOf('mini')).state, 'stopped')
  assert.equal(existsSync(receiptPath(engine.discoveryPath, 'mini')), false)
  assert.equal(await canConnect(first.ports.main), false)
})

test('守护发现根进程退出时保留收据并标记 error，拒绝重启', async () => {
  const pid = 2147483647
  const row = { id: 'mini', state: 'running', pid, startedAt: 'old', keepAlive: true, ports: { main: 1 } }
  await engine._saveRegistry({ mini: row })
  engine._owned.set('mini', { pid, identity: 'test' })
  engine.rememberSpec(spec())
  writeReceipt(engine.discoveryPath, 'mini', { id: 'mini', state: 'spawned', pid, identity: 'test' })
  const upOnce = engine._upOnce
  engine._upOnce = async () => { throw new Error('不得重启') }
  await engine._sweepOnce(3)
  engine._upOnce = upOnce
  assert.equal((await engine.statusOf('mini')).state, 'error')
  assert.match((await engine.statusOf('mini')).error, /占用|后代/)
  assert.equal(existsSync(receiptPath(engine.discoveryPath, 'mini')), true)
  await assert.rejects(engine.up(spec()), /未解决的归属记录/)
  await engine._saveRegistry({})
})

test('守护等待服务队列后不能覆盖新状态', async () => {
  const pid = 2147483647
  const row = { id: 'mini', state: 'running', pid, startedAt: 'old', keepAlive: true }
  await engine._saveRegistry({ mini: row })
  engine._owned.set('mini', { pid, identity: 'test' })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  engine._upLocks.set('mini', blocked)
  const sweep = engine._sweepOnce(0)
  // Wait until the sweep has enqueued its transition behind the pending operation.
  while (engine._upLocks.get('mini') === blocked) await new Promise(resolve => setImmediate(resolve))
  await engine._saveRegistry({ mini: { ...row, state: 'stopped', pid: null } })
  release()
  await sweep
  assert.equal((await engine.statusOf('mini')).state, 'stopped')
})

test('异步 spawn 失败不留下虚假收据，允许再次尝试', async () => {
  const missing = spec({ cmd: [`dsh-nonexistent-${process.pid}-command`] })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(engine.up(missing), /spawn 失败/)
    assert.equal(existsSync(receiptPath(engine.discoveryPath, 'mini')), false)
  }
})

test('broker 异常退出后旧服务保持存活且不能凭 discovery 停止', async () => {
  const port = await allocatePort()
  const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
  const broker = spawn(process.execPath, [entry, '--port', String(port), '--discovery', engine.discoveryPath], { stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  let service
  let identity
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok } catch {}
      if (ready) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(ready, '测试 broker 未就绪')
    const result = await (await fetch(`${base}/control/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [{ op: 'up', service: spec() }] }),
    })).json()
    assert.equal(result.ok, true)
    service = result.services[0]
    identity = processIdentity(service.pid)
    assert.ok(identity)
    const exited = new Promise((resolve) => broker.once('exit', resolve))
    broker.kill('SIGKILL')
    await exited
    assert.equal(pidAlive(service.pid), true)
    assert.equal((await engine.stop('mini')).stopped, false)
    assert.equal(pidAlive(service.pid), true)
    assert.equal((await engine.statusOf('mini')).ownership, 'owned')
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) {
      const exited = new Promise((resolve) => broker.once('exit', resolve))
      broker.kill('SIGKILL')
      await exited
    }
    if (service && identity && processIdentity(service.pid) === identity) {
      process.kill(service.pid)
      for (let i = 0; i < 50 && pidAlive(service.pid); i++) await new Promise((r) => setTimeout(r, 100))
    }
    // The test owns this private discovery; avoid asking shutdown to stop a borrowed service.
    await engine._saveRegistry({})
  }
}, { timeout: 30000 })

test('控制端点：healthz / apply / list / stop 走 HTTP', async () => {
  const server = createControlServer(engine, { manifestPath: undefined })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const health = await (await fetch(`${base}/healthz`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.role, 'middleware')
    const applyRes = await (await fetch(`${base}/control/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [{ op: 'up', service: spec() }] }),
    })).json()
    assert.equal(applyRes.ok, true)
    const pid = applyRes.services[0].pid
    const list = await (await fetch(`${base}/control/list`)).json()
    assert.equal(list.services.length, 1)
    const stopRes = await (await fetch(`${base}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mini' }),
    })).json()
    assert.equal(stopRes.stopped, true)
    assert.equal(pidAlive(pid), false, 'stop 后进程应退出')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

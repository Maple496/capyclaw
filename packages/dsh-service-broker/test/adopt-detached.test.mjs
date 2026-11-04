/**
 * 回归：启动器进程退出但服务实际存活 → 必须收编，不能判 failure。
 *
 * 形态对应 relay 的 allowReuse 路径（发现端口已有健康实例 → 返回并退出）。
 * 修复前 engine._upOnce 只盯 child pid → 抛「进程在健康检查通过前退出」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ServiceEngine, allocatePort, pidAlive } from '../lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'self-detaching-service.mjs')

test('启动器退出但端口已健康：借用实例，stop 不杀', async (t) => {
  const port = await allocatePort()
  const discoveryPath = path.join(HERE, `.adopt-${process.pid}.json`)
  const engine = new ServiceEngine({ discoveryPath, log: () => {} })
  t.after(() => rmSync(discoveryPath, { force: true }))

  const row = await engine.up({
    id: 'fixture-detach',
    cmd: [process.execPath, FIXTURE, '--port', '${PORT}'],
    ports: { main: port },
    url: 'http://127.0.0.1:${PORT}',
    healthPath: '/healthz',
    keepAlive: false,
  }, { waitMs: 8000 })

  t.after(() => { try { process.kill(row.pid) } catch {} })
  assert.equal(row.reused, true, '应走收编路径而不是失败')
  assert.equal(row.ownership, 'borrowed')
  assert.ok(Number.isInteger(row.pid) && row.pid > 0, '应取到健康端点自报的 pid')
  assert.ok(pidAlive(row.pid), '服务进程应真实存活')

  const doctor = await engine.doctor('fixture-detach')
  assert.equal(doctor.healthy, true)

  const result = await engine.stop('fixture-detach', { verifyIdentity: false })
  assert.equal(result.stopped, false)
  assert.equal(result.reason, 'borrowed')
  assert.equal(pidAlive(row.pid), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { start, stop } from '../lib/launcher.mjs'
import { saveState } from '../lib/state.mjs'

test('session refuses existing, malformed or replaced state and occupied lifecycle lock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-'))
  const cfg = { stateDir: dir }; const token = 'a'.repeat(48)
  try {
    await writeFile(path.join(dir, 'state.json'), '{')
    await assert.rejects(start(cfg, { sessionToken: token }), /拒绝复用/)
    await assert.rejects(stop(cfg, { sessionToken: token }), /拒绝停止/)
    await saveState(dir, { productSessionToken: 'b'.repeat(48) })
    await assert.rejects(stop(cfg, { sessionToken: token }), /拒绝停止/)
    assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'))).productSessionToken, 'b'.repeat(48))
    await writeFile(path.join(dir, 'start.lock'), '')
    await assert.rejects(start(cfg, { sessionToken: token }), /生命周期锁/)
    await assert.rejects(stop(cfg), /生命周期锁/)
    assert.equal(await readFile(path.join(dir, 'start.lock'), 'utf8'), '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('启动意图未完成时保留状态，不凭空判定进程不存在', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-intent-'))
  const previous = process.exitCode
  try {
    await saveState(dir, { brokerStartupPending: true, dshStartupPending: true })
    const result = await stop({ stateDir: dir })
    assert.ok(result.unresolved.includes('broker:startup-interrupted'))
    assert.ok(result.unresolved.includes('dsh:startup-interrupted'))
    assert.ok(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).stopResult)
  } finally {
    process.exitCode = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('旧 PID 和借用服务不会被杀，未完成停机保留状态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-safe-'))
  const previous = process.exitCode
  try {
    await writeFile(path.join(dir, 'services.json'), JSON.stringify({ services: {
      borrowed: { id: 'borrowed', state: 'running', pid: process.pid, reused: true },
      unknown: { id: 'unknown', state: 'running', pid: process.pid },
    } }))
    await saveState(dir, { broker: { pid: process.pid }, discovery: path.join(dir, 'services.json') })
    const result = await stop({ stateDir: dir })
    assert.equal(result.ok, false)
    assert.deepEqual(result.borrowed, ['borrowed'])
    assert.ok(result.unresolved.some(x => x.includes('unknown')))
    assert.ok(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).stopResult)
    process.kill(process.pid, 0)
  } finally {
    process.exitCode = previous
    await rm(dir, { recursive: true, force: true })
  }
})

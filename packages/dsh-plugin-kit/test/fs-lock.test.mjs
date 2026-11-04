import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { withFileLock, withAsyncFileLock } from '../src/util/fs-lock.mjs'

test('fresh dead lock times out without blocking the event loop or deleting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-lock-'))
  const lock = path.join(dir, 'lock')
  try {
    const pid = spawnSync(process.execPath, ['-e', '']).pid
    fs.writeFileSync(lock, JSON.stringify({ pid, token: 'a'.repeat(24) }))
    let ticked = false
    setTimeout(() => { ticked = true }, 10)
    await assert.rejects(withAsyncFileLock(lock, () => {}, { timeoutMs: 100, staleMs: 60000 }), /超时/)
    assert.equal(ticked, true)
    assert.ok(fs.existsSync(lock))
    assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 60, staleMs: 60000 }), /超时/)
    assert.ok(fs.existsSync(lock))
    fs.utimesSync(lock, new Date(0), new Date(0))
    assert.equal(withFileLock(lock, () => 'ok', { timeoutMs: 200, staleMs: 1 }), 'ok')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('malformed and live locks are never reclaimed based on age', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-lock-'))
  const lock = path.join(dir, 'lock')
  try {
    for (const value of ['{', JSON.stringify({ pid: process.pid, token: 'b'.repeat(24) })]) {
      fs.writeFileSync(lock, value)
      fs.utimesSync(lock, new Date(0), new Date(0))
      await assert.rejects(withAsyncFileLock(lock, () => {}, { timeoutMs: 50, staleMs: 1 }), /超时/)
      assert.equal(fs.readFileSync(lock, 'utf8'), value)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

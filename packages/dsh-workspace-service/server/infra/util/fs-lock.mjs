/** 同步文件锁：给 registry / workspace manifest 这类元数据用。 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tuning } from '../tuning.mjs'

const sleepCell = new Int32Array(new SharedArrayBuffer(4))

export function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms)
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function newToken() {
  return crypto.randomBytes(12).toString('hex')
}

function tryCreate(lockFile, token) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  let fd
  try {
    fd = fs.openSync(lockFile, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() }))
    try { fs.fsyncSync(fd) } catch { /* 部分文件系统不支持 */ }
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/** missing | busy | stale */
function lockState(lockFile) {
  let info = null
  let age = 0
  try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch { /* 可能正在写入 */ }
  try { age = Date.now() - fs.statSync(lockFile).mtimeMs } catch { return 'missing' }
  if (!info) return age > tuning().fileLockFreshGraceMs ? 'stale' : 'busy'
  /* 活进程持锁时不抢；宁可超时报错，也不能删掉别人的锁。 */
  if (pidAlive(info.pid)) return 'busy'
  return 'stale'
}

function releaseOwned(lockFile, token) {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    if (info.token === token) fs.rmSync(lockFile, { force: true })
  } catch { /* 已被删除或被接管 */ }
}

function acquireSync(lockFile, { timeoutMs, staleMs }) {
  const token = newToken()
  const deadline = Date.now() + timeoutMs
  const { fileLockPollMs: pollMs, fileLockFreshGraceMs: freshGraceMs } = tuning()
  while (true) {
    if (tryCreate(lockFile, token)) return token
    const state = lockState(lockFile)
    if (state === 'missing') continue
    if (state === 'stale') {
      try {
        /* 坏锁/死进程锁才清理；新创建但尚未写入的锁给宽限期。 */
        const age = Date.now() - fs.statSync(lockFile).mtimeMs
        if (age > Math.min(staleMs, freshGraceMs)) fs.rmSync(lockFile, { force: true })
      } catch { /* 已不存在 */ }
      continue
    }
    if (Date.now() >= deadline) throw new Error(`等待文件锁超时: ${lockFile}`)
    sleepSync(pollMs)
  }
}

async function acquireAsync(lockFile, { timeoutMs, staleMs }) {
  const token = newToken()
  const deadline = Date.now() + timeoutMs
  const { fileLockPollMs: pollMs } = tuning()
  while (true) {
    if (tryCreate(lockFile, token)) return token
    const state = lockState(lockFile)
    if (state === 'missing') continue
    if (state === 'stale') {
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs
        if (age > staleMs) fs.rmSync(lockFile, { force: true })
      } catch { /* 已不存在 */ }
      continue
    }
    if (Date.now() >= deadline) throw new Error(`等待文件锁超时: ${lockFile}`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export function withFileLock(lockFile, fn, opts = {}) {
  const defaults = tuning()
  const { timeoutMs = defaults.fileLockSyncTimeoutMs, staleMs = defaults.fileLockSyncStaleMs } = opts
  const token = acquireSync(lockFile, { timeoutMs, staleMs })
  try {
    return fn()
  } finally {
    releaseOwned(lockFile, token)
  }
}

/** 异步版本：用于分配端口这类需要 await 探测的场景。 */
export async function withAsyncFileLock(lockFile, fn, opts = {}) {
  const defaults = tuning()
  const { timeoutMs = defaults.fileLockAsyncTimeoutMs, staleMs = defaults.fileLockSyncStaleMs } = opts
  const token = await acquireAsync(lockFile, { timeoutMs, staleMs })
  try {
    return await fn()
  } finally {
    releaseOwned(lockFile, token)
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  try { fs.renameSync(tmp, file) } catch {
    try { fs.rmSync(file, { force: true }) } catch { /* 忽略 */ }
    fs.renameSync(tmp, file)
  }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

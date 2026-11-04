/** 同步文件锁：给 registry / workspace manifest 这类元数据用。 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tuning } from '../tuning.mjs'

const sleepCell = new Int32Array(new SharedArrayBuffer(4))

export function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms)
}

function pidDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
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

// Only a complete record whose owner is provably dead can be reclaimed. A
// record-specific claim serializes competing reclaimers, including across
// successive lock owners. An abandoned claim is intentionally not reclaimed.
function reclaimDead(lockFile, staleMs) {
  let raw, info, stat
  try {
    raw = fs.readFileSync(lockFile, 'utf8')
    info = JSON.parse(raw)
    stat = fs.statSync(lockFile)
  } catch { return false }
  if (!/^[a-f0-9]{24}$/.test(info?.token || '') || !pidDead(info.pid) || Date.now() - stat.mtimeMs <= staleMs) return false
  const claim = `${lockFile}.reclaim-${crypto.createHash('sha256').update(raw).digest('hex')}`
  let fd
  try { fd = fs.openSync(claim, 'wx') } catch { return false }
  try {
    try {
      if (fs.readFileSync(lockFile, 'utf8') !== raw || !pidDead(info.pid)) return false
      fs.rmSync(lockFile)
      return true
    } catch { return false }
  } finally {
    fs.closeSync(fd)
    try { fs.rmSync(claim, { force: true }) } catch { /* 保留未知状态 */ }
  }
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
  const { fileLockPollMs: pollMs } = tuning()
  while (true) {
    if (tryCreate(lockFile, token)) return token
    if (reclaimDead(lockFile, staleMs)) continue
    if (Date.now() >= deadline) throw new Error(`等待文件锁超时: ${lockFile}`)
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

async function acquireAsync(lockFile, { timeoutMs, staleMs }) {
  const token = newToken()
  const deadline = Date.now() + timeoutMs
  const { fileLockPollMs: pollMs } = tuning()
  while (true) {
    if (tryCreate(lockFile, token)) return token
    if (reclaimDead(lockFile, staleMs)) continue
    if (Date.now() >= deadline) throw new Error(`等待文件锁超时: ${lockFile}`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
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

// Durable spawn receipts are separate from discovery, which is only observational.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// Retry only unavailable queries, never substitute a PID or a different marker.
// A successful but different identity is returned immediately to fail comparisons.
export function queryWindowsIdentity(script, validate, run = spawnSync) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const value = typeof r.stdout === 'string' ? r.stdout.trim() : ''
      if (r.status === 0 && validate(value)) return value
    } catch { /* transient launch failure is not proof */ }
  }
  return null
}

export function marker(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const v = queryWindowsIdentity(`$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString()`, value => /^\d+$/.test(value))
      return v ? `win:${v}` : null
    }
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return fields[19] && boot ? `linux:${boot}:${fields[19]}` : null
    }
  } catch {}
  return null
}
/**
 * 异步版 marker：Windows 上用异步 spawn 调 PowerShell，避免 spawnSync 阻塞事件循环。
 * 返回格式与 marker() 完全一致，可与同步结果互相比对。
 *
 * 动机（2026-11-04 实测）：marker() 在 Windows 单次约 900ms，且 spawnSync 阻塞
 * 事件循环，导致 broker 并发拉起多个服务时完全串行化。异步版让多个身份查询并行。
 */
export async function markerAsync(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform !== 'win32') return marker(pid)
  const v = await queryWindowsIdentityAsync(
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString()`,
    (value) => /^\d+$/.test(value),
  )
  return v ? `win:${v}` : null
}

/** 与 queryWindowsIdentity 同语义（最多 3 次重试），但用异步 spawn。 */
export async function queryWindowsIdentityAsync(script, validate, attemptLimit = 3) {
  const once = () => new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(undefined)
    }, 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => finish(undefined))
    child.on('close', (code) => {
      const value = out.trim()
      finish(code === 0 && validate(value) ? value : undefined)
    })
  })

  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    const v = await once()
    if (v !== undefined) return v
  }
  return null
}

export function absent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}
export function receiptDir(discovery) { return `${discovery}.ownership` }
export function receiptPath(discovery, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('invalid service id')
  return path.join(receiptDir(discovery), `${id}.json`)
}
export function writeReceipt(discovery, id, value) {
  const file = receiptPath(discovery, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
}
export function removeReceipt(discovery, id) {
  try { fs.unlinkSync(receiptPath(discovery, id)) } catch (e) { if (e.code !== 'ENOENT') throw e }
}

export function remainingReceipts(discovery) {
  try { return fs.readdirSync(receiptDir(discovery)).map(name => `ownership:${name}:unresolved`) }
  catch (e) { return e.code === 'ENOENT' ? ['ownership:missing'] : ['ownership:unreadable'] }
}

export function canConnect(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { socket.destroy() } catch { /* 已销毁 */ } resolve(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function portList(value) {
  return Object.values(value || {}).filter((port) => Number.isSafeInteger(port) && port > 0)
}

/**
 * A dead root alone cannot prove its descendants are gone, so a receipt is
 * normally kept as evidence. The exception we can verify: the root is absent
 * and none of the service's declared ports is listening. An orphan that no
 * longer serves the declared port cannot be the service we were asked to run.
 * Any listener on those ports keeps the receipt (fail closed).
 */
export async function receiptResolvable(receipt, ports) {
  if (!receipt || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) return false
  if (!absent(receipt.pid)) return false
  const list = portList(ports ?? receipt.ports)
  if (!list.length) return false
  for (const port of list) if (await canConnect(port)) return false
  return true
}

// Socket teardown can lag slightly behind process exit; give the OS a short,
// bounded window before declaring the port still owned by an unknown process.
export async function waitReceiptResolvable(receipt, ports, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await receiptResolvable(receipt, ports)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// Caller must serialize against starting a replacement broker and supply the
// identity captured when it spawned this broker. An absent PID alone is not a receipt.
export async function recoverServices(discovery, broker) {
  const unresolved = [], stopped = []
  if (!broker?.pid || !broker?.marker || !broker?.recoveryMarker || !absent(broker.pid)) return { stopped, unresolved: ['broker:not-confirmed-absent'] }
  let discovered = {}
  try { discovered = JSON.parse(fs.readFileSync(discovery, 'utf8'))?.services || {} } catch { /* discovery 缺失时只能依赖收据自身 */ }
  let entries
  try { entries = fs.readdirSync(receiptDir(discovery)) } catch (e) {
    return { stopped, unresolved: [e.code === 'ENOENT' ? 'ownership:missing' : 'ownership:unreadable'] }
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) { unresolved.push(`ownership:${name}:unrecognized`); continue }
    let r
    try { r = JSON.parse(fs.readFileSync(path.join(receiptDir(discovery), name), 'utf8')) } catch { unresolved.push(`ownership:${name}:unreadable`); continue }
    if (!r || `${r.id}.json` !== name || !/^[a-z0-9][a-z0-9._-]*$/i.test(r.id) || r.brokerPid !== broker.pid || r.brokerMarker !== broker.recoveryMarker || r.state !== 'spawned' || !Number.isSafeInteger(r.pid) || r.pid <= 0 || !r.identity) {
      unresolved.push(`ownership:${name}:unverified`); continue
    }
    if (!absent(broker.pid)) { unresolved.push('broker:not-confirmed-absent'); break }
    if (absent(r.pid)) {
      // Dead root: only a receipt whose declared ports are all free can be
      // resolved; any listener may be an unverified descendant.
      if (await waitReceiptResolvable(r, discovered[r.id]?.ports)) {
        removeReceipt(discovery, r.id)
        stopped.push(r.id)
      } else unresolved.push(`service:${r.id}:already-exited-descendants-unverified`)
      continue
    }
    if (!absent(r.pid)) {
      if (marker(r.pid) !== r.identity) { unresolved.push(`service:${r.id}:identity-unverified`); continue }
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(r.pid), '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
        if (result.status !== 0 && !absent(r.pid)) { unresolved.push(`service:${r.id}:stop-failed`); continue }
      } else {
        try { process.kill(r.pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') { unresolved.push(`service:${r.id}:stop-failed`); continue } }
      }
      for (let i = 0; i < 50 && !absent(r.pid); i++) await new Promise(resolve => setTimeout(resolve, 100))
      if (!absent(r.pid)) { unresolved.push(`service:${r.id}:still-running`); continue }
    }
    // Root exit alone does not prove its descendants exited. It is safe to
    // resolve once none of the declared ports is still listening; otherwise
    // keep the receipt as evidence (fail closed).
    if (await waitReceiptResolvable(r, discovered[r.id]?.ports)) {
      removeReceipt(discovery, r.id)
      stopped.push(r.id)
    } else unresolved.push(`service:${r.id}:descendants-unverified`)
  }
  return { stopped, unresolved }
}

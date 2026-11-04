import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { queryWindowsIdentity } from '../../dsh-service-broker/lib/recovery.mjs'

// A PID alone is not an identity. Fail closed when the OS cannot supply a
// process creation marker; old state files deliberately have no authority.
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`
      const marker = queryWindowsIdentity(script, value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value))
      return marker ? { pid, marker } : null
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return fields[19] && boot ? { pid, marker: `${boot}:${fields[19]}` } : null
    }
  } catch { /* unavailable is not proof */ }
  return null
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function verifiedKill(identity) {
  const pid = identity?.pid
  if (!processAlive(pid)) return { ok: true, reason: 'exited' }
  const actual = processIdentity(pid)
  if (!identity?.marker || !actual || actual.marker !== identity.marker) return { ok: false, reason: 'identity-unverified' }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    return { ok: result.status === 0 || !processAlive(pid), reason: result.status === 0 ? 'signalled' : 'kill-failed' }
  }
  try { process.kill(pid, 'SIGTERM'); return { ok: true, reason: 'signalled' } } catch { return { ok: !processAlive(pid), reason: 'kill-failed' } }
}

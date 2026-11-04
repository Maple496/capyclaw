/**
 * dshd 运行态：launcher 自己的事实表（与 broker 的 discovery 分工不同——
 * 这里记「launcher 拉起的进程」：broker、dsh(auth-proxy)、端口、日志落点；
 * 各服务的运行事实仍归 broker 的 discovery（services.json），不在这里重复。
 *
 * 口径与全仓一致：原子写（唯一 tmp + rename）；损坏 = 空表（诚实降级）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const STATE_VERSION = 1

export function stateFile(stateDir) {
  return path.join(stateDir, 'state.json')
}

export function logsDir(stateDir) {
  return path.join(stateDir, 'logs')
}

export function discoveryFile(stateDir) {
  return path.join(stateDir, 'services.json')
}

export function dshLockFile(stateDir) {
  return path.join(stateDir, 'dsh.auth-proxy.lock')
}

/** 守护进程单实例锁：两个 --foreground 同时盯一份 state 会互相抢重启。 */
export function supervisorFile(stateDir) {
  return path.join(stateDir, 'supervisor.json')
}

/** 启动互斥锁：两个 start 并发冷启会各拉一套 broker/dsh（端口不同、互不知情）。 */
export function startLockFile(stateDir) {
  return path.join(stateDir, 'start.lock')
}

export async function loadState(stateDir) {
  try {
    const raw = JSON.parse(await readFile(stateFile(stateDir), 'utf8'))
    return raw?.version === STATE_VERSION && raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

export async function saveState(stateDir, data) {
  await mkdir(stateDir, { recursive: true })
  const file = stateFile(stateDir)
  const tmp = path.join(stateDir, `.state.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await writeFile(tmp, JSON.stringify({ ...data, version: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function clearState(stateDir) {
  try { await rm(stateFile(stateDir), { force: true }) } catch { /* 尽力清 */ }
  // 注意：不清 supervisor.json——守护锁的生命周期由守护自己管，
  // stop 需要靠它找到并停掉守护，否则守护会把 dsh 复活。
}

export async function loadSupervisor(stateDir) {
  try {
    const raw = JSON.parse(await readFile(supervisorFile(stateDir), 'utf8'))
    return Number.isInteger(raw?.pid) && raw.pid > 0 ? raw : null
  } catch {
    return null
  }
}

export async function saveSupervisor(stateDir, data) {
  await mkdir(stateDir, { recursive: true })
  const file = supervisorFile(stateDir)
  const tmp = path.join(stateDir, `.supervisor.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await writeFile(tmp, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function clearSupervisor(stateDir, pid) {
  try {
    const current = await loadSupervisor(stateDir)
    if (!current || (pid != null && current.pid !== pid)) return
    await rm(supervisorFile(stateDir), { force: true })
  } catch { /* 尽力清 */ }
}

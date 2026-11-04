/**
 * dsh-state-service —— 插件运行状态标准件。
 *
 * 提供：
 *   - FileStateBackend：原子 JSON 状态 + append-only journal（2MB 轮转）+ 命名 checkpoint
 *   - PersistentStore：在任意 backend 上的通用状态门面
 *   - replayPending：崩溃后重放未完成批次
 *
 * 与 workspace-service 的分工：
 *   workspace 管“作品文件”（work manifest / 版本 / 归属）；
 *   state 管“插件运行状态”（doc / journal / checkpoint / recovery）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createServiceApi } from './kit/service/api.mjs'

export class FileStateBackend {
  /* journalMaxBytes 默认 512KB 由 NSGA-II 进化搜索固化（evolution/，2026-11-01）：
   * 尾读 p95 4.3→1.9ms、磁盘占用 -33%、追加吞吐 +8%，恢复 0 失败。 */
  constructor(file, { initialDoc = {}, journalMaxBytes = 512 * 1024 } = {}) {
    if (!file) throw new Error('FileStateBackend 需要 file')
    this.file = file
    this.dir = path.dirname(file)
    this.journalFile = path.join(this.dir, 'journal.jsonl')
    this.checkpointDir = path.join(this.dir, 'checkpoints')
    this.initialDoc = initialDoc
    this.journalMaxBytes = Math.max(64 * 1024, Number(journalMaxBytes) || 512 * 1024)
    /** 最近一次读状态失败的原因；ENOENT 不算错误。 */
    this.lastStateError = null
  }

  readState() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      this.lastStateError = { code: 'STATE_IO', message: error.message }
      return null
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...structuredClone(this.initialDoc), ...parsed }
      }
      throw new Error('state 根节点不是 object')
    } catch (error) {
      /* 坏状态不能静默当成空库：先隔离原文件，避免下一次保存直接覆盖证据。 */
      this.lastStateError = { code: 'STATE_CORRUPT', message: error.message }
      const quarantine = `${this.file}.corrupt-${Date.now()}`
      try { fs.renameSync(this.file, quarantine) } catch { /* 隔离失败也要保持只读语义 */ }
      console.error(`[state-service] state 损坏，已隔离到 ${quarantine}: ${error.message}`)
      return null
    }
  }

  writeState(doc) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    fs.writeFileSync(tmp, JSON.stringify(doc))
    try {
      const fd = fs.openSync(tmp, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch { /* fsync 在部分文件系统不可用 */ }
    fs.renameSync(tmp, this.file)
  }

  appendJournal(event) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.journalFile, JSON.stringify({ ...event, ts: Date.now() / 1000 }) + '\n')
      if (fs.statSync(this.journalFile).size > this.journalMaxBytes) {
        const rotated = this.journalFile + '.1'
        try { fs.rmSync(rotated, { force: true }) } catch { /* 忽略 */ }
        try { fs.renameSync(this.journalFile, rotated) } catch (error) {
          console.error('[state-service] journal 轮转失败（继续追加）:', error.message)
        }
      }
    } catch { /* journal 失败不阻塞主状态 */ }
  }

  journalTail(limit = 8) {
    const read = (file) => {
      try {
        return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      } catch { return [] }
    }
    /* 轮转后的 .1 仍是最近历史的一部分，tail 必须跨文件读取。 */
    const lines = [...read(this.journalFile + '.1'), ...read(this.journalFile)]
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { type: 'invalid', raw: line.slice(0, 120) } }
    })
  }

  writeCheckpoint(name, payload) {
    const safe = checkpointName(name)
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const file = path.join(this.checkpointDir, safe + '.json')
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, file)
  }

  listCheckpoints() {
    try {
      return fs.readdirSync(this.checkpointDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            const payload = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, name), 'utf8'))
            return {
              name: payload.name,
              seq: payload.seq,
              appliedSeq: payload.appliedSeq,
              pending: !!payload.pending,
              title: payload.title,
              slides: payload.slides,
              createdAt: payload.createdAt,
              meta: payload.meta || {},
            }
          } catch { return null }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    } catch { return [] }
  }

  readCheckpoint(name) {
    return JSON.parse(fs.readFileSync(path.join(this.checkpointDir, checkpointName(name) + '.json'), 'utf8'))
  }
}

export function checkpointName(name) {
  const safe = String(name || '')
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safe)) throw new Error('checkpoint 名称必须是 1-64 位字母/数字/._-')
  return safe
}

/** 通用状态门面：业务 store 可以继承它，只写领域方法。 */
export class PersistentStore {
  constructor({ backend, initialDoc = {} }) {
    if (!backend) throw new Error('PersistentStore 需要 backend')
    this.backend = backend
    this.doc = backend.readState() || { ...structuredClone(initialDoc) }
  }

  get() { return this.doc }

  save() {
    this.backend.writeState(this.doc)
    return this.doc
  }

  journal(event) {
    this.backend.appendJournal(event)
  }

  journalTail(limit = 8) {
    return this.backend.journalTail(limit)
  }

  checkpoint(name, payload, meta = {}) {
    const safe = checkpointName(name)
    const body = {
      name: safe,
      ...payload,
      meta: meta && typeof meta === 'object' ? meta : {},
      createdAt: new Date().toISOString(),
    }
    this.backend.writeCheckpoint(safe, body)
    this.journal({ type: 'checkpoint', name: safe })
    return body
  }

  listCheckpoints() {
    return this.backend.listCheckpoints()
  }

  readCheckpoint(name) {
    return this.backend.readCheckpoint(name)
  }
}

/**
 * 崩溃恢复：把未完成批次交给 apply 重放，然后回执。
 * @param {{ store: object, pending: () => any, apply: (cmd:any) => Promise<void>|void }} options
 */
export async function replayPending({ store, pending, apply }) {
  const item = pending()
  if (!item) return { recovered: 0, seq: 0, error: '' }
  let recovered = 0
  let error = ''
  for (const cmd of item.cmds || []) {
    try {
      await apply(cmd)
      recovered++
    } catch (e) {
      error = String((e && e.message) || e)
      break
    }
  }
  store.applyServer(item.seq, recovered, error)
  return { seq: item.seq, recovered, error }
}

export function createFileBackend(file, options = {}) {
  return new FileStateBackend(file, options)
}

export function createStateHost(config = {}) {
  return {
    api: createServiceApi('state', '1.0.0', ['file-backend', 'journal', 'checkpoint', 'recovery']),
    version: '0.1.0',
    FileStateBackend,
    PersistentStore,
    createFileBackend,
    createStore({ backend, initialDoc = config.initialDoc || {} }) {
      return new PersistentStore({ backend, initialDoc })
    },
    replayPending,
  }
}

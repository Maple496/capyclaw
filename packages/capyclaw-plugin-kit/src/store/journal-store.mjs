/** 通用耐久状态存储：原子 JSON 快照 + append-only journal + 命名 checkpoint。 */
import fs from 'node:fs'
import path from 'node:path'
import { tuning } from '../tuning.mjs'

export class JournalStore {
  constructor({ file, initialDoc = {} }) {
    this.file = file
    this.dir = path.dirname(file)
    this.journalFile = path.join(this.dir, 'journal.jsonl')
    this.checkpointDir = path.join(this.dir, 'checkpoints')
    this.doc = this._load(initialDoc)
  }

  _load(initialDoc) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...initialDoc, ...parsed }
      }
    } catch { /* 缺文件/坏 JSON = 初始空态 */ }
    return { ...initialDoc }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.doc))
    fs.renameSync(tmp, this.file)
    return this.doc
  }

  get() { return this.doc }

  journal(event) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.journalFile, JSON.stringify({ ...event, ts: Date.now() / 1000 }) + '\n')
      if (fs.statSync(this.journalFile).size > tuning().journalMaxBytes) {
        const rotated = this.journalFile + '.1'
        try { fs.rmSync(rotated, { force: true }) } catch { /* 忽略 */ }
        fs.renameSync(this.journalFile, rotated)
      }
    } catch { /* journal 失败不阻塞主状态 */ }
  }

  journalTail(limit = tuning().journalTailLimit) {
    try {
      const lines = fs.readFileSync(this.journalFile, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      return lines.slice(-limit).map((line) => {
        try { return JSON.parse(line) } catch { return { type: 'invalid', raw: line.slice(0, 120) } }
      })
    } catch { return [] }
  }

  checkpoint(name, snapshot, meta = {}) {
    const safe = String(name || '')
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safe)) throw new Error('checkpoint 名称必须是 1-64 位字母/数字/._-')
    fs.mkdirSync(this.checkpointDir, { recursive: true })
    const file = path.join(this.checkpointDir, safe + '.json')
    const payload = { name: safe, snapshot, meta: meta && typeof meta === 'object' ? meta : {}, createdAt: new Date().toISOString() }
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, file)
    this.journal({ type: 'checkpoint', name: safe })
    return { name: safe, createdAt: payload.createdAt, meta: payload.meta }
  }

  listCheckpoints() {
    try {
      return fs.readdirSync(this.checkpointDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            const payload = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, name), 'utf8'))
            return { name: payload.name, createdAt: payload.createdAt, meta: payload.meta || {} }
          } catch { return null }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    } catch { return [] }
  }

  readCheckpoint(name) {
    const safe = String(name || '')
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safe)) throw new Error('checkpoint 名称必须是 1-64 位字母/数字/._-')
    return JSON.parse(fs.readFileSync(path.join(this.checkpointDir, safe + '.json'), 'utf8'))
  }
}

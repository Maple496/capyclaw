/**
 * 桥存储（Node 版）：backend/data_local.py 桥文档语义 + backend/sanitize.py
 * 白名单的忠实移植。单文档哑存储，JSON 文件原子落盘；指令语义不在这里
 * 解释（op 分发归编辑器 / PptApp）。
 *
 * 契约（与桌面网关同形状，见 ppt-bridge/contract/ops.json 与 README）：
 *   push  = 整队替换 + seq 自增（回执字段清零）
 *   ack   = 回执落档，仅对当前 seq 生效；过期 seq 原样返回现文档
 *   state = 编辑器 → agent 的 deck 全量镜像（state_seq 标记对应指令序号）
 *   shot  = shot_req 自增请求；回传仅当 req 匹配
 *   claim = owner 租约（心跳 3s / TTL 15s）；release 释放
 */
import fs from 'node:fs'
import path from 'node:path'

export const MAX_CMDS = 100               // 单队指令条数上限
export const MAX_TOTAL = 8 * 1024 * 1024  // 单队总量上限（字节）
export const MAX_SHOT = 4 * 1024 * 1024   // 截图 dataURL 上限
export const OWNER_TTL = 15.0             // owner 租约秒数（心跳 3s）

const EMPTY_DOC = () => ({
  seq: 0, cmds: [], title: '',
  applied_seq: 0, applied: 0, error: '', updated: 0,
  shot_req: 0, shot: { req: 0, data: '' },
})

const isInt = (v) => typeof v === 'number' && Number.isInteger(v)
const isCount = (v) => isInt(v) && v >= 0 // bool 不是 number，天然拒绝

/* ---- 白名单（sanitize.py 对应移植；畸形一律返回 null → HTTP 400）---- */

export function sanitizePush(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const cmds = body.cmds
  if (!Array.isArray(cmds) || cmds.length < 1 || cmds.length > MAX_CMDS) return null
  let total = 0
  for (const c of cmds) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    total += JSON.stringify(c).length
    if (total > MAX_TOTAL) return null
  }
  const title = body.title
  if (title != null && (typeof title !== 'string' || title.length > 120)) return null
  return { cmds, title: title || '' }
}

export function sanitizeAck(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const out = {}
  for (const f of ['seq', 'applied']) {
    if (!isCount(body[f])) return null
    out[f] = body[f]
  }
  const err = body.error
  if (err != null && (typeof err !== 'string' || err.length > 2000)) return null
  out.error = err || ''
  return out
}

export function sanitizeState(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const deck = body.deck
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) return null
  if (JSON.stringify(deck).length > MAX_TOTAL) return null
  const seq = body.seq
  if (seq != null && !isCount(seq)) return null
  return { deck, seq: seq ?? null }
}

export function sanitizeShotResult(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!isCount(body.req)) return null
  const data = body.data
  if (typeof data !== 'string' || data.length > MAX_SHOT) return null
  if (data && !data.startsWith('data:image/')) return null
  return { req: body.req, data }
}

export function sanitizeClaim(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const id = body.id
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) return null
  return { id }
}

/* ---- 存储：内存单文档 + 原子落盘 ---- */

export class BridgeStore {
  constructor(file) {
    this.file = file
    this.doc = this._load()
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.assign(EMPTY_DOC(), parsed)
      }
    } catch (e) { /* 缺行/坏 JSON = 零位空态诚实返回 */ }
    return EMPTY_DOC()
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.doc))
    fs.renameSync(tmp, this.file)
  }

  get() { return this.doc }

  push(cmds, title) {
    Object.assign(this.doc, {
      seq: (this.doc.seq | 0) + 1, cmds, title,
      applied_seq: 0, applied: 0, error: '', updated: Date.now() / 1000,
    })
    this._save()
    return this.doc
  }

  ack(seq, applied, error) {
    if ((this.doc.seq | 0) !== seq) return this.doc
    Object.assign(this.doc, { applied_seq: seq, applied, error, updated: Date.now() / 1000 })
    this._save()
    return this.doc
  }

  state(deck, seq) {
    this.doc.deck = deck
    if (seq != null) this.doc.state_seq = seq
    this.doc.updated = Date.now() / 1000
    this._save()
    return this.doc
  }

  shotRequest() {
    this.doc.shot_req = (this.doc.shot_req | 0) + 1
    this.doc.shot = { req: 0, data: '' }
    this.doc.updated = Date.now() / 1000
    this._save()
    return this.doc
  }

  shotResult(req, data) {
    if ((this.doc.shot_req | 0) !== req) return this.doc
    this.doc.shot = { req, data }
    this.doc.updated = Date.now() / 1000
    this._save()
    return this.doc
  }

  claim(id) {
    const cur = this.doc.owner
    const now = Date.now() / 1000
    if (!cur || !cur.id || cur.id === id || now - (cur.ts || 0) > OWNER_TTL) {
      this.doc.owner = { id, ts: now }
      this._save()
      return { ok: true, owner: id }
    }
    return { ok: false, owner: cur.id }
  }

  release(id) {
    if (this.doc.owner && this.doc.owner.id === id) {
      delete this.doc.owner
      this._save()
    }
    return { ok: true }
  }
}

/**
 * 版本化文档会话：把协议白名单、状态迁移、持久化、journal、checkpoint、
 * owner 租约组合成稳定的 DocumentSession API。
 *
 * 领域文档放在 documentKey 下；summary/onApplied 由调用方提供。
 */
import {
  applyAck, applyPush, applyServer, applyShotRequest, applyShotResult,
  applyState, applyUi, createSessionState, pendingOf,
} from './state.mjs'
import { claimOwner, OWNER_TTL, ownerStatus, releaseOwner } from './lease.mjs'

export * from './state.mjs'
export * from './sanitize.mjs'
export * from './watch.mjs'
export { claimOwner, OWNER_TTL, ownerStatus, releaseOwner } from './lease.mjs'

export function checkpointName(name) {
  const safe = String(name || '')
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safe)) throw new Error('checkpoint 名称必须是 1-64 位字母/数字/._-')
  return safe
}

export class DocumentSession {
  constructor({
    backend,
    initialDoc = {},
    documentKey = 'document',
    summary = () => ({}),
    onApplied = null,
    checkpointDocument = null,
    stateCompact = true,
  } = {}) {
    if (!backend) throw new Error('DocumentSession 需要 backend')
    this.backend = backend
    this.documentKey = documentKey
    this.initialDoc = initialDoc
    this.summary = summary
    this.onApplied = onApplied
    this.checkpointDocument = checkpointDocument
    this.stateCompact = stateCompact !== false
    this.dir = backend.dir || ''
    this.file = backend.file || ''
    this.journalFile = backend.journalFile || ''
    this.checkpointDir = backend.checkpointDir || ''
    this._tail = Promise.resolve()
    this.doc = this._load()
    this._waiters = new Set()
  }

  /** 串行队列：前一个任务失败不会阻断后续任务。 */
  enqueue(task) {
    const run = this._tail.then(task, task)
    this._tail = run.then(() => undefined, () => undefined)
    return run
  }

  /* ---- 变更订阅：长轮询 / 工具等待即时唤醒（轮询兜底仍在） ---- */

  /** 订阅会话变更；返回退订函数。notify 在每次状态迁移后同步触发。 */
  subscribe(fn) {
    this._waiters.add(fn)
    return () => { this._waiters.delete(fn) }
  }

  _notify() {
    for (const fn of [...this._waiters]) {
      try { fn() } catch { /* 订阅方异常不阻塞状态迁移 */ }
    }
  }

  /** 等下一次变更或超时（事件先到即返回）：把「轮询粒度」从等待延迟里消掉。 */
  waitForChange(timeoutMs = 100) {
    return new Promise((resolve) => {
      let done = false
      const off = this.subscribe(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        off()
        resolve()
      })
      const timer = setTimeout(() => {
        if (done) return
        done = true
        off()
        resolve()
      }, Math.max(0, Number(timeoutMs) || 0))
    })
  }

  _journal(event) {
    try { this.backend.appendJournal?.(event) } catch { /* journal 失败不阻塞主状态 */ }
  }

  _journalTail(limit = 8) {
    try { return this.backend.journalTail?.(limit) || [] } catch { return [] }
  }

  _load() {
    let state = null
    try { state = this.backend.readState() } catch (error) {
      this.backend.lastStateError = { code: 'STATE_IO', message: error.message }
    }
    if (state) return createSessionState({ ...this.initialDoc, ...state })

    /* state 损坏时尝试从最新 checkpoint 恢复，而不是静默清空文档。 */
    if (this.backend.lastStateError?.code === 'STATE_CORRUPT'
      && typeof this.backend.listCheckpoints === 'function') {
      try {
        const latest = this.backend.listCheckpoints()[0]
        if (latest) {
          const payload = this.backend.readCheckpoint(latest.name)
          const value = payload?.[this.documentKey]
          if (payload && value) {
            const doc = createSessionState(this.initialDoc)
            doc[this.documentKey] = value
            doc.title = payload.title || doc.title || ''
            doc.seq = payload.seq | 0
            doc.applied_seq = payload.seq | 0
            doc.state_seq = payload.seq | 0
            console.error(`[document-workbench] state 损坏，已从 checkpoint ${latest.name} 恢复（seq=${payload.seq}）`)
            return doc
          }
        }
      } catch (error) {
        console.error('[document-workbench] checkpoint 恢复失败:', error.message)
      }
    }
    return createSessionState(this.initialDoc)
  }

  _save() {
    this.backend.writeState(this.doc)
  }

  get() { return this.doc }

  getDocument() { return this.doc[this.documentKey] ?? null }

  push(cmds, title) {
    applyPush(this.doc, cmds, title)
    this._save()
    this._journal({ type: 'push', seq: this.doc.seq, title, cmdCount: cmds.length, status: 'pending' })
    this._notify()
    return this.doc
  }

  /**
   * 服务端权威批次：push → 逐条 apply → view 命令交给 UI → applyServer。
   * 整批在串行队列内执行，并发 push 不会交叉改写 seq/document。
   */
  runBatch({ cmds, title, apply, isViewOp = () => false }) {
    return this.enqueue(async () => {
      const doc = this.push(cmds, title)
      const seq = doc.seq
      let applied = 0
      let error = ''
      const viewCmds = []
      for (const cmd of cmds) {
        if (isViewOp(cmd)) {
          viewCmds.push(cmd)
          applied++
          continue
        }
        try {
          await apply(cmd)
          applied++
        } catch (caught) {
          error = String((caught && caught.message) || caught)
          break
        }
      }
      if (viewCmds.length) this.uiCommand(viewCmds)
      this.applyServer(seq, applied, error)
      return this.get()
    })
  }

  applyServer(seq, applied, error) {
    applyServer(this.doc, seq, applied, error, {
      onApplied: this.onApplied,
      stateCompact: this.stateCompact,
    })
    this._save()
    this._journal({ type: 'applied', seq, applied, error: error || '' })
    this._notify()
    return this.doc
  }

  uiCommand(cmds) {
    applyUi(this.doc, cmds)
    this._save()
    this._journal({ type: 'ui', uiSeq: this.doc.ui_seq, cmdCount: cmds.length })
    this._notify()
    return this.doc
  }

  ack(seq, applied, error) {
    if ((this.doc.seq | 0) !== (seq | 0)) return this.doc
    applyAck(this.doc, seq, applied, error)
    this._save()
    this._notify()
    return this.doc
  }

  state(value, seq) {
    applyState(this.doc, value, seq, { documentKey: this.documentKey })
    this._save()
    this._notify()
    return this.doc
  }

  pending() {
    return pendingOf(this.doc)
  }

  checkpoint(name, meta = {}) {
    const safe = checkpointName(name)
    const pending = (this.doc.seq | 0) > (this.doc.applied_seq | 0)
    const summary = this.summary(this.doc) || {}
    const payload = {
      name: safe,
      seq: this.doc.seq | 0,
      appliedSeq: this.doc.applied_seq | 0,
      pending,
      ...summary,
      title: this.doc.title || summary.title || '',
      [this.documentKey]: this.doc[this.documentKey]
        ?? (this.checkpointDocument ? this.checkpointDocument(this.doc) : null),
      meta: meta && typeof meta === 'object' ? meta : {},
      createdAt: new Date().toISOString(),
    }
    this.backend.writeCheckpoint(payload.name, payload)
    this._journal({ type: 'checkpoint', name: payload.name, seq: payload.seq, pending: payload.pending })
    const { [this.documentKey]: _document, ...view } = payload
    return view
  }

  listCheckpoints() {
    return this.backend.listCheckpoints?.() || []
  }

  readCheckpoint(name) {
    const safe = checkpointName(name)
    const payload = this.backend.readCheckpoint?.(safe)
    if (!payload || !(this.documentKey in payload)) {
      throw new Error('checkpoint 内容损坏: ' + safe)
    }
    return payload
  }

  taskStatus() {
    const pending = this.pending()
    const checkpoints = this.listCheckpoints()
    const summary = this.summary(this.doc) || {}
    return {
      seq: this.doc.seq | 0,
      appliedSeq: this.doc.applied_seq | 0,
      stateSeq: this.doc.state_seq | 0,
      ...summary,
      title: this.doc.title || summary.title || '未命名',
      pending: !!pending,
      pendingCmds: pending ? pending.cmds.length : 0,
      lastError: this.doc.error || '',
      lastCheckpoint: checkpoints[0] || null,
      checkpoints: checkpoints.length,
      journal: this._journalTail(8),
      updated: this.doc.updated || 0,
    }
  }

  shotRequest() {
    applyShotRequest(this.doc)
    this._save()
    this._notify()
    return this.doc
  }

  shotResult(req, data) {
    applyShotResult(this.doc, req, data)
    this._save()
    this._notify()
    return this.doc
  }

  claim(id, force = false, meta = null) {
    const result = claimOwner(this.doc, id, force, meta)
    if (result.changed) {
      this._save()
      this._notify()
    }
    return { ok: result.ok, owner: result.owner }
  }

  release(id) {
    if (releaseOwner(this.doc, id)) {
      this._save()
      this._notify()
    }
    return { ok: true }
  }

  /**
   * 崩溃恢复：把未完成批次交给 apply 重放，然后回执。
   * 调用方应放在 enqueue 内，保证恢复期间的新 push 排队。
   */
  async recover({ apply, isViewOp = () => false } = {}) {
    const item = this.pending()
    if (!item) return { recovered: 0, seq: 0, error: '' }
    let recovered = 0
    let error = ''
    for (const cmd of item.cmds || []) {
      try {
        if (isViewOp(cmd)) this.uiCommand([cmd])
        else await apply(cmd)
        recovered++
      } catch (caught) {
        error = String((caught && caught.message) || caught)
        break
      }
    }
    this.applyServer(item.seq, recovered, error)
    return { seq: item.seq, recovered, error }
  }
}

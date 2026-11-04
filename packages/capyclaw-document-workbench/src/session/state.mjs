/**
 * 版本化文档会话的标准信封与纯状态迁移。
 *
 * 这层只认识 seq/cmds/ack/state/ui/shot/owner 这些协议字段；领域文档放在
 * 调用方指定的 documentKey 下，由 adapter 负责解释。
 */

export const SESSION_DEFAULTS = Object.freeze({
  seq: 0,
  cmds: [],
  title: '',
  applied_seq: 0,
  applied: 0,
  error: '',
  updated: 0,
  state_seq: 0,
  ui_seq: 0,
  ui: [],
  shot_req: 0,
  shot: { req: 0, data: '' },
})

export function nowSeconds() {
  return Date.now() / 1000
}

/** 创建一份带标准信封的会话状态；initial 可携带领域字段（deck/doc/value）。 */
export function createSessionState(initial = {}) {
  const source = initial && typeof initial === 'object' ? initial : {}
  return {
    ...structuredClone(SESSION_DEFAULTS),
    ...structuredClone(source),
    cmds: Array.isArray(source.cmds) ? structuredClone(source.cmds) : [],
    ui: Array.isArray(source.ui) ? structuredClone(source.ui) : [],
    shot: { ...SESSION_DEFAULTS.shot, ...(source.shot || {}) },
  }
}

function optionsOf(nowOrOptions) {
  return typeof nowOrOptions === 'number' ? { now: nowOrOptions } : (nowOrOptions || {})
}

/** 新批次入队：seq 自增，清空上批回执，保留领域文档。 */
export function applyPush(doc, cmds, title, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  Object.assign(doc, {
    seq: (doc.seq | 0) + 1,
    cmds: Array.isArray(cmds) ? cmds : [],
    title: title || '',
    applied_seq: 0,
    applied: 0,
    error: '',
    updated: opts.now ?? nowSeconds(),
  })
  return doc
}

/** 服务端执行完成：只有当前批次可以落回执。 */
export function applyServer(doc, seq, applied, error, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  if ((doc.seq | 0) !== (seq | 0)) return doc
  Object.assign(doc, {
    applied_seq: seq,
    applied: applied | 0,
    error: error || '',
    state_seq: seq,
    updated: opts.now ?? nowSeconds(),
  })
  if (typeof opts.onApplied === 'function') opts.onApplied(doc, seq)
  if (opts.stateCompact !== false) doc.cmds = []
  return doc
}

/** 编辑器回执：同样只接受当前批次。 */
export function applyAck(doc, seq, applied, error, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  if ((doc.seq | 0) !== (seq | 0)) return doc
  Object.assign(doc, {
    applied_seq: seq,
    applied: applied | 0,
    error: error || '',
    updated: opts.now ?? nowSeconds(),
  })
  return doc
}

/** 编辑器镜像：旧 seq 的镜像不能覆盖新文档。 */
export function applyState(doc, value, seq, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  if (seq != null && (seq | 0) < (doc.seq | 0)) return doc
  const key = opts.documentKey || 'document'
  doc[key] = value
  if (seq != null) doc.state_seq = seq | 0
  doc.updated = opts.now ?? nowSeconds()
  return doc
}

export function applyUi(doc, cmds, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  doc.ui_seq = (doc.ui_seq | 0) + 1
  doc.ui = Array.isArray(cmds) ? cmds : []
  doc.updated = opts.now ?? nowSeconds()
  return doc
}

export function applyShotRequest(doc, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  doc.shot_req = (doc.shot_req | 0) + 1
  doc.shot = { req: 0, data: '' }
  doc.updated = opts.now ?? nowSeconds()
  return doc
}

export function applyShotResult(doc, req, data, nowOrOptions = {}) {
  const opts = optionsOf(nowOrOptions)
  if ((doc.shot_req | 0) !== (req | 0)) return doc
  doc.shot = { req, data: data || '' }
  doc.updated = opts.now ?? nowSeconds()
  return doc
}

export function pendingOf(doc) {
  if ((doc.seq | 0) > (doc.applied_seq | 0) && Array.isArray(doc.cmds) && doc.cmds.length) {
    return { seq: doc.seq | 0, title: doc.title || '', cmds: doc.cmds }
  }
  return null
}

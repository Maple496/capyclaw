/** 桥协议白名单：畸形请求一律返回 null → HTTP 400。 */

export const DEFAULT_LIMITS = Object.freeze({
  maxCmds: 100,
  maxTotal: 8 * 1024 * 1024,
  maxShot: 4 * 1024 * 1024,
  maxTitle: 120,
  maxError: 2000,
  maxId: 64,
})

const isInt = (v) => typeof v === 'number' && Number.isInteger(v)
const isCount = (v) => isInt(v) && v >= 0

/**
 * 生成一套通用桥请求校验器。documentKey 决定 /state 请求里领域文档的字段名：
 * PPT 用 deck，Canvas 用 document/doc。
 */
export function createSessionSanitizers({
  documentKey = 'document',
  maxCmds = DEFAULT_LIMITS.maxCmds,
  maxTotal = DEFAULT_LIMITS.maxTotal,
  maxShot = DEFAULT_LIMITS.maxShot,
  maxTitle = DEFAULT_LIMITS.maxTitle,
  maxError = DEFAULT_LIMITS.maxError,
  maxId = DEFAULT_LIMITS.maxId,
} = {}) {
  function sanitizePush(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const cmds = body.cmds
    if (!Array.isArray(cmds) || cmds.length > maxCmds) return null
    let total = 0
    for (const c of cmds) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return null
      total += JSON.stringify(c).length
      if (total > maxTotal) return null
    }
    const title = body.title
    if (title != null && (typeof title !== 'string' || title.length > maxTitle)) return null
    if (!cmds.length && !title) return null
    return { cmds, title: title || '' }
  }

  function sanitizeAck(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const out = {}
    for (const field of ['seq', 'applied']) {
      if (!isCount(body[field])) return null
      out[field] = body[field]
    }
    const error = body.error
    if (error != null && (typeof error !== 'string' || error.length > maxError)) return null
    out.error = error || ''
    return out
  }

  function sanitizeState(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const value = body[documentKey]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (JSON.stringify(value).length > maxTotal) return null
    const seq = body.seq
    if (seq != null && !isCount(seq)) return null
    return { value, seq: seq ?? null }
  }

  function sanitizeShotResult(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    if (!isCount(body.req)) return null
    const data = body.data
    if (typeof data !== 'string' || data.length > maxShot) return null
    if (data && !data.startsWith('data:image/')) return null
    return { req: body.req, data }
  }

  function sanitizeClaim(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const id = body.id
    if (typeof id !== 'string' || id.length < 1 || id.length > maxId) return null
    let meta = null
    if (body.meta != null) {
      if (typeof body.meta !== 'object' || Array.isArray(body.meta)) return null
      try {
        if (JSON.stringify(body.meta).length > 4096) return null
      } catch {
        return null
      }
      meta = body.meta
    }
    return { id, force: body.force === true, ...(meta ? { meta } : {}) }
  }

  return { sanitizePush, sanitizeAck, sanitizeState, sanitizeShotResult, sanitizeClaim }
}

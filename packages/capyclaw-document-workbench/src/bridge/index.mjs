/**
 * 文档桥路由：把 DocumentSession 暴露成与 PPT/Canvas 桥一致的 HTTP 端点。
 * 业务语义仍由 session 的 apply 与调用方的 projection 承担。
 */
import { intQ, readBody, send } from '@capyclaw/plugin-kit/service/http'
import { createSessionSanitizers } from '../session/sanitize.mjs'
import { ownerStatus } from '../session/lease.mjs'
import { watchSession } from '../session/watch.mjs'

function normalizeBase(basePath) {
  const value = String(basePath || '')
  if (!value || value === '/') return ''
  return value.replace(/\/+$/, '')
}

function errorStatus(error) {
  return error && error.code === 'BODY_TOO_LARGE' ? 413 : 400
}

export function createDocumentBridge({
  session,
  basePath = '',
  bridgeName = 'document-workbench',
  documentKey = null,
  documentPath = '/document',
  authority = 'server',
  apply = null,
  isViewOp = () => false,
  sanitizers = null,
  bodyLimitBytes = 10 * 1024 * 1024,
  watch = {},
  projectStatus = () => ({}),
  projectDocument = null,
  projectTaskStatus = null,
} = {}) {
  if (!session) throw new Error('createDocumentBridge 需要 session')
  if (authority !== 'server' && authority !== 'editor') {
    throw new Error('authority 只能是 server 或 editor')
  }
  if (authority === 'server' && typeof apply !== 'function') {
    throw new Error('server authority 需要 apply(cmd)')
  }

  const prefix = normalizeBase(basePath)
  const key = documentKey || session.documentKey || 'document'
  const sanitize = sanitizers || createSessionSanitizers({ documentKey: key })
  const documentEndpoint = documentPath || '/document'

  async function readJson(req, res) {
    try {
      return { ok: true, body: await readBody(req, bodyLimitBytes) }
    } catch (error) {
      send(req, res, errorStatus(error), { error: String(error.message || error) })
      return { ok: false }
    }
  }

  function statusBody(doc) {
    const owner = ownerStatus(doc)
    return {
      seq: doc.seq | 0,
      applied_seq: doc.applied_seq | 0,
      applied: doc.applied | 0,
      error: doc.error || '',
      shot_req: doc.shot_req | 0,
      shot: { req: (doc.shot && doc.shot.req) || 0 },
      state_seq: doc.state_seq | 0,
      ui_seq: doc.ui_seq | 0,
      owner,
      updated: doc.updated || 0,
      ...(projectStatus(doc) || {}),
    }
  }

  /** 长轮询轻量体：编辑器 pump 只消费这些字段。
   *  旧实现回整个信封——大镜像/截图 base64 每次拾取都白白传一轮。 */
  function watchBody(doc) {
    return {
      seq: doc.seq | 0,
      applied_seq: doc.applied_seq | 0,
      applied: doc.applied | 0,
      state_seq: doc.state_seq | 0,
      error: doc.error || '',
      title: doc.title || '',
      shot_req: doc.shot_req | 0,
      ui_seq: doc.ui_seq | 0,
      cmds: Array.isArray(doc.cmds) ? doc.cmds : [],
      ui: Array.isArray(doc.ui) ? doc.ui : [],
    }
  }

  /** push 回执轻量体：调用方只用 seq/回执字段，不需要镜像。 */
  function pushBody(doc) {
    return {
      seq: doc.seq | 0,
      applied_seq: doc.applied_seq | 0,
      applied: doc.applied | 0,
      error: doc.error || '',
    }
  }

  function documentBody(doc) {
    if (projectDocument) return projectDocument(doc)
    return {
      [key]: doc[key] || {},
      state_seq: doc.state_seq | 0,
      applied_seq: doc.applied_seq | 0,
    }
  }

  const route = async (req, res, u) => {
    const pathname = u.pathname
    if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) return false
    const sub = prefix ? pathname.slice(prefix.length) : pathname

    /* 主端点：push / read */
    if (sub === '' || sub === '/') {
      if (req.method === 'POST') {
        const parsed = await readJson(req, res)
        if (!parsed.ok) return true
        const data = sanitize.sanitizePush(parsed.body)
        if (!data) {
          send(req, res, 400, { error: `${bridgeName} 数据不合法` })
          return true
        }
        const doc = authority === 'editor'
          ? await session.enqueue(() => session.push(data.cmds, data.title))
          : await session.runBatch({ cmds: data.cmds, title: data.title, apply, isViewOp })
        send(req, res, 200, pushBody(doc))
        return true
      }
      /* GET 全量信封：编辑器 restore（镜像恢复）专用。 */
      send(req, res, 200, session.get())
      return true
    }

    if (sub === '/ui' && (req.method === 'GET' || req.method === 'HEAD')) {
      const doc = session.get()
      send(req, res, 200, { ui_seq: doc.ui_seq | 0, ui: Array.isArray(doc.ui) ? doc.ui : [] })
      return true
    }

    if (sub === '/task/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(req, res, 200, projectTaskStatus ? projectTaskStatus(session.get()) : session.taskStatus())
      return true
    }
    if (sub === '/task/checkpoints' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(req, res, 200, { checkpoints: session.listCheckpoints() })
      return true
    }
    if (sub === '/task/checkpoint' && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = u.searchParams.get('name')
      if (!name) {
        send(req, res, 400, { error: '缺少 checkpoint name' })
        return true
      }
      try { send(req, res, 200, session.readCheckpoint(name)) }
      catch (error) { send(req, res, 404, { error: String(error.message || error) }) }
      return true
    }
    if (sub === '/task/checkpoint' && req.method === 'POST') {
      const parsed = await readJson(req, res)
      if (!parsed.ok) return true
      const body = parsed.body
      if (!body || typeof body.name !== 'string' || !body.name) {
        send(req, res, 400, { error: '缺少 checkpoint name' })
        return true
      }
      try {
        const payload = await session.enqueue(() => session.checkpoint(body.name, body.meta || {}))
        send(req, res, 200, payload)
      } catch (error) {
        send(req, res, 409, { error: String(error.message || error) })
      }
      return true
    }

    if (sub === '/watch' && (req.method === 'GET' || req.method === 'HEAD')) {
      let aborted = false
      req.on('close', () => { aborted = true })
      const doc = await watchSession(session, {
        seq: intQ(u, 'seq'),
        shot: intQ(u, 'shot'),
        ui: intQ(u, 'ui'),
        timeoutS: u.searchParams.get('timeout'),
        isAborted: () => aborted,
        ...watch,
      })
      if (aborted || res.writableEnded || res.destroyed) return true
      send(req, res, 200, watchBody(doc))
      return true
    }

    if (sub === '/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(req, res, 200, statusBody(session.get()))
      return true
    }
    if (sub === '/shot' && (req.method === 'GET' || req.method === 'HEAD')) {
      const doc = session.get()
      send(req, res, 200, {
        req: (doc.shot && doc.shot.req) || 0,
        data: (doc.shot && doc.shot.data) || '',
      })
      return true
    }
    if (sub === documentEndpoint && (req.method === 'GET' || req.method === 'HEAD')) {
      send(req, res, 200, documentBody(session.get()))
      return true
    }

    if (req.method !== 'POST') {
      send(req, res, 404, { error: 'not found' })
      return true
    }
    const parsed = await readJson(req, res)
    if (!parsed.ok) return true

    if (sub === '/claim') {
      const data = sanitize.sanitizeClaim(parsed.body)
      if (!data) {
        send(req, res, 400, { error: `${bridgeName} 所有权声明不合法` })
        return true
      }
      send(req, res, 200, session.claim(data.id, data.force, data.meta))
      return true
    }
    if (sub === '/release') {
      const data = sanitize.sanitizeClaim(parsed.body)
      if (!data) {
        send(req, res, 400, { error: `${bridgeName} 所有权声明不合法` })
        return true
      }
      send(req, res, 200, session.release(data.id))
      return true
    }
    if (sub === '/ack') {
      const data = sanitize.sanitizeAck(parsed.body)
      if (!data) {
        send(req, res, 400, { error: `${bridgeName} 回执不合法` })
        return true
      }
      await session.enqueue(() => session.ack(data.seq, data.applied, data.error))
      send(req, res, 200, { ok: true })
      return true
    }
    if (sub === '/state') {
      const data = sanitize.sanitizeState(parsed.body)
      if (!data) {
        send(req, res, 400, { error: `${bridgeName} 状态不合法` })
        return true
      }
      const value = data.value !== undefined ? data.value : data[key]
      await session.enqueue(() => session.state(value, data.seq))
      /* 编辑器刚上传完全量镜像，不能再把整份回传给它——轻量确认即可。 */
      send(req, res, 200, { ok: true, state_seq: session.get().state_seq | 0 })
      return true
    }
    if (sub === '/shot-request') {
      session.shotRequest()
      send(req, res, 200, { ok: true, shot_req: session.get().shot_req | 0 })
      return true
    }
    if (sub === '/shot-result') {
      const data = sanitize.sanitizeShotResult(parsed.body)
      if (!data) {
        send(req, res, 400, { error: `${bridgeName} 截图回传不合法` })
        return true
      }
      session.shotResult(data.req, data.data)
      send(req, res, 200, { ok: true })
      return true
    }

    send(req, res, 404, { error: 'not found' })
    return true
  }

  return { routes: [route], handle: route, documentKey: key, basePath: prefix }
}

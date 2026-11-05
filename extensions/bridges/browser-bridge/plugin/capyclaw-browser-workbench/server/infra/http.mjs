/** 本机插件 HTTP 传输：安全响应头、body 上限、查询解析、loopback 监听。 */
import http from 'node:http'
import { tuning } from './tuning.mjs'

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store, no-cache, must-revalidate',
}

/** 客户端已断开时放弃写入：长请求（截图/长轮询）在 handler 完成前客户端超时
 * 断连是常态，写已销毁的 socket 会触发无人监听的 'error' 事件打崩进程。 */
function resDead(res) {
  return res.destroyed || res.writableEnded
}

export function send(req, res, code, obj, extraHeaders = {}) {
  if (resDead(res)) return
  const body = obj === undefined ? '' : JSON.stringify(obj)
  try {
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...SECURITY_HEADERS,
      ...extraHeaders,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch { /* socket 已死：响应无人接收，静默放弃 */ }
}

export function sendText(req, res, code, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  if (resDead(res)) return
  const body = text === undefined || text === null ? '' : String(text)
  try {
    res.writeHead(code, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      ...SECURITY_HEADERS,
      ...extraHeaders,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch { /* socket 已死：响应无人接收，静默放弃 */ }
}

function bodyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        /* 先让路由回 413；立即 destroy 会让客户端只看到 connection reset。 */
        fail(bodyError('BODY_TOO_LARGE', 'body too large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(bodyError('BAD_JSON', 'bad json')) }
    })
    req.on('error', (error) => fail(error))
    /* 客户端中途断连且未触发 error/aborted 时（如 curl -m 超时），close 兜底，
       否则 promise 永远 pending，handler 泄漏。 */
    req.on('close', () => {
      if (!req.readableEnded) fail(bodyError('CLIENT_ABORTED', 'client aborted'))
    })
  })
}

export function intQ(url, name) {
  const value = parseInt(url.searchParams.get(name) || '0', 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function listen(port, opts = {}) {
  const defaults = tuning()
  const {
    host = '127.0.0.1',
    requestTimeoutMs = defaults.requestTimeoutMs,
    headersTimeoutMs = defaults.headersTimeoutMs,
    keepAliveTimeoutMs = defaults.keepAliveTimeoutMs,
    handler,
  } = opts
  return new Promise((resolve, reject) => {
    const server = handler ? http.createServer(handler) : http.createServer()
    server.requestTimeout = requestTimeoutMs
    server.headersTimeout = headersTimeoutMs
    server.keepAliveTimeout = keepAliveTimeoutMs
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    server.on('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

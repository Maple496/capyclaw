/**
 * 独立 HTTP 服务通用启动器：loopback bind、标准 healthz、HTTP 超时与关闭。
 * 业务路由/认证/静态文件白名单仍由服务自己实现。
 */
import { listen, send } from './http.mjs'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * @param {object} options
 * @param {string} options.service 服务 id（broker spec.id）
 * @param {number} [options.port=0] 0 表示让 OS 分配端口
 * @param {string} [options.host='127.0.0.1'] 仅允许 loopback
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => any} options.handler 业务路由
 * @param {() => object|Promise<object>} [options.health] healthz 的额外字段
 * @param {string} [options.healthPath='/healthz']
 */
export async function startStandaloneService(options = {}) {
  const {
    service,
    port = 0,
    host = '127.0.0.1',
    handler,
    health = () => ({}),
    healthPath = '/healthz',
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs,
  } = options

  if (typeof service !== 'string' || !service.trim()) throw new Error('startStandaloneService 需要 service id')
  if (!LOOPBACK.has(host)) throw new Error(`服务只能绑定 loopback 地址，收到: ${host}`)
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw new Error(`port 必须是 0-65535 整数: ${port}`)
  }
  if (typeof handler !== 'function') throw new Error('startStandaloneService 需要 handler')
  if (typeof health !== 'function') throw new Error('health 必须是函数')

  let actualPort = Number(port)
  const server = await listen(actualPort, {
    host,
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs,
    handler: async (req, res) => {
      let pathname
      try { pathname = new URL(req.url, `http://${host}`).pathname } catch { pathname = '' }
      if (req.method === 'GET' && pathname === healthPath) {
        try {
          const extra = await health({ service, host, port: actualPort })
          send(req, res, 200, {
            ...(extra && typeof extra === 'object' ? extra : {}),
            ok: true,
            service,
            pid: process.pid,
            port: actualPort,
          })
        } catch (error) {
          send(req, res, 503, {
            ok: false,
            service,
            pid: process.pid,
            port: actualPort,
            error: String(error?.message || error),
          })
        }
        return
      }
      return handler(req, res)
    },
  })

  const address = server.address()
  actualPort = address && typeof address === 'object' ? address.port : actualPort
  let closePromise
  const close = () => {
    if (closePromise) return closePromise
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close((error) => error ? reject(error) : resolve())
      server.closeIdleConnections?.()
    })
    return closePromise
  }

  return {
    server,
    service,
    host,
    port: actualPort,
    url: `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${actualPort}`,
    close,
  }
}

/**
 * Standalone entrypoint helper for broker-managed services. Call this only from
 * the executable entrypoint, never from a Cordis apply().
 */
export function installServiceSignalHandlers(instance, {
  processRef = process,
  logger = console,
  exit = (code) => processRef.exit(code),
  timeoutMs = 3000,
} = {}) {
  if (!instance || typeof instance.close !== 'function') throw new Error('需要 startStandaloneService 返回的 instance')
  let closing = false
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (closing) return
      closing = true
      logger.info?.(`[${instance.service}] 收到 ${signal}，正在关闭`)
      const timer = setTimeout(() => exit(1), timeoutMs)
      timer.unref?.()
      Promise.resolve(instance.close()).then(() => {
        clearTimeout(timer)
        exit(0)
      }, (error) => {
        clearTimeout(timer)
        logger.error?.(`[${instance.service}] 关闭失败: ${error.message}`)
        exit(1)
      })
    }
    handlers.set(signal, handler)
    processRef.once(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) processRef.removeListener(signal, handler)
  }
}

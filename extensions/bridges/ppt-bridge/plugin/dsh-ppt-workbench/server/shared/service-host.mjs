/**
 * dsh-service-host —— 通用服务宿主。
 *
 * 功能插件只声明“我有哪些路由、健康字段、指标”，不再自己写：
 *   - http server / listen / 端口扫描 / strictPort
 *   - 单实例锁 / 复用探测 / discovery 文件
 *   - /healthz /metrics 标准骨架
 *   - 静态资源、路径穿越防护、优雅关闭
 *
 * 两种模式：
 *   standalone（默认）：自建 loopback server，行为与旧 relay 一致；
 *   embedded：传入 DSH 的 ctx.webServer，把同一套路由挂到 `<basePath>` 前缀。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { listen, send, sendText, readBody } from './kit/service/http.mjs'
import { createServiceApi } from './kit/service/api.mjs'
import { tuning } from './tuning.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function slugOf(id) {
  return String(id || 'service').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'service'
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** 浏览器跨源写请求防护：只允许本机 loopback 页面 POST。 */
function isLoopbackOrigin(origin) {
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]'
  } catch {
    return false
  }
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  const token = crypto.randomBytes(12).toString('hex')
  const { lockFreshGraceMs } = tuning()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      /* 原子创建：两个进程同时启动时只有一个能拿到 'wx'。 */
      const fd = fs.openSync(lockFile, 'wx')
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, port: 0, timestamp: Date.now() }))
        try { fs.fsyncSync(fd) } catch { /* 部分文件系统不支持 */ }
      } finally {
        fs.closeSync(fd)
      }
      return { file: lockFile, token }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let info = null
      try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch { /* 可能正在写入 */ }
      let age = 0
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs } catch { /* 已被移除 */ }
      /* 有效且 pid 存活：绝不抢占；空/坏锁只有在存在超过宽限期后才视为残留。 */
      if (info && pidAlive(info.pid)) return null
      if (!info && age < lockFreshGraceMs) return null
      try { fs.rmSync(lockFile, { force: true }) } catch { /* 忽略 */ }
    }
  }
  return null
}

function writeLock(lock, port) {
  let current = null
  try { current = JSON.parse(fs.readFileSync(lock.file, 'utf8')) } catch { /* 忽略 */ }
  if (!current || current.token !== lock.token) {
    throw new Error(`锁已被其它实例接管: ${lock.file}`)
  }
  fs.writeFileSync(lock.file, JSON.stringify({
    pid: process.pid, token: lock.token, port, timestamp: Date.now(),
  }))
}

function releaseLock(lock) {
  if (!lock) return
  try {
    const data = JSON.parse(fs.readFileSync(lock.file, 'utf8'))
    if (data.token === lock.token) fs.rmSync(lock.file, { force: true })
  } catch { /* 不是自己的锁或已被删除 */ }
}

async function probeExisting(origin, healthPath, id) {
  try {
    const res = await fetch(`${origin}${healthPath}`, { signal: AbortSignal.timeout(tuning().reuseProbeTimeoutMs) })
    if (!res.ok) return null
    const info = await res.json()
    if (info?.service === id || info?.name === id || info?.bridge === id) return info
  } catch { /* 端口没有本服务 */ }
  return null
}

function safeJoin(root, rel) {
  const target = path.resolve(root, `.${path.sep}${rel}`)
  const base = path.resolve(root)
  return target === base || target.startsWith(base + path.sep) ? target : null
}

/**
 * @param {{
 *   id: string,
 *   title?: string,
 *   version?: string,
 *   contractVersion?: string,
 *   publicBasePath?: string,
 *   health?: (() => object)|object,
 *   metrics?: (() => Array<[string, number]>|string)|Array<[string, number]>|string,
 * }} options
 */
export function createServiceApp(options = {}) {
  if (!options.id) throw new Error('createServiceApp: id 必填')
  const id = String(options.id)
  const title = options.title || id
  const version = options.version || '0.0.0'
  const contractVersion = options.contractVersion || '1.0.0'
  const slug = slugOf(options.slug || id)
  const startedAt = Date.now()
  const routes = []
  let healthExtra = options.health || null
  let metricsExtra = options.metrics || null
  let server = null
  let embeddedDispose = null
  let basePath = options.publicBasePath || ''
  let listeningPort = 0
  let url = ''
  let closed = false

  const app = {
    id,
    title,
    version,
    contractVersion,
    slug,
    get port() { return listeningPort },
    get url() { return url },
    get running() { return !!server || !!embeddedDispose },

    /** 注册一个中间件式路由：返回 true 表示已处理。 */
    use(handler) {
      if (typeof handler !== 'function') throw new Error('service-host: route handler 必须是函数')
      routes.push(handler)
      return () => {
        const index = routes.indexOf(handler)
        if (index >= 0) routes.splice(index, 1)
      }
    },

    get(pathname, handler) {
      return app.use((req, res, u) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return false
        if (u.pathname !== pathname) return false
        return Promise.resolve(handler(req, res, u)).then(() => true)
      })
    },

    post(pathname, handler) {
      return app.use((req, res, u) => {
        if (req.method !== 'POST' || u.pathname !== pathname) return false
        return Promise.resolve(handler(req, res, u)).then(() => true)
      })
    },

    /** 静态目录挂载。files 可给显式映射：{ '/': ['index.html','text/html'] }。 */
    static(prefix, dir, { files = null, index = 'index.html' } = {}) {
      const cleanPrefix = prefix === '/' ? '' : prefix.replace(/\/+$/, '')
      return app.use((req, res, u) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return false
        if (cleanPrefix && u.pathname !== cleanPrefix && !u.pathname.startsWith(cleanPrefix + '/')) return false
        const relRaw = cleanPrefix ? u.pathname.slice(cleanPrefix.length) : u.pathname
        const rel = relRaw === '' || relRaw === '/' ? index : decodeURIComponent(relRaw.replace(/^\/+/, ''))
        let file = null
        let type = MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream'
        if (files) {
          const hit = files[relRaw === '' ? '/' : relRaw] || files[relRaw]
          if (!hit) return false
          const [name, explicitType] = Array.isArray(hit) ? hit : [hit]
          file = safeJoin(dir, name)
          type = explicitType || type
        } else {
          file = safeJoin(dir, rel)
        }
        if (!file) return false
        try {
          const data = fs.readFileSync(file)
          res.writeHead(200, {
            'content-type': type,
            'content-length': data.length,
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : data)
          return true
        } catch {
          return false
        }
      })
    },

    setHealth(fn) { healthExtra = fn; return app },
    setMetrics(fn) { metricsExtra = fn; return app },

    async health() {
      const extra = typeof healthExtra === 'function' ? await healthExtra() : (healthExtra || {})
      return {
        ...extra,
        ok: true,
        service: id,
        name: id,
        title,
        version,
        contractVersion,
        pid: process.pid,
        port: listeningPort,
        uptimeSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      }
    },

    async metricsText() {
      const uptime = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      const lines = [
        `# HELP ${slug}_up 服务是否在线`,
        `# TYPE ${slug}_up gauge`,
        `${slug}_up 1`,
        `# HELP ${slug}_uptime_seconds 服务运行秒数`,
        `# TYPE ${slug}_uptime_seconds gauge`,
        `${slug}_uptime_seconds ${uptime}`,
        `# HELP ${slug}_port 实际监听端口`,
        `# TYPE ${slug}_port gauge`,
        `${slug}_port ${listeningPort}`,
      ]
      const extra = typeof metricsExtra === 'function' ? await metricsExtra() : metricsExtra
      if (typeof extra === 'string' && extra) lines.push(extra.replace(/\s+$/, ''))
      else if (Array.isArray(extra)) {
        for (const row of extra) {
          if (!Array.isArray(row)) continue
          const [name, value] = row
          if (name) lines.push(`${name} ${Number(value) || 0}`)
        }
      }
      return lines.join('\n') + '\n'
    },

    async dispatch(req, res, stripPrefix = '') {
      try {
        /* 畸形请求行（如 absolute-form URL）不能让整个宿主进程崩溃。 */
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method !== 'GET' && req.method !== 'HEAD' && !isLoopbackOrigin(req.headers.origin)) {
          return send(req, res, 403, { ok: false, error: 'cross-origin write blocked' })
        }
        if (stripPrefix && (u.pathname === stripPrefix || u.pathname.startsWith(stripPrefix + '/'))) {
          u.pathname = u.pathname.slice(stripPrefix.length) || '/'
        }
        if (u.pathname === '/healthz') {
          return send(req, res, 200, await app.health())
        }
        if (u.pathname === '/metrics') {
          return sendText(req, res, 200, await app.metricsText(), 'text/plain; version=0.0.4; charset=utf-8')
        }
        for (const handler of routes) {
          if (await handler(req, res, u)) return
        }
        return send(req, res, 404, { ok: false, error: 'not found', path: u.pathname })
      } catch (error) {
        const status = error?.code === 'BODY_TOO_LARGE'
          ? 413
          : error?.code === 'BAD_JSON' || error?.code === 'ERR_INVALID_URL'
            ? 400
            : 500
        if (!res.headersSent) send(req, res, status, { ok: false, error: String((error && error.message) || error) })
        else res.destroy()
      }
    },

    /**
     * @param {{
     *   port?: number, host?: string, strictPort?: boolean, allowReuse?: boolean,
     *   scanLimit?: number, lockFile?: string, hostDir?: string,
     *   discoveryFile?: string, discovery?: object, publicBasePath?: string,
     *   webServer?: object, basePath?: string,
     * }} listenOptions
     */
    async listen(listenOptions = {}) {
      if (app.running) throw new Error(`service-host ${id}: 已经在运行`)
      const host = listenOptions.host || '127.0.0.1'
      const port = Number(listenOptions.port ?? 0)
      const strictPort = !!listenOptions.strictPort
      const allowReuse = listenOptions.allowReuse !== false
      const scanLimit = Number(listenOptions.scanLimit ?? tuning().portScanLimit)
      basePath = listenOptions.publicBasePath ?? listenOptions.basePath ?? basePath ?? ''
      if (basePath === '/') basePath = ''

      const webServer = listenOptions.webServer
      if (webServer && typeof webServer.register === 'function') {
        const prefix = basePath || `/plugins/${id}`
        embeddedDispose = webServer.register({
          kind: 'prefix',
          path: prefix,
          handler: (req, res) => app.dispatch(req, res, prefix),
        })
        listeningPort = Number(webServer.port) || 0
        url = `http://127.0.0.1:${listeningPort}${prefix}`
        return { url, port: listeningPort, reused: false, mode: 'embedded', stop: app.close }
      }

      const hostDir = listenOptions.hostDir || path.join(os.tmpdir(), `dsh-${id}`)
      const lockFile = listenOptions.lockFile || path.join(hostDir, 'service.lock')
      const publicBasePath = basePath
      const healthPath = `${publicBasePath}/healthz` || '/healthz'

      if (allowReuse && port > 0) {
        const existing = await probeExisting(`http://127.0.0.1:${port}`, healthPath, id)
        /* 只复用同契约版本的实例：旧代码/半初始化实例不能被当成本实例。 */
        if (existing && existing.contractVersion && existing.contractVersion === contractVersion) {
          listeningPort = port
          url = `http://127.0.0.1:${port}${publicBasePath}`
          return { url, port, reused: true, mode: 'standalone', stop: async () => {} }
        }
      }

      const lock = acquireLock(lockFile)
      if (!lock) {
        throw new Error(`${id} 已有另一个实例在运行；如确认没有，请删除锁文件: ${lockFile}`)
      }

      let actualPort = port
      let lastError = null
      const requestTimeoutMs = Number(listenOptions.requestTimeoutMs) || 30000
      const headersTimeoutMs = Number(listenOptions.headersTimeoutMs) || 10000
      const keepAliveTimeoutMs = Number(listenOptions.keepAliveTimeoutMs) || 5000
      for (let attempt = 0; attempt <= (strictPort ? 0 : scanLimit); attempt++) {
        const tryPort = port === 0 ? 0 : port + attempt
        try {
          server = await listen(tryPort, { host, requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs })
          actualPort = server.address().port
          break
        } catch (error) {
          lastError = error
          if (port === 0 || strictPort || attempt === scanLimit) {
            releaseLock(lock)
            throw new Error(`端口 ${tryPort} 不可用${strictPort ? '（strictPort）' : ''}: ${(error && error.message) || error}`)
          }
        }
      }
      if (!server) {
        releaseLock(lock)
        throw lastError || new Error('无法监听端口')
      }

      try {
        writeLock(lock, actualPort)
      } catch (error) {
        try { server.close() } catch { /* 忽略 */ }
        server = null
        releaseLock(lock)
        throw error
      }
      listeningPort = actualPort
      url = `http://127.0.0.1:${actualPort}${publicBasePath}`

      server.on('request', (req, res) => {
        Promise.resolve(app.dispatch(req, res, publicBasePath)).catch((error) => {
          try {
            if (!res.headersSent) send(req, res, 500, { ok: false, error: String((error && error.message) || error) })
            else res.destroy()
          } catch { /* 连接已断开 */ }
        })
      })
      const discoveryFile = listenOptions.discoveryFile
        || (listenOptions.hostDir ? path.join(hostDir, 'discovery.json') : '')
      if (discoveryFile) {
        try {
          fs.mkdirSync(path.dirname(discoveryFile), { recursive: true })
          fs.writeFileSync(discoveryFile, JSON.stringify({
            service: id,
            ...(listenOptions.discovery || {}),
            url, port: actualPort, pid: process.pid, updated: new Date().toISOString(),
          }, null, 2))
        } catch { /* discovery 写失败不影响服务 */ }
      }

      app._lock = lock
      app._discoveryFile = discoveryFile
      return { url, port: actualPort, reused: false, mode: 'standalone', stop: app.close }
    },

    async close() {
      if (closed) return
      closed = true
      if (embeddedDispose) {
        try { embeddedDispose() } catch { /* 忽略 */ }
        embeddedDispose = null
        return
      }
      if (!server) return
      const srv = server
      server = null
      await new Promise((resolve) => {
        const { closeGraceMs, closeForceMs } = tuning()
        let done = false
        const finish = () => { if (done) return; done = true; resolve() }
        srv.close(finish)
        setTimeout(() => srv.closeAllConnections?.(), closeGraceMs).unref?.()
        setTimeout(finish, closeForceMs).unref?.()
      })
      if (app._discoveryFile) {
        try {
          const data = JSON.parse(fs.readFileSync(app._discoveryFile, 'utf8'))
          if (data.pid === process.pid) fs.rmSync(app._discoveryFile, { force: true })
        } catch { /* 忽略 */ }
      }
      if (app._lock) releaseLock(app._lock)
    },
  }

  return app
}

export function createServiceHost(config = {}) {
  return {
    api: createServiceApi('serviceHost', '1.0.0', ['http', 'static', 'health', 'metrics', 'lock', 'reuse', 'discovery', 'shared-host']),
    version: '0.1.0',
    createApp(options = {}) {
      return createServiceApp({ ...config, ...options })
    },
    createSharedHost(options = {}) {
      return createSharedHost({ ...config, ...options })
    },
    readBody,
  }
}

/**
 * 共享宿主：多个功能插件挂到同一个 HTTP server / 同一个端口。
 *
 *   const host = ctx.serviceHost.createSharedHost({ id: 'dsh-app' })
 *   host.mount('/plugins/ppt', pptApp)
 *   host.mount('/plugins/canvas', canvasApp)
 *   await host.listen({ port: 3080 })
 *
 * 每个子 app 仍由 createServiceApp 创建；共享宿主只负责前缀分发和统一生命周期。
 * @param {{ id?: string, title?: string, version?: string, contractVersion?: string, health?: Function|object }} options
 */
export function createSharedHost(options = {}) {
  const mounts = new Map()
  const id = options.id || 'dsh-shared-host'
  const app = createServiceApp({
    ...options,
    id,
    title: options.title || 'DSH Shared Host',
    version: options.version || '0.1.0',
    contractVersion: options.contractVersion || '1.0.0',
    health: options.health || (() => ({ children: [...mounts.keys()] })),
  })

  const mount = (prefix, child) => {
    const clean = String(prefix || '').replace(/\/+$/, '') || '/'
    if (clean === '/') throw new Error('shared-host: 子插件必须使用非根前缀')
    if (mounts.has(clean)) throw new Error(`shared-host: 前缀已挂载: ${clean}`)
    if (!child || typeof child.dispatch !== 'function') throw new Error(`shared-host: ${clean} 的子 app 必须提供 dispatch()`)
    const dispose = app.use((req, res, u) => {
      if (u.pathname !== clean && !u.pathname.startsWith(clean + '/')) return false
      return child.dispatch(req, res, clean).then(() => true)
    })
    mounts.set(clean, { child, dispose })
    return () => {
      dispose()
      mounts.delete(clean)
    }
  }

  return {
    id,
    app,
    api: createServiceApi('serviceHost', '1.0.0', ['shared-host']),
    mount,
    children() { return [...mounts.keys()] },
    listen(listenOptions = {}) {
      return app.listen(listenOptions)
    },
    close() {
      return app.close()
    },
  }
}

export { send, sendText, readBody }

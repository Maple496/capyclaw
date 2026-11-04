/**
 * HTTP API + 管理界面。
 *
 * 绑定 127.0.0.1；默认无鉴权（本机工具），设置 LAUNCHPAD_TOKEN / --token 后
 * /api/* 需要带 x-launchpad-token；静态 UI 与 /healthz 不拦。
 * CORS 只放行回环 Origin，方便本机其他工具页调用。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { readBody, send, sendText } from '@capyclaw/plugin-kit/service/http'

import {
  applyManifest,
  buildDoctor,
  buildStatus,
  resolveManifestRef,
  scanAndAnalyze,
  startService,
  stopService,
} from './index.mjs'
import { createLaunchpadManager } from './launchpads.mjs'
import { PACKAGE_DIR } from './scan.mjs'

const DEFAULT_VERSION = '1.1.0'
const CONTRACT_VERSION = '1.1.0'
const BODY_LIMIT = 256 * 1024
const ARCHIVE_LIMIT = 64 * 1024 * 1024

function installerModuleUrl(root) {
  return pathToFileURL(path.join(root, 'app', 'runtime', 'launcher-registry.mjs')).href
}
function pathModuleIsAbsolute(value) { return path.isAbsolute(value) }

function isLoopbackAddress(address) {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function equalToken(actual, expected) {
  const a = Buffer.from(typeof actual === 'string' ? actual : '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readArchive(req) {
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > ARCHIVE_LIMIT)) {
    req.resume()
    throw httpError(413, 'BODY_TOO_LARGE', '安装包超过 64 MiB')
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const timer = setTimeout(() => finish(httpError(408, 'UPLOAD_TIMEOUT', '上传超时')), 30000)
    function finish(error) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) { req.resume(); reject(error) } else resolve(Buffer.concat(chunks, size))
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > ARCHIVE_LIMIT) return finish(httpError(413, 'BODY_TOO_LARGE', '安装包超过 64 MiB'))
      chunks.push(chunk)
    })
    req.on('end', () => finish(size ? null : httpError(400, 'INVALID_BODY', '安装包不能为空')))
    req.on('error', () => finish(httpError(400, 'CLIENT_ABORTED', '上传中断')))
    req.on('aborted', () => finish(httpError(400, 'CLIENT_ABORTED', '上传中断')))
  })
}
const UI_DIR = path.join(PACKAGE_DIR, 'ui')
const UI_FILES = {
  '/ui/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/ui/style.css': ['style.css', 'text/css; charset=utf-8'],
}

function createCache(options) {
  const ttlMs = options.cacheTtlMs ?? 2000
  let cached = null
  let cachedAt = 0
  let inflight = null
  const build = async () => {
    const result = await scanAndAnalyze(options)
    return { ...result, builtAt: Date.now() }
  }
  const get = async (force = false) => {
    if (force) {
      cached = null
      cachedAt = 0
    }
    if (cached && Date.now() - cachedAt < ttlMs) return cached
    if (inflight) return inflight
    inflight = build()
      .then((result) => {
        cached = result
        cachedAt = Date.now()
        return result
      })
      .finally(() => { inflight = null })
    return inflight
  }
  return {
    get,
    clear() { cached = null; cachedAt = 0 },
  }
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function corsHeaders(req) {
  const origin = req.headers.origin
  if (!origin || !isLoopbackOrigin(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-launchpad-token',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

function httpError(status, code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.status = status
  error.extra = extra
  return error
}

function statusForError(error) {
  if (error.status) return error.status
  switch (error.code) {
    case 'NOT_FOUND': return 404
    case 'AMBIGUOUS': return 409
    case 'BROKER_URL_MISSING': return 409
    case 'SELF_STOP_REFUSED': return 409
    case 'ACTION_SPEC_MISSING': return 400
    case 'NOT_BROKER_MANIFEST': return 400
    case 'BODY_TOO_LARGE': return 413
    case 'BAD_JSON':
    case 'CLIENT_ABORTED': return 400
    case 'BROKER_UNREACHABLE':
    case 'BROKER_TIMEOUT':
    case 'BROKER_HTTP_ERROR': return 502
    case 'LAUNCHPAD_NOT_FOUND': return 404
    case 'LAUNCHPAD_EXISTS':
    case 'LAUNCHPAD_RUNNING':
    case 'LAUNCHPAD_HOST': return 409
    case 'LAUNCHPAD_INVALID':
    case 'INVALID_ID':
    case 'INVALID_NAME':
    case 'INVALID_BODY':
    case 'DUPLICATE_BUNDLE':
    case 'DSL_ERROR':
    case 'UNSUPPORTED_KIND':
    case 'INVALID_PORT': return 400
    case 'DSHD_NOT_FOUND': return 503
    case 'DSHD_TIMEOUT': return 504
    case 'DSHD_FAILED':
    case 'DSHD_BAD_OUTPUT': return 502
    default: return 500
  }
}

function inventoryOptions(options) {
  return {
    roots: options.roots,
    dshHome: options.dshHome,
    includeProfiles: options.includeProfiles,
    cwd: options.cwd,
    maxDepth: options.maxDepth,
    maxFiles: options.maxFiles,
    maxFileSize: options.maxFileSize,
  }
}

function runtimeOptions(options, body = {}) {
  return {
    discovery: body.discovery || options.discovery,
    brokerUrl: body.brokerUrl || options.brokerUrl,
    brokerToken: body.brokerToken || options.brokerToken,
    token: body.token || options.token,
    env: options.env,
    probe: body.probe === true || body.probe === '1',
    probeTimeoutMs: options.probeTimeoutMs,
    brokerTimeoutMs: options.brokerTimeoutMs,
  }
}

export function createLaunchpadServer(options = {}) {
  const version = options.version || DEFAULT_VERSION
  const cache = createCache(inventoryOptions(options))
  const token = options.token || process.env.LAUNCHPAD_TOKEN || ''
  const startedAt = Date.now()
  let actualPort = Number.isInteger(options.port) ? options.port : 0
  const launchpads = createLaunchpadManager({
    repoRoot: options.repoRoot,
    launchpadsDir: options.launchpadsDir,
    dshd: options.dshd,
    hostStateDir: options.hostStateDir,
  })

  const app = {
    getPort: () => actualPort,
    setPort: (port) => { actualPort = port },
    getInventory: (force = false) => cache.get(force),
    clearCache: () => cache.clear(),
    launchpads,
    version,
    options,
  }

  async function authorize(req, url) {
    if (!token) return
    // 静态 UI 与 health 不拦；token 只保护 API。
    if (!url.pathname.startsWith('/api/')) return
    const supplied = req.headers['x-launchpad-token']
      || (String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7)
        : '')
    if (supplied !== token) throw httpError(401, 'UNAUTHORIZED', '缺少或错误的 x-launchpad-token')
  }

  function serveUi(req, res, relative, contentType, cors) {
    const file = path.join(UI_DIR, relative)
    if (!existsSync(file)) {
      send(req, res, 404, { ok: false, error: { code: 'UI_NOT_FOUND', message: `缺少 UI 文件: ${relative}` } }, cors)
      return
    }
    try {
      sendText(req, res, 200, readFileSync(file, 'utf8'), contentType, cors)
    } catch (error) {
      send(req, res, 500, { ok: false, error: { code: 'UI_READ_FAILED', message: error.message } }, cors)
    }
  }

  async function getInventory(force = false) {
    const { inventory, scan } = await cache.get(force)
    return { inventory, scan }
  }

  app.handler = async (req, res) => {
    let cors = corsHeaders(req)
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      send(req, res, 400, { ok: false, error: { code: 'BAD_URL', message: '非法 URL' } }, cors)
      return
    }

    // Installation never participates in the general loopback CORS policy.
    if (url.pathname === '/api/launcher/install') cors = { 'cache-control': 'no-store' }

    if (req.method === 'OPTIONS' && url.pathname === '/api/launcher/install') {
      res.writeHead(403, cors)
      res.end()
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    try {
      await authorize(req, url)
      const path = url.pathname

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        send(req, res, 200, {
          ok: true,
          service: 'dsh-launchpad',
          name: 'dsh-launchpad',
          pid: process.pid,
          port: actualPort,
          version,
          contractVersion: CONTRACT_VERSION,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        }, cors)
        return
      }

      if ((path === '/' || path === '/ui/' || path === '/ui/index.html')
        && (req.method === 'GET' || req.method === 'HEAD')) {
        serveUi(req, res, 'index.html', 'text/html; charset=utf-8', cors)
        return
      }

      const uiFile = UI_FILES[path]
      if (uiFile && (req.method === 'GET' || req.method === 'HEAD')) {
        serveUi(req, res, uiFile[0], uiFile[1], cors)
        return
      }

      if (path === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(204, cors)
        res.end()
        return
      }

      if (path === '/api/launcher/install' && req.method === 'POST') {
        const installToken = process.env.DSH_LAUNCHER_INSTALL_TOKEN || ''
        if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackAddress(req.socket.localAddress)) {
          throw httpError(403, 'LOOPBACK_REQUIRED', '仅允许本机回环连接')
        }
        // Reject foreign Origins even from other local services, and DNS rebinding Hosts.
        const host = req.headers.host || ''
        const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]
        if (!allowedHosts.includes(host)) throw httpError(403, 'INVALID_HOST', '无效的本机 Host')
        const origin = req.headers.origin
        if (origin && origin !== `http://${host}`) throw httpError(403, 'INVALID_ORIGIN', '仅允许同源请求')
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw httpError(403, 'INVALID_ORIGIN', '仅允许同源请求')
        }
        if (!installToken) throw httpError(503, 'INSTALL_DISABLED', '未配置 DSH_LAUNCHER_INSTALL_TOKEN')
        if (!equalToken(req.headers['x-launcher-install-token'], installToken)) {
          throw httpError(401, 'INSTALL_UNAUTHORIZED', '安装 token 错误')
        }
        if (req.headers['content-type'] !== 'application/octet-stream') {
          throw httpError(415, 'INVALID_CONTENT_TYPE', '需要 application/octet-stream')
        }
        const filename = req.headers['x-archive-filename']
        if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename)) {
          throw httpError(400, 'INVALID_FILENAME', '文件名仅支持字母、数字、点、下划线和连字符')
        }
        // The product root is supplied by the launcher, not inferred from the UI package.
        // installerRootForTests is an explicit injection for isolated tests only.
        const root = process.env.DSH_PRODUCT_ROOT || options.installerRootForTests
        if (!root || !pathModuleIsAbsolute(root)) {
          throw httpError(503, 'PRODUCT_ROOT_UNAVAILABLE', '未配置有效的 DSH_PRODUCT_ROOT')
        }
        const buffer = await readArchive(req)
        let installArchive
        try {
          ;({ installArchive } = await import(installerModuleUrl(root)))
        } catch {
          throw httpError(503, 'INSTALLER_UNAVAILABLE', '本地安装模块不可用')
        }
        if (typeof installArchive !== 'function') throw httpError(503, 'INSTALLER_UNAVAILABLE', '本地安装模块不可用')
        const result = await installArchive({ root, buffer, filename })
        cache.clear()
        send(req, res, 200, { ok: true, result }, cors)
        return
      }

      if (path === '/api/launchpads' && req.method === 'GET') {
        send(req, res, 200, {
          ok: true,
          dir: launchpads.launchpadsDir,
          dshd: launchpads.dshd,
          launchpads: await launchpads.list(),
        }, cors)
        return
      }

      if (path === '/api/launchpads' && req.method === 'POST') {
        const body = await readBody(req, BODY_LIMIT)
        const launchpad = await launchpads.create(body.name)
        send(req, res, 201, { ok: true, launchpad }, cors)
        return
      }

      if (path === '/api/plugins/catalog' && req.method === 'GET') {
        send(req, res, 200, { ok: true, plugins: launchpads.catalog() }, cors)
        return
      }

      const launchpadMatch = path.match(/^\/api\/launchpads\/([^/]+)(?:\/(validate|plan|start|stop|status|plugins))?$/)
      if (launchpadMatch) {
        const id = decodeURIComponent(launchpadMatch[1])
        const action = launchpadMatch[2] || ''
        if (!action && req.method === 'GET') {
          send(req, res, 200, { ok: true, launchpad: await launchpads.get(id) }, cors)
          return
        }
        if (!action && req.method === 'PUT') {
          const body = await readBody(req, BODY_LIMIT)
          send(req, res, 200, { ok: true, launchpad: await launchpads.save(id, body.text) }, cors)
          return
        }
        if (!action && req.method === 'DELETE') {
          send(req, res, 200, await launchpads.remove(id), cors)
          return
        }
        if (action === 'status' && req.method === 'GET') {
          send(req, res, 200, await launchpads.status(id), cors)
          return
        }
        if (action === 'plugins' && req.method === 'GET') {
          const lp = await launchpads.get(id)
          send(req, res, 200, {
            ok: true,
            id,
            desired: lp.stack?.plugins?.bundles || [],
            actual: lp.profileState || null,
            catalog: launchpads.catalog(),
          }, cors)
          return
        }
        if (action === 'plugins' && req.method === 'PUT') {
          const body = await readBody(req, BODY_LIMIT)
          const lp = await launchpads.savePlugins(id, body.bundles)
          send(req, res, 200, { ok: true, launchpad: lp }, cors)
          return
        }
        if (action === 'validate' && req.method === 'POST') {
          send(req, res, 200, await launchpads.validate(id), cors)
          return
        }
        if (action === 'plan' && req.method === 'POST') {
          const result = await launchpads.plan(id)
          send(req, res, 200, result, cors)
          return
        }
        if (action === 'start' && req.method === 'POST') {
          const result = await launchpads.start(id)
          send(req, res, result.ok === false ? 207 : 200, result, cors)
          return
        }
        if (action === 'stop' && req.method === 'POST') {
          const result = await launchpads.stop(id)
          send(req, res, result.ok === false ? 207 : 200, result, cors)
          return
        }
        send(req, res, 405, {
          ok: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: `不支持: ${req.method} ${path}` },
        }, cors)
        return
      }

      if (path === '/api/inventory' && req.method === 'GET') {
        const { inventory, scan } = await getInventory(false)
        send(req, res, 200, { ok: true, ...inventory, scan: {
          filesScanned: scan.filesScanned,
          truncated: scan.truncated,
          skipped: scan.skipped,
          errors: scan.errors,
        } }, cors)
        return
      }

      if (path === '/api/inventory' && req.method === 'POST') {
        send(req, res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '用 GET /api/inventory' } }, cors)
        return
      }

      if (path === '/api/refresh' && req.method === 'POST') {
        const { inventory, scan } = await getInventory(true)
        send(req, res, 200, { ok: true, refreshedAt: new Date().toISOString(), ...inventory, scan: {
          filesScanned: scan.filesScanned,
          truncated: scan.truncated,
          skipped: scan.skipped,
          errors: scan.errors,
        } }, cors)
        return
      }

      if (path === '/api/validate' && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        send(req, res, 200, {
          ok: inventory.summary.errors === 0,
          generatedAt: inventory.generatedAt,
          summary: inventory.summary,
          issues: inventory.issues,
          manifests: inventory.manifests.map((manifest) => ({
            id: manifest.id,
            type: manifest.type,
            path: manifest.path,
            relativePath: manifest.relativePath,
            valid: manifest.valid,
            errors: manifest.errors,
            warnings: manifest.warnings,
          })),
        }, cors)
        return
      }

      if (path === '/api/status' && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        const status = await buildStatus(inventory, {
          ...runtimeOptions(options),
          probe: url.searchParams.get('probe') === '1' || url.searchParams.get('probe') === 'true',
        })
        send(req, res, 200, { ok: true, ...status }, cors)
        return
      }

      if (path === '/api/doctor' && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        const doctor = await buildDoctor(inventory, runtimeOptions(options))
        send(req, res, 200, doctor, cors)
        return
      }

      if (path === '/api/manifests' && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        send(req, res, 200, {
          ok: true,
          manifests: inventory.manifests.map((manifest) => ({
            id: manifest.id,
            type: manifest.type,
            title: manifest.title,
            path: manifest.path,
            relativePath: manifest.relativePath,
            valid: manifest.valid,
            services: manifest.services?.length || 0,
            errors: manifest.errors.length,
            warnings: manifest.warnings.length,
          })),
        }, cors)
        return
      }

      if (path === '/api/services' && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        send(req, res, 200, {
          ok: true,
          services: inventory.services.map((service) => ({
            id: service.id,
            serviceId: service.serviceId,
            manifestId: service.manifestId,
            manifestRelativePath: service.manifestRelativePath,
            ports: service.ports,
            url: service.spec?.url,
            requires: service.requires,
            specHash: service.specHash,
          })),
        }, cors)
        return
      }

      const manifestMatch = path.match(/^\/api\/manifests\/([^/]+)$/)
      if (manifestMatch && req.method === 'GET') {
        const { inventory } = await getInventory(false)
        const manifest = resolveManifestRef(inventory, decodeURIComponent(manifestMatch[1]))
        send(req, res, 200, { ok: true, manifest }, cors)
        return
      }

      const applyMatch = path.match(/^\/api\/manifests\/([^/]+)\/apply$/)
      if (applyMatch && req.method === 'POST') {
        const { inventory } = await getInventory(false)
        const body = await readBody(req, BODY_LIMIT)
        const result = await applyManifest(inventory, {
          manifestRef: decodeURIComponent(applyMatch[1]),
          ...runtimeOptions(options, body),
          dryRun: !!body.dryRun,
          waitMs: Number.isInteger(body.waitMs) ? body.waitMs : undefined,
        })
        send(req, res, result.ok === false ? 207 : 200, result, cors)
        return
      }

      const serviceMatch = path.match(/^\/api\/services\/([^/]+)\/(start|stop)$/)
      if (serviceMatch && req.method === 'POST') {
        const { inventory } = await getInventory(false)
        const body = await readBody(req, BODY_LIMIT)
        const action = serviceMatch[2]
        const serviceId = decodeURIComponent(serviceMatch[1])
        const result = action === 'start'
          ? await startService(inventory, {
            serviceId,
            manifestRef: body.manifestId,
            ...runtimeOptions(options, body),
            dryRun: !!body.dryRun,
            waitMs: Number.isInteger(body.waitMs) ? body.waitMs : undefined,
          })
          : await stopService(inventory, {
            serviceId,
            manifestRef: body.manifestId,
            ...runtimeOptions(options, body),
            dryRun: !!body.dryRun,
            allowSelfStop: !!body.allowSelfStop,
          })
        send(req, res, result.ok === false ? 207 : 200, result, cors)
        return
      }

      send(req, res, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: `未知端点: ${req.method} ${path}` },
      }, cors)
    } catch (error) {
      const status = statusForError(error)
      send(req, res, status, {
        ok: false,
        error: {
          code: error.code || 'INTERNAL',
          message: error.message,
          ...(error.candidates ? { candidates: error.candidates } : {}),
          ...(error.extra || {}),
        },
      }, cors)
    }
  }

  return app
}

/**
 * dsh-asset-service —— 通用对象资产仓库。
 *
 * 功能插件不再各自实现 `/assets/<sha256>`、base64 上传、content-type 与缓存头。
 * 资产按 sha256 去重，url 为 `/assets/<id>`。
 *
 * 两种后端：
 *   - workspace：storeClient（ctx.workspace 的 scoped client），资产归当前 work；
 *   - file：本地目录，适合无 workspace 的独立运行/测试。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { send, readBody } from './kit/service/http.mjs'
import { createServiceApi } from './kit/service/api.mjs'

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

const ASSET_ID_RE = /^[a-f0-9]{64}$/

function validId(id) {
  return ASSET_ID_RE.test(String(id || ''))
}

function normalizeBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new Error('asset: 数据必须是 Buffer/Uint8Array')
}

/** 基于 ctx.workspace 的 scoped WorkspaceClient。 */
export function createWorkspaceAssetStore({ storeClient, workId = 'main' } = {}) {
  if (!storeClient || typeof storeClient.put !== 'function') throw new Error('createWorkspaceAssetStore 需要 storeClient')
  return {
    kind: 'workspace',
    async put(value, contentType = 'application/octet-stream') {
      const buffer = normalizeBuffer(value)
      const id = sha256(buffer)
      const key = `assets/${id}`
      storeClient.put(workId, key, buffer, { contentType })
      return { id, key, url: `/assets/${id}`, size: buffer.length, contentType }
    },
    get(id) {
      if (!validId(id)) return null
      const key = `assets/${id}`
      try {
        const data = storeClient.get(workId, key)
        if (!data) return null
        const meta = storeClient.list(workId).find((item) => item.key === key)
        return { data, contentType: meta?.contentType || 'application/octet-stream' }
      } catch {
        /* 缺失/权限错误按 404 处理，不能把 500 泄漏给资产路由。 */
        return null
      }
    },
    has(id) {
      if (!validId(id)) return false
      try { return !!storeClient.get(workId, `assets/${id}`) } catch { return false }
    },
  }
}

/** 本地目录后端：<dir>/<sha256> + <dir>/<sha256>.meta.json。 */
export function createFileAssetStore({ dir } = {}) {
  if (!dir) throw new Error('createFileAssetStore 需要 dir')
  fs.mkdirSync(dir, { recursive: true })
  return {
    kind: 'file',
    async put(value, contentType = 'application/octet-stream') {
      const buffer = normalizeBuffer(value)
      const id = sha256(buffer)
      const file = path.join(dir, id)
      const metaFile = file + '.meta.json'
      const existingOk = (() => {
        try { return fs.statSync(file).size === buffer.length } catch { return false }
      })()
      if (!existingOk) {
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        fs.writeFileSync(tmp, buffer)
        fs.renameSync(tmp, file)
      }
      const metaTmp = `${metaFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      fs.writeFileSync(metaTmp, JSON.stringify({ contentType, size: buffer.length }))
      fs.renameSync(metaTmp, metaFile)
      return { id, key: id, url: `/assets/${id}`, size: buffer.length, contentType }
    },
    get(id) {
      if (!validId(id)) return null
      const file = path.join(dir, path.basename(String(id)))
      try {
        const data = fs.readFileSync(file)
        /* 内容寻址仓库必须复核 hash：截断/篡改的对象不能静默返回。 */
        if (sha256(data) !== id) {
          console.error(`[asset-service] 对象校验失败，拒绝返回: ${id}`)
          return null
        }
        let contentType = 'application/octet-stream'
        try { contentType = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')).contentType || contentType } catch { /* 默认 */ }
        return { data, contentType }
      } catch {
        return null
      }
    },
    has(id) {
      if (!validId(id)) return false
      try { return fs.existsSync(path.join(dir, path.basename(String(id)))) } catch { return false }
    },
  }
}

/** 防止 text/html / svg 在 loopback 同源执行脚本；图片仍按原 MIME 内联。 */
function safeContentType(type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  if (base === 'text/html' || base === 'application/xhtml+xml' || base === 'image/svg+xml') {
    return 'text/plain; charset=utf-8'
  }
  return base
}

/**
 * service-host 兼容的资产路由。
 * GET/HEAD `/assets/<id>`（同时兼容 `<basePath>/assets/<id>`）；
 * POST `/assets` 或 `<basePath>/assets`（JSON: { data: base64, contentType }）。
 */
export function createAssetRoutes({ assetStore, basePath = '', maxUploadBytes = 10 * 1024 * 1024 } = {}) {
  const prefix = basePath === '/' ? '' : String(basePath || '').replace(/\/+$/, '')
  const getPrefixes = ['/assets/', prefix ? `${prefix}/assets/` : null].filter(Boolean)
  const postPaths = new Set(['/assets', prefix ? `${prefix}/assets` : null].filter(Boolean))
  return async function assetRoutes(req, res, u) {
    const p = u.pathname
    if (req.method === 'GET' || req.method === 'HEAD') {
      const getPrefix = getPrefixes.find((candidate) => p.startsWith(candidate))
      if (getPrefix) {
        if (!assetStore) { send(req, res, 404, { error: 'asset store unavailable' }); return true }
        const id = decodeURIComponent(p.slice(getPrefix.length))
        if (!validId(id)) { send(req, res, 404, { error: 'asset not found' }); return true }
        const asset = assetStore.get(id)
        if (!asset) { send(req, res, 404, { error: 'asset not found' }); return true }
        res.writeHead(200, {
          'content-type': safeContentType(asset.contentType),
          'content-length': asset.data.length,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        })
        res.end(req.method === 'HEAD' ? undefined : asset.data)
        return true
      }
    }
    if (postPaths.has(p) && req.method === 'POST') {
      if (!assetStore) { send(req, res, 503, { error: 'asset store unavailable' }); return true }
      let body
      try { body = await readBody(req, maxUploadBytes) } catch (error) {
        const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
        send(req, res, status, { error: String(error.message || error) })
        return true
      }
      if (!body || typeof body.data !== 'string' || !body.data) {
        send(req, res, 400, { error: '缺少图片数据' })
        return true
      }
      const buffer = Buffer.from(body.data, 'base64')
      if (!buffer.length) { send(req, res, 400, { error: '图片数据为空' }); return true }
      const asset = await assetStore.put(buffer, body.contentType || 'application/octet-stream')
      send(req, res, 200, { ok: true, ...asset })
      return true
    }
    return false
  }
}

export function createAssetHost(config = {}) {
  const defaultStore = config.storeClient
    ? createWorkspaceAssetStore({ storeClient: config.storeClient, workId: config.workId })
    : config.dir
      ? createFileAssetStore({ dir: config.dir })
      : null

  return {
    api: createServiceApi('assets', '1.0.0', ['workspace-store', 'file-store', 'routes', 'sha256', 'mount']),
    version: '0.1.0',
    createStore: createWorkspaceAssetStore,
    createFileStore: createFileAssetStore,
    routes: createAssetRoutes,
    store: defaultStore,
    /**
     * 每个 service-host app 只挂一次资产路由，避免多个插件重复争抢 /assets。
     * @param {object} hostApp createServiceApp() 返回值
     * @param {{ store?: object, basePath?: string }} options
     */
    mount(hostApp, { store = defaultStore, basePath = '' } = {}) {
      if (!hostApp || typeof hostApp.use !== 'function') throw new Error('assets.mount 需要 service-host app')
      if (!store) throw new Error('assets.mount: 没有可用 store')
      if (hostApp.__dshAssetsMounted) return () => {}
      hostApp.__dshAssetsMounted = true
      const unuse = hostApp.use(createAssetRoutes({ assetStore: store, basePath }))
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        /* 真正卸载路由；否则热重载后旧 store 仍会抢答 /assets。 */
        if (typeof unuse === 'function') unuse()
        hostApp.__dshAssetsMounted = false
      }
    },
    async put(value, contentType) {
      if (!defaultStore) throw new Error('asset-service: 未配置 storeClient/dir')
      return defaultStore.put(value, contentType)
    },
    get(id) {
      if (!defaultStore) throw new Error('asset-service: 未配置 storeClient/dir')
      return defaultStore.get(id)
    },
  }
}

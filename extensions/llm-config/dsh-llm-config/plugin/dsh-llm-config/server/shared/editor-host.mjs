/**
 * dsh-editor-host —— 通用浏览器编辑器宿主。
 *
 * 功能插件只提供 editor/ 静态目录，不再自己写：
 *   - 静态文件路由 / content-type / 404
 *   - “显示即连接”的租约仲裁（后打开者抢占，旧窗口静默待命）
 *   - claim / release / status / heartbeat 端点
 *   - 连接状态供 /healthz 使用
 *
 * 浏览器端可直接使用 dsh-plugin-kit 的 editor/lease.mjs（无 Node 依赖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createEditorLease } from './kit/editor/lease.mjs'
import { send, readBody } from './kit/service/http.mjs'
import { createServiceApi } from './kit/service/api.mjs'

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
}

function safeJoin(root, rel) {
  const target = path.resolve(root, `.${path.sep}${rel}`)
  const base = path.resolve(root)
  return target === base || target.startsWith(base + path.sep) ? target : null
}

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/**
 * @param {{ id: string, dir: string, basePath?: string, index?: string, files?: Record<string,string|string[]> }} options
 */
export function createEditorHost({ id, dir, basePath = '', index = 'index.html', files = null } = {}) {
  if (!id) throw new Error('createEditorHost: id 必填')
  const prefix = basePath === '/' ? '' : String(basePath || '').replace(/\/+$/, '')
  const lease = createEditorLease()

  const staticRoutes = async function editorStatic(req, res, u) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (prefix && u.pathname !== prefix && !u.pathname.startsWith(prefix + '/')) return false
    const relRaw = prefix ? u.pathname.slice(prefix.length) : u.pathname
    const rel = relRaw === '' || relRaw === '/' ? index : decodeURIComponent(relRaw.replace(/^\/+/, ''))
    let file = null
    if (files) {
      const hit = files[relRaw === '' ? '/' : relRaw] || files[relRaw]
      if (!hit) return false
      const name = Array.isArray(hit) ? hit[0] : hit
      file = safeJoin(dir, name)
    } else {
      file = safeJoin(dir, rel)
    }
    if (!file) return false
    try {
      const data = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': contentType(file),
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
  }

  const leaseRoutes = async function editorLeaseRoutes(req, res, u) {
    const claimPath = `${prefix}/claim`
    const releasePath = `${prefix}/release`
    const statusPath = `${prefix}/status`
    if (u.pathname === claimPath && req.method === 'POST') {
      const body = await readBody(req)
      const result = lease.claim(String(body.id || ''), !!body.force)
      send(req, res, result.ok ? 200 : 409, result)
      return true
    }
    if (u.pathname === releasePath && req.method === 'POST') {
      const body = await readBody(req)
      send(req, res, 200, lease.release(String(body.id || '')))
      return true
    }
    if (u.pathname === statusPath && req.method === 'GET') {
      send(req, res, 200, { ok: true, connected: lease.isLive(), lease: lease.status() })
      return true
    }
    return false
  }

  return {
    id,
    lease,
    routes() {
      return [staticRoutes, leaseRoutes]
    },
    staticRoutes,
    leaseRoutes,
    status() {
      return { connected: lease.isLive(), lease: lease.status() }
    },
  }
}

export function createEditorHostService(config = {}) {
  return {
    api: createServiceApi('editorHost', '1.0.0', ['static', 'lease', 'heartbeat', 'status']),
    version: '0.1.0',
    createEditorHost,
    createLease: createEditorLease,
    defaultHost: config.dir ? createEditorHost({ id: config.id || 'editor', ...config }) : null,
  }
}

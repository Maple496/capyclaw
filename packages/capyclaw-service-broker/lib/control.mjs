/**
 * dsh-service-broker 控制端点：外部投递结构化命令的入口。
 *
 * 端点（只绑 127.0.0.1）：
 *   GET  /healthz            中间件自身健康
 *   GET  /control/list       服务全量列表
 *   POST /control/apply      结构化命令批投递 { commands: [...], waitMs? }
 *   POST /control/start      { id? | service? }（id = 重放上次规格；service = 新规格）
 *   POST /control/stop       { id }
 *   GET  /control/doctor?id=
 *
 * 鉴权：设了 DSH_BROKER_TOKEN 时，除 /healthz 外都要带 x-broker-token。
 * HTTP 形状对齐 dsh-runtime-control 的控制面风格。
 */
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'

function jsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

function send(res, code, value) {
  const text = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
  })
  res.end(text)
}

/**
 * @param {import('./engine.mjs').ServiceEngine} engine
 * @param {{ token?: string, manifestPath?: string }} options
 */
export function createControlServer(engine, options = {}) {
  const manifestPath = options.manifestPath
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`
    try {
      if (options.token && route !== 'GET /healthz'
        && req.headers['x-broker-token'] !== options.token) {
        return send(res, 401, { ok: false, error: '需要 x-broker-token' })
      }

      if (route === 'GET /healthz') {
        return send(res, 200, {
          ok: true,
          service: 'dsh-service-broker',
          role: 'middleware',
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
        })
      }

      if (route === 'GET /control/list') {
        return send(res, 200, { ok: true, services: await engine.list() })
      }

      if (route === 'POST /control/apply') {
        const body = await jsonBody(req)
        const result = await engine.apply(body.commands || [], { waitMs: body.waitMs })
        return send(res, result.ok ? 200 : 207, result)
      }

      if (route === 'POST /control/start') {
        const body = await jsonBody(req)
        let spec = body.service
        if (!spec && body.id && manifestPath && existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          const services = Array.isArray(manifest) ? manifest : manifest.services
          spec = (services || []).find((s) => s.id === body.id)
          if (spec) spec = { ...spec, id: body.id }
        }
        if (!spec && body.id) {
          const row = (await engine.list()).find((s) => s.id === body.id)
          if (row?.url) return send(res, 200, { ok: true, services: [row] })
        }
        if (!spec) return send(res, 400, { ok: false, error: '缺 service 规格或可重放的 id' })
        const result = await engine.apply([{ op: 'up', service: spec }], { waitMs: body.waitMs })
        return send(res, result.ok ? 200 : 207, result)
      }

      if (route === 'POST /control/stop') {
        const body = await jsonBody(req)
        if (!body.id) return send(res, 400, { ok: false, error: '缺 id' })
        return send(res, 200, await engine.stop(body.id))
      }

      if (route === 'GET /control/doctor') {
        const id = url.searchParams.get('id')
        if (!id) return send(res, 400, { ok: false, error: '缺 id' })
        return send(res, 200, await engine.doctor(id))
      }

      send(res, 404, { ok: false, error: `未知端点 ${route}` })
    } catch (err) {
      send(res, 400, { ok: false, error: err.message })
    }
  })
  return server
}

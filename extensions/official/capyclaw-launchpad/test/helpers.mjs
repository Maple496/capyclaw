import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURE = path.join(HERE, 'fixtures', 'repo')
export const FIXTURE_DSH_HOME = path.join(FIXTURE, 'config', 'home')
export const FIXTURE_DISCOVERY = path.join(FIXTURE, 'config', 'state', 'services.json')

export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

export function closeServer(server) {
  return new Promise((resolve) => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    } catch { /* 尽力 */ }
    server.close(() => resolve())
  })
}

/**
 * 最小 broker 控制端点：记录请求，回可控响应。
 * options.status207ForApply = true 时 /control/apply 回 207。
 */
export async function startMockBroker(options = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = null
      const text = Buffer.concat(chunks).toString('utf8')
      if (text) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const send = (status, value) => {
        const payload = JSON.stringify(value)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
        res.end(payload)
      }
      if (options.failAll) return send(500, { ok: false, error: 'mock failure' })
      if (req.url === '/control/list') {
        return send(200, {
          ok: true,
          services: [{ id: 'alpha', state: 'running', url: 'http://127.0.0.1:41001', pid: process.pid }],
        })
      }
      if (req.url === '/control/apply') {
        if (options.status207ForApply) {
          return send(207, { ok: false, results: [{ id: body?.commands?.[0]?.service?.id, ok: false, error: 'mock partial' }] })
        }
        return send(200, { ok: true, services: (body?.commands || []).map((command) => ({ id: command.service?.id, state: 'running' })) })
      }
      if (req.url === '/control/start') {
        return send(200, { ok: true, services: [{ id: body?.service?.id || body?.id, state: 'running' }] })
      }
      if (req.url === '/control/stop') {
        return send(200, { ok: true, id: body?.id, state: 'stopped' })
      }
      if (req.url?.startsWith('/control/doctor')) {
        return send(200, { ok: true, id: new URL(req.url, 'http://127.0.0.1').searchParams.get('id') })
      }
      return send(404, { ok: false, error: 'not found' })
    })
  })
  const port = await listen(server)
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server),
  }
}

/** 最小健康端点，用于 probeHealth。 */
export async function startMockHealth(options = {}) {
  const server = http.createServer((req, res) => {
    const status = options.status ?? 200
    const payload = JSON.stringify(options.body ?? { ok: true, service: 'mock', pid: process.pid })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
  const port = await listen(server)
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  }
}

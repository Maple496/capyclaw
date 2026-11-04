#!/usr/bin/env node
/**
 * 测试夹具：最小标准服务（仅用于 broker 测试）。
 * 遵循服务标准：/healthz 返回 { ok, service, pid, port }。
 */
import http from 'node:http'

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const port = Number(arg('--port', process.env.PORT || 0)) || 0
const sick = process.argv.includes('--sick')
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/healthz') {
    if (sick) {
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end('{"ok":false}')
    }
    const body = JSON.stringify({ ok: true, service: 'mini', pid: process.pid, port })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    return res.end(body)
  }
  if (url.pathname === '/hello') {
    const body = JSON.stringify({ hello: 'world', pid: process.pid })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    return res.end(body)
  }
  res.writeHead(404)
  res.end('{"ok":false}')
})
server.listen(port, '127.0.0.1', () => {
  console.log(`mini-service on ${server.address().port}`)
})
process.on('SIGTERM', () => process.exit(0))

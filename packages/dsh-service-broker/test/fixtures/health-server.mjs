import { createServer } from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const delay = Number(process.argv[process.argv.indexOf('--delay') + 1]) || 0
const startedAt = new Date().toISOString()

// 模拟「启动器进程先退出、服务稍后才监听」：让 broker 必须走退出后宽限探测路径。
if (delay > 0) await new Promise((r) => setTimeout(r, delay))

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'fixture', pid: process.pid, port, startedAt }))
    return
  }
  res.writeHead(404).end('not found')
})
server.listen(port, '127.0.0.1')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

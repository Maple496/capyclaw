/**
 * 独立服务入口的监听/关闭逻辑。只允许回环地址。
 */
import { listen } from '@capyclaw/plugin-kit/service/http'

import { createLaunchpadServer } from './server.mjs'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export async function startServer(options = {}) {
  const host = options.host || '127.0.0.1'
  if (!LOOPBACK.has(host)) {
    throw new Error(`只允许绑定回环地址（127.0.0.1 / localhost / ::1），收到: ${host}`)
  }
  const port = options.port ?? 39700
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 必须是 0-65535 的整数: ${port}`)
  }

  const app = createLaunchpadServer({ ...options, port })
  const server = await listen(port, { host, handler: app.handler })
  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : port
  app.setPort(actualPort)
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}/`

  console.log(`[dsh-launchpad] UI/API: ${url}`)
  console.log(`[dsh-launchpad] discovery: ${options.discovery || process.env.DSH_DISCOVERY_FILE || '(auto)'}`)
  console.log(`[dsh-launchpad] roots: ${Array.isArray(options.roots) && options.roots.length ? options.roots.join(', ') : '(auto)'}`)
  console.log(`[dsh-launchpad] launchpads: ${app.launchpads.launchpadsDir}`)
  console.log(`[dsh-launchpad] dshd: ${app.launchpads.dshd || '(not found)'}`)

  const close = () => new Promise((resolve) => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    } catch { /* 尽力 */ }
    server.close(() => resolve())
  })

  return { server, app, url, port: actualPort, close }
}

export function installSignalHandlers(instance) {
  let closing = false
  const stop = async (signal) => {
    if (closing) return
    closing = true
    console.log(`\n[dsh-launchpad] 收到 ${signal}，正在关闭...`)
    const force = setTimeout(() => process.exit(1), 3000)
    force.unref?.()
    try {
      await instance.close()
      clearTimeout(force)
      process.exit(0)
    } catch (error) {
      console.error(`[dsh-launchpad] 关闭失败: ${error.message}`)
      process.exit(1)
    }
  }
  process.on('SIGINT', () => { void stop('SIGINT') })
  process.on('SIGTERM', () => { void stop('SIGTERM') })
}

/**
 * 目标地址解析（纯函数，供 host.mjs 与冒烟测试共用）。
 *
 * 优先级：config.url / 环境变量 URL
 *       > config.service → 中间件 discovery（services.json，服务解耦标准：
 *         端口事实归 discovery，不写死）
 *       > config.port / 环境变量端口 > 默认 39600。
 * 只接受 http/https；侧边栏 Browser tab 类型本身也只接受这两种协议。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 Browser tab 地址解析一致的协议白名单。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** 读中间件 discovery 里某服务的 url；文件缺失/无记录/未就绪 → undefined。
 *  口径与 broker 一致：固定用户级 ~/.dsh/services.json（不随 DSH_HOME——
 *  broker 与 dsh 可能各持不同 DSH_HOME，discovery 必须是同一张表）。 */
function discoveryUrl(serviceId, env) {
  const file = env.DSH_DISCOVERY_FILE
    || path.join(os.homedir(), '.dsh', 'services.json')
  try {
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const row = reg?.services?.[String(serviceId)]
    return typeof row?.url === 'string' && row.state === 'running' ? row.url : undefined
  } catch {
    return undefined
  }
}

/**
 * 从配置与环境变量解析注入目标。
 * @param config - cordis.patch.yml 行 config（url/service/port/host/path/restoreOnBoot）。
 * @param env - 进程环境变量（默认 process.env；测试可注入）。
 * @returns `{ url, restoreOnBoot }`，无法解析出合法地址时为 undefined。
 */
export function resolveTarget(config = {}, env = process.env) {
  let url = typeof config.url === 'string' && config.url.trim() !== '' ? config.url.trim() : undefined
  if (url === undefined) {
    const envUrl = typeof env.DSH_PORT_SIDEBAR_URL === 'string' && env.DSH_PORT_SIDEBAR_URL.trim() !== ''
      ? env.DSH_PORT_SIDEBAR_URL.trim()
      : undefined
    if (envUrl !== undefined) url = envUrl
  }
  if (url === undefined && typeof config.service === 'string' && config.service.trim() !== '') {
    url = discoveryUrl(config.service.trim(), env)
  }
  if (url === undefined) {
    const port = Number(config.port) > 0
      ? Number(config.port)
      : Number(env.DSH_PORT_SIDEBAR_PORT) > 0 ? Number(env.DSH_PORT_SIDEBAR_PORT) : 39600
    const host = typeof config.host === 'string' && config.host.trim() !== '' ? config.host.trim() : '127.0.0.1'
    const path = typeof config.path === 'string' && config.path !== '' ? config.path : '/'
    url = `http://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    console.warn(`[dsh-port-sidebar] 无法解析目标地址，忽略注入: ${url}`)
    return undefined
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`[dsh-port-sidebar] 仅支持 http/https 目标地址，忽略注入: ${url}`)
    return undefined
  }
  const restoreEnv = typeof env.DSH_PORT_SIDEBAR_RESTORE === 'string'
    ? !/^(0|false|off)$/i.test(env.DSH_PORT_SIDEBAR_RESTORE.trim())
    : undefined
  const restoreOnBoot = restoreEnv !== undefined
    ? restoreEnv
    : config.restoreOnBoot !== false
  // 强制保活：关闭后立即重开，除非显式关掉（插件卸载仍然会整体失效）。
  const keepAliveEnv = typeof env.DSH_PORT_SIDEBAR_KEEP_ALIVE === 'string'
    ? !/^(0|false|off)$/i.test(env.DSH_PORT_SIDEBAR_KEEP_ALIVE.trim())
    : undefined
  const keepAlive = keepAliveEnv !== undefined
    ? keepAliveEnv
    : config.keepAlive !== false
  return { url, restoreOnBoot, keepAlive }
}

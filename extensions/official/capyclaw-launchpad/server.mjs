#!/usr/bin/env node
/**
 * dsh-launchpad 独立服务入口（broker 清单用）。
 *
 *   node server.mjs --port 39700 [--roots a,b] [--discovery <file>]
 *                   [--broker-url <url>] [--token <t>]
 *                   [--launchpads <dir>] [--dshd <dshd.mjs>]
 *
 * 只绑 127.0.0.1；/healthz 报 pid/port，供 broker 收编与身份核验。
 * `/` 是同端口的管理界面；launchpad DSL 的启动/停止经 dshd 执行。
 */
import { isMain, parseArgs } from '@capyclaw/plugin-kit'

import { installSignalHandlers, startServer } from './lib/serve.mjs'

const USAGE = `dsh-launchpad 独立服务

用法:
  node server.mjs [--port 39700] [--host 127.0.0.1] [--roots a,b]
                  [--dsh-home <dir>] [--no-profiles]
                  [--discovery <file>] [--broker-url <url>] [--token <t>]
                  [--launchpads <dir>] [--dshd <path/to/dshd.mjs>]

环境变量:
  DSH_HOME / DSH_DISCOVERY_FILE / DSH_BROKER_URL / DSH_BROKER_TOKEN
  LAUNCHPAD_ROOTS / LAUNCHPAD_TOKEN / DSH_LAUNCHPAD_DIR / DSH_LAUNCHPAD_DSHD`

function str(value) {
  return typeof value === 'string' && value ? value : undefined
}

function intFlag(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`--${name} 需要非负整数`)
  return Number(value)
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    console.log(USAGE)
    return
  }
  const port = flags.port === undefined ? 39700 : intFlag(flags.port, 'port')
  const roots = typeof flags.roots === 'string'
    ? flags.roots.split(',').map((item) => item.trim()).filter(Boolean)
    : undefined
  const instance = await startServer({
    port,
    host: str(flags.host) || '127.0.0.1',
    roots,
    dshHome: str(flags['dsh-home']),
    includeProfiles: !flags['no-profiles'],
    discovery: str(flags.discovery),
    brokerUrl: str(flags['broker-url']),
    brokerToken: str(flags['broker-token']),
    launchpadsDir: str(flags.launchpads),
    dshd: str(flags.dshd),
    token: str(flags.token) || process.env.LAUNCHPAD_TOKEN,
    env: process.env,
    cwd: process.cwd(),
  })
  installSignalHandlers(instance)
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  })
}

export { main }

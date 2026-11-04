#!/usr/bin/env node
/**
 * launchpad — 启动清单管理器 CLI。
 *
 * scan / validate / status / doctor 只读；
 * start / stop / apply 只向 broker 投递结构化命令，不直接 spawn/kill。
 */
import { isMain, parseArgs } from '@capyclaw/plugin-kit'

import {
  analyze,
  applyManifest,
  buildDoctor,
  buildStatus,
  scan,
  startService,
  stopService,
} from '../lib/index.mjs'
import {
  formatActionResult,
  formatDoctor,
  formatScan,
  formatStatus,
  formatValidate,
} from '../lib/format.mjs'
import { installSignalHandlers, startServer } from '../lib/serve.mjs'

const USAGE = `launchpad — 启动清单管理器

用法:
  launchpad scan      [--roots a,b] [--json] [--fail-on error|warning]
  launchpad validate  [--roots a,b] [--json] [--fail-on error|warning]
  launchpad status    [--roots a,b] [--probe] [--no-probe] [--json]
  launchpad doctor    [--roots a,b] [--json]
  launchpad start <service-id> [--manifest <ref>] [--dry-run] [--json]
  launchpad stop  <service-id> [--manifest <ref>] [--dry-run] [--json]
  launchpad apply <manifest-ref> [--dry-run] [--json]
  launchpad serve     [--port 39700] [--host 127.0.0.1] [--roots a,b] [--token <t>]
                      [--launchpads <dir>] [--dshd <path/to/dshd.mjs>]

通用选项:
  --roots <a,b>         扫描根（默认自动探测仓库根；可多次/逗号分隔）
  --root <dir>          单个扫描根
  --dsh-home <dir>      DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
  --no-profiles         不扫描 <DSH_HOME>/profiles/*/package.json
  --discovery <file>    discovery 文件（默认 $DSH_DISCOVERY_FILE 或 ~/.dsh/services.json）
  --broker-url <url>    broker 控制端点（默认 $DSH_BROKER_URL / launcher state）
  --broker-token <t>    broker token（默认 $DSH_BROKER_TOKEN）
  --json                机器可读输出
  --help                显示帮助

动作:
  start/stop/apply 需要 broker 可达；--dry-run 只打印将发送的 spec/命令。
  stop launchpad 自身会被拒绝（除非 --allow-self-stop）。`

function str(value) {
  return typeof value === 'string' && value ? value : undefined
}

function intFlag(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw usageError(`--${name} 需要非负整数`)
  }
  return Number(value)
}

function usageError(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

function scanOptions(flags) {
  const roots = []
  for (const raw of [flags.roots, flags.root]) {
    if (typeof raw !== 'string') continue
    for (const item of raw.split(',')) {
      const value = item.trim()
      if (value) roots.push(value)
    }
  }
  return {
    roots,
    dshHome: str(flags['dsh-home']),
    includeProfiles: !flags['no-profiles'],
    cwd: process.cwd(),
  }
}

function runtimeOptions(flags) {
  return {
    discovery: str(flags.discovery),
    brokerUrl: str(flags['broker-url']),
    brokerToken: str(flags['broker-token']),
    env: process.env,
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function outputActionResult(result, action, flags) {
  if (flags.json) printJson(result)
  else process.stdout.write(formatActionResult(result, action))
  if (result.ok === false) process.exitCode = 1
}

async function loadInventory(flags) {
  const result = await scan(scanOptions(flags))
  return { inventory: analyze(result), scan: result }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    console.log(USAGE)
    return
  }
  const command = positional[0]

  if (!command) {
    console.log(USAGE)
    return
  }

  if (command === 'scan' || command === 'validate') {
    const { inventory } = await loadInventory(flags)
    if (flags.json) printJson({ ok: inventory.summary.errors === 0, ...inventory })
    else process.stdout.write(command === 'scan' ? formatScan(inventory) : formatValidate(inventory))
    const failOn = str(flags['fail-on']) || (command === 'validate' ? 'error' : undefined)
    if (failOn && !['error', 'warning'].includes(failOn)) {
      throw usageError('--fail-on 只能是 error 或 warning')
    }
    if (failOn === 'warning' && inventory.summary.errors + inventory.summary.warnings > 0) process.exitCode = 1
    if (failOn === 'error' && inventory.summary.errors > 0) process.exitCode = 1
    return
  }

  if (command === 'status') {
    const { inventory } = await loadInventory(flags)
    const probe = !!flags.probe && !flags['no-probe']
    const status = await buildStatus(inventory, { ...runtimeOptions(flags), probe })
    if (flags.json) printJson({ ok: true, ...status })
    else process.stdout.write(formatStatus(status))
    return
  }

  if (command === 'doctor') {
    const { inventory } = await loadInventory(flags)
    const doctor = await buildDoctor(inventory, runtimeOptions(flags))
    if (flags.json) printJson({ ok: doctor.ok, ...doctor })
    else process.stdout.write(formatDoctor(doctor))
    if (!doctor.ok) process.exitCode = 1
    return
  }

  if (command === 'start' || command === 'stop') {
    const serviceId = positional[1]
    if (!serviceId) throw usageError(`缺少服务 id：launchpad ${command} <service-id>`)
    const { inventory } = await loadInventory(flags)
    const options = {
      serviceId,
      manifestRef: str(flags.manifest),
      ...runtimeOptions(flags),
      dryRun: !!flags['dry-run'],
      waitMs: intFlag(flags.wait, 'wait'),
      timeoutMs: intFlag(flags.timeout, 'timeout'),
    }
    const result = command === 'start'
      ? await startService(inventory, options)
      : await stopService(inventory, { ...options, allowSelfStop: !!flags['allow-self-stop'] })
    outputActionResult(result, `${command} ${serviceId}`, flags)
    return
  }

  if (command === 'apply') {
    const manifestRef = positional[1]
    if (!manifestRef) throw usageError('缺少清单引用：launchpad apply <manifest-ref>')
    const { inventory } = await loadInventory(flags)
    const result = await applyManifest(inventory, {
      manifestRef,
      ...runtimeOptions(flags),
      dryRun: !!flags['dry-run'],
      waitMs: intFlag(flags.wait, 'wait'),
      timeoutMs: intFlag(flags.timeout, 'timeout'),
    })
    outputActionResult(result, `apply ${manifestRef}`, flags)
    return
  }

  if (command === 'serve') {
    const port = flags.port === undefined ? 39700 : intFlag(flags.port, 'port')
    if (port < 0 || port > 65535) throw usageError('--port 必须是 0-65535 的整数')
    const instance = await startServer({
      port,
      host: str(flags.host) || '127.0.0.1',
      ...scanOptions(flags),
      ...runtimeOptions(flags),
      launchpadsDir: str(flags.launchpads),
      dshd: str(flags.dshd),
      token: str(flags.token) || process.env.LAUNCHPAD_TOKEN,
      env: process.env,
    })
    installSignalHandlers(instance)
    return
  }

  console.log(USAGE)
  process.exitCode = 2
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`)
    if (process.argv.includes('--json')) {
      printJson({
        ok: false,
        error: {
          code: error.code || 'ERROR',
          message: error.message,
          ...(error.candidates ? { candidates: error.candidates } : {}),
        },
      })
    }
    process.exit(error.code === 'USAGE' ? 2 : 1)
  })
}

export { main }

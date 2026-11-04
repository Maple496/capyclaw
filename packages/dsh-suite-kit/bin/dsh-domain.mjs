#!/usr/bin/env node
/**
 * dsh-domain CLI：
 *   dsh-domain validate <domain>
 *   dsh-domain resolve  <domain>
 *   dsh-domain install  <domain> [--profile name] [--dsh-home dir] [--dry-run]
 *   dsh-domain stage    <domain> --out <dir>
 *   dsh-domain launch   <domain> --dsh-bin <path> [--profile name] [--port n] [--stage]
 *   dsh-domain doctor   --profile name [--dsh-bin path]
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  doctor, formatReport, installDomain, domainPatch, loadDomainManifest,
  resolveDomain, stageDomain, validateDomainManifest,
  createRuntime, defaultRuntimeStoreRoot, readRuntime, startRuntime,
} from '../src/index.mjs'

function parse(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) { args.push(item); continue }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { flags[key] = next; i++ }
    else flags[key] = true
  }
  return { args, flags }
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function cmdValidate(input) {
  if (!input) fail('用法: dsh-domain validate <domain>')
  const loaded = loadDomainManifest(input)
  const result = validateDomainManifest(loaded.manifest)
  for (const warning of result.warnings) console.log(`! ${warning}`)
  for (const error of result.errors) console.log(`✗ ${error}`)
  console.log(result.ok ? `✓ ${loaded.manifest.name}` : '✗ domain 校验失败')
  process.exit(result.ok ? 0 : 1)
}

function cmdResolve(input, flags) {
  if (!input) fail('用法: dsh-domain resolve <domain>')
  const resolved = resolveDomain(input)
  if (flags.patch) { console.log(domainPatch(input)); return }
  console.log(JSON.stringify({
    domain: resolved.manifest.name,
    components: resolved.suites.map((suite) => suite.manifest.name),
    capabilities: resolved.composed.capabilities,
    rows: resolved.composed.rows,
    checks: resolved.composed.checks,
    warnings: resolved.composed.warnings,
  }, null, 2))
}

function cmdInstall(input, flags) {
  if (!input) fail('用法: dsh-domain install <domain>')
  try {
    const plan = installDomain({
      domainInput: input,
      profile: flags.profile,
      dshHome: flags['dsh-home'],
      dryRun: !!flags['dry-run'],
      runPnpm: !flags['no-pnpm'],
    })
    console.log(JSON.stringify(plan, null, 2))
  } catch (error) {
    fail(error.message)
  }
}

function cmdStage(input, flags) {
  if (!input || !flags.out) fail('用法: dsh-domain stage <domain> --out <dir>')
  try {
    const result = stageDomain({ domainInput: input, outDir: flags.out })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    fail(error.message)
  }
}

async function cmdLaunch(input, flags) {
  if (!input) fail('用法: dsh-domain launch <domain> --dsh-bin <path>')
  let domainInput = input
  if (flags.stage) {
    const out = flags.out || path.resolve(`.dsh-domain-${Date.now()}`)
    const staged = stageDomain({ domainInput: input, outDir: out })
    domainInput = path.join(staged.outDir, 'domain.json')
    console.log(`✓ staged → ${staged.outDir}`)
  }
  if (flags.runtime) {
    const storeRoot = path.resolve(flags['store-root'] || defaultRuntimeStoreRoot())
    let runtime
    try {
      runtime = readRuntime(storeRoot, String(flags.runtime))
    } catch {
      runtime = await createRuntime({
        name: String(flags.runtime),
        domainInput,
        storeRoot,
        harnessPort: flags.port != null ? Number(flags.port) : undefined,
        contentPort: flags['content-port'] != null ? Number(flags['content-port']) : undefined,
        runPnpm: false,
      })
      console.log(`✓ runtime ${runtime.runtimeId} 已创建`)
    }
    const result = await startRuntime({
      storeRoot,
      runtimeId: runtime.runtimeId,
      harnessDir: flags['harness-dir'],
      dshBin: flags['dsh-bin'],
      detached: !flags.foreground,
      waitMs: flags['no-wait'] ? 0 : 30000,
    })
    console.log(`✓ runtime ${runtime.runtimeId} 已在运行：http://127.0.0.1:${result.runtime.ports.harness}/（显示端口 ${result.runtime.ports.content}）`)
    return
  }
  const plan = installDomain({
    domainInput,
    profile: flags.profile,
    dshHome: flags['dsh-home'],
    runPnpm: !flags['no-pnpm'],
  })
  const profile = flags.profile || plan.profile
  const port = flags.port || plan.profileMeta?.port || '3080'
  const env = { ...process.env }
  if (flags['dsh-home']) env.DSH_HOME = path.resolve(flags['dsh-home'])
  if (flags['auth-proxy']) {
    const proxyPort = String(flags['proxy-port'] || Number(port) + 1)
    const proxy = path.resolve(flags['auth-proxy'])
    Object.assign(env, {
      DSH_PROFILE: profile,
      DSH_UP_PORT: String(port),
      DSH_PROXY_PORT: proxyPort,
    })
    console.log(`启动 auth-proxy: ${proxy}（浏览器入口 http://localhost:${proxyPort}/）`)
    const result = spawnSync(process.execPath, [proxy], { stdio: 'inherit', env })
    process.exit(result.status ?? 1)
  }
  const command = flags['dsh-bin'] || 'dsh'
  const args = ['--profile', profile, '--port', String(port), '--no-open']
  console.log(`启动: ${command} ${args.join(' ')}`)
  if (!flags['dsh-bin']) {
    console.log('未提供 --dsh-bin，只完成安装；请手动执行上面的命令。')
    return
  }
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
  process.exit(result.status ?? 1)
}

async function cmdDoctor(flags) {
  const report = await doctor({
    profile: flags.profile,
    dshHome: flags['dsh-home'],
    dshBin: flags['dsh-bin'],
  })
  console.log(formatReport(report))
  process.exitCode = report.ok ? 0 : 1
}

const { args, flags } = parse(process.argv.slice(2))
const [command] = args
if (!command || command === 'help' || command === '--help') {
  console.log(`dsh-domain — 领域包启动器

  validate <domain>                 校验 domain manifest
  resolve <domain> [--patch]        解析组件/能力/row，或打印 patch
  install <domain>                 生成专用 profile
  stage <domain> --out <dir>       只打包选中组件
  launch <domain> --dsh-bin <path> 安装并启动专用 profile
  launch <domain> --runtime <name> 按 runtime 隔离启动（推荐）
  doctor --profile name            运行健康检查
`)
  process.exit(0)
}
if (command === 'validate') cmdValidate(args[1])
else if (command === 'resolve') cmdResolve(args[1], flags)
else if (command === 'install') cmdInstall(args[1], flags)
else if (command === 'stage') cmdStage(args[1], flags)
else if (command === 'launch') await cmdLaunch(args[1], flags)
else if (command === 'doctor') await cmdDoctor(flags)
else fail(`未知命令: ${command}`)

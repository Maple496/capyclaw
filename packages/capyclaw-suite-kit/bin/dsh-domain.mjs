#!/usr/bin/env node
/**
 * dsh-domain CLI：
 *   dsh-domain validate <domain>
 *   dsh-domain resolve  <domain>
 *   dsh-domain registry <domain>
 *   dsh-domain doctor   --profile name [--dsh-bin path]
 */
import {
  buildActivationRegistry, doctor, formatReport, loadDomainManifest,
  resolveDomain, validateDomainManifest,
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

function cmdResolve(input) {
  if (!input) fail('用法: dsh-domain resolve <domain>')
  const resolved = resolveDomain(input)
  console.log(JSON.stringify({
    domain: resolved.manifest.name,
    components: resolved.suites.map((suite) => suite.manifest.name),
    capabilities: resolved.composed.capabilities,
    rows: resolved.composed.rows,
    checks: resolved.composed.checks,
    warnings: resolved.composed.warnings,
  }, null, 2))
}

function cmdRegistry(input) {
  if (!input) fail('用法: dsh-domain registry <domain>')
  try {
    const resolved = resolveDomain(input)
    const { registry, warnings } = buildActivationRegistry({
      suites: resolved.suites,
      composed: resolved.composed,
      requiredCapabilities: resolved.manifest.runtime?.requires?.capabilities || [],
    })
    for (const warning of warnings) console.error(`! ${warning}`)
    console.log(JSON.stringify(registry, null, 2))
  } catch (error) {
    fail(error.message)
  }
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
  console.log(`dsh-domain — 领域包校验器

  validate <domain>                 校验 domain manifest
  resolve <domain>                  解析组件/能力/row
  registry <domain>                 生成 launch-engine 激活注册表（预览）
  doctor --profile name             运行健康检查
`)
  process.exit(0)
}
if (command === 'validate') cmdValidate(args[1])
else if (command === 'resolve') cmdResolve(args[1])
else if (command === 'registry') cmdRegistry(args[1])
else if (command === 'doctor') await cmdDoctor(flags)
else fail(`未知命令: ${command}`)

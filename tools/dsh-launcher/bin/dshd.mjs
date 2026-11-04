#!/usr/bin/env node
/**
 * dshd — dsh + 插件 全栈独立启动器（不依赖桌面前端）。
 *
 *   dshd start --stack <file>  从统一启动清单编译 profile + 服务，再启动
 *   dshd start --foreground    同上 + 前台守护（dsh 崩溃自动重启；Ctrl+C 全停）
 *   dshd start --open          就绪后打开浏览器
 *   dshd stop                  停服务（经 broker）→ 停 broker → 停 dsh
 *   dshd status                运行态一览
 *   dshd doctor                体检（pid + 端点）
 *   dshd logs                  列出日志文件
 *   dshd stack plan|apply      编译统一启动清单（不启动）
 *
 * 启动入口只有 --stack <dsh-stack.json>（作者层是 launchpads/*.stack DSL）；
 * 旧的 dshd.config.json + local-services.json 配置路径已删除。
 */
import { parseArgs, isMain, fail } from '@capyclaw/plugin-kit/cli'
import { assertConfig, PKG_DIR } from '../lib/config.mjs'
import {
  listLogs, printDoctor, printStatus, start, stop, supervise,
} from '../lib/launcher.mjs'
import {
  applyStack, loadDomainLifecycleConfig, loadStack, loadStackConfig, planStack, summarizePlan,
} from '../lib/stack.mjs'
import {
  applyDomainStack, assertDomainConfig, describeDomain, listDomainLogs,
  printDomainDoctor, printDomainStatus, startDomain, stopDomain, superviseDomain,
} from '../lib/domain.mjs'

const USAGE = `dshd — dsh 全栈独立启动器

用法:
  dshd start [--stack <file>] [--foreground] [--open] [--no-install]
  dshd stop    --stack <file>
  dshd status  --stack <file>
  dshd doctor  --stack <file>
  dshd logs    --stack <file>
  dshd stack plan|apply --stack <file> [--no-install] [--recreate] [--json]
  dshd stack config --stack <file> [--json]   （只读：看插件配置合并结果）

统一清单: dsh-stack.json（--stack 指定；kind=profile 编译 profile+services，kind=domain 交给 domain runtime）
作者层:   launchpads/*.stack DSL（capyclaw-launchpad 编译成 dsh-stack.json）
位置参考: ${PKG_DIR}`

function printPlan(plan) {
  if (!plan.valid) {
    console.error('✗ stack 校验失败')
    for (const error of plan.errors) console.error(`  - ${error}`)
    for (const warning of plan.warnings) console.error(`  ! ${warning}`)
    return
  }
  const summary = summarizePlan(plan)
  if (summary.kind === 'domain') {
    console.log(`stack:   ${summary.stack}`)
    console.log(`kind:    domain`)
    console.log(`source:  ${summary.domain.source}`)
    console.log(`runtime: ${summary.domain.runtimeId}（${summary.changes?.domain?.exists ? '已存在' : '将创建'}）`)
    console.log(`store:   ${summary.domain.storeRoot}`)
    if (summary.domain.summary) {
      console.log(`components: ${summary.domain.summary.components.join(', ') || '(none)'}`)
      console.log(`services:   ${summary.domain.summary.services.join(', ') || '(none)'}`)
    }
    for (const warning of summary.warnings) console.log(`! ${warning}`)
    return
  }
  console.log(`stack:   ${summary.stack}`)
  console.log(`profile: ${summary.profile}`)
  console.log(`bundles: ${summary.bundles.join(', ') || '(none)'}`)
  console.log(`deps:    +[${summary.dependenciesAdded.join(', ')}] ~[${summary.dependenciesUpdated.join(', ')}]`)
  console.log(`services:${summary.services.join(', ') || '(none)'}`)
  if (summary.serviceChanges.length) {
    console.log(`changes: ${summary.serviceChanges.map((item) => `${item.id}:${item.change}`).join(', ')}`)
  }
  console.log(`manifest:${summary.manifest} ${summary.manifestChanged ? '(will write)' : '(up to date)'}`)
  console.log(`install: ${summary.installNeeded ? 'needed' : 'not needed'}`)
  for (const warning of summary.warnings) console.log(`! ${warning}`)
}

function printApplied(result) {
  if (result.kind === 'domain') {
    console.log(`✓ domain stack applied${result.created ? '（新建 runtime）' : '（复用已有 runtime）'}`)
    console.log(`  runtime: ${result.runtimeId}`)
    console.log(`  source:  ${result.source}`)
    console.log(`  store:   ${result.storeRoot}`)
    console.log(`  profile: ${result.runtime.profile}`)
    console.log(`  ports:   harness=${result.runtime.ports.harness} dsh=${result.runtime.ports.dsh} content=${result.runtime.ports.content}`)
    console.log(`  services:${result.domain.services.join(', ') || '(none)'}`)
    for (const warning of result.warnings || []) console.log(`  ! ${warning}`)
    return
  }
  console.log('✓ stack applied')
  console.log(`  stack:   ${result.stack.path}`)
  console.log(`  profile: ${result.profilePackageFile}`)
  console.log(`  bundles: ${result.profile.bundles.join(', ') || '(none)'}`)
  console.log(`  manifest:${result.manifestFile}`)
  console.log(`  services:${result.services.map((service) => service.id).join(', ') || '(none)'}`)
  if (result.installSkipped) console.log('  ⚠ install skipped (--no-install)')
  for (const warning of result.warnings) console.log(`  ! ${warning}`)
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0] || ''
  if (!command || flags.help) {
    console.log(USAGE)
    return
  }
  if (flags.config) throw new Error('--config 已删除：统一用 --stack <dsh-stack.json>（作者层 launchpads/*.stack DSL）')

  if (command === 'stack') {
    const sub = positional[1]
    const stackPath = flags.stack || positional[2]
    if (!sub || !['plan', 'apply', 'config'].includes(sub)) {
      console.log(USAGE)
      process.exitCode = 1
      return
    }
    if (!stackPath) {
      console.error('用法: dshd stack plan|apply|config --stack <file>')
      process.exitCode = 1
      return
    }
    const stack = loadStack(stackPath)
    if (sub === 'config') {
      // 只读：打印 stack.plugins.configs 合并插件默认值后的结果，便于排查参数到底传了什么
      const plan = planStack(stack)
      if (!plan.valid) {
        console.error('✗ stack 校验失败')
        for (const error of plan.errors || []) console.error(`  - ${error}`)
        process.exitCode = 1
        return
      }
      const rows = plan.changes?.pluginConfigs?.rows || []
      const details = plan.profile?.configPatches?.details || []
      if (flags.json) {
        console.log(JSON.stringify({ file: plan.changes?.pluginConfigs?.file, rows, details }, null, 2))
        return
      }
      console.log(`插件配置（写入 ${plan.changes?.pluginConfigs?.file || '(无)'}）`)
      if (!rows.length) {
        console.log('  (stack 没有声明 plugins.configs)')
        return
      }
      for (const detail of details) {
        console.log(`\n  ${detail.bundle} → row ${detail.row}`)
        console.log(`    默认: ${JSON.stringify(detail.defaults)}`)
        console.log(`    覆盖: ${JSON.stringify(detail.overrides)}`)
        console.log(`    合并: ${JSON.stringify(detail.merged)}`)
      }
      return
    }
    if (sub === 'plan') {
      const plan = planStack(stack)
      if (plan.valid && plan.kind === 'domain') {
        try { plan.domain = { ...plan.domain, summary: describeDomain(plan.domain.source) } }
        catch (error) { plan.warnings = [...(plan.warnings || []), `无法解析 domain: ${error.message}`] }
      }
      if (flags.json) console.log(JSON.stringify(plan, null, 2))
      else printPlan(plan)
      if (!plan.valid) process.exitCode = 1
      return
    }
    if (stack.kind === 'domain') {
      const result = await applyDomainStack(stack, { recreate: !!flags.recreate })
      if (flags.json) console.log(JSON.stringify(result, null, 2))
      else printApplied(result)
      return
    }
    const result = applyStack(stack, { install: !flags['no-install'] })
    if (flags.json) console.log(JSON.stringify(result, null, 2))
    else printApplied(result)
    return
  }

  let cfg
  if (flags.stack) {
    const raw = loadStack(flags.stack)
    const lifecycle = ['stop', 'status', 'doctor', 'logs'].includes(command)
    cfg = raw.kind === 'domain' && lifecycle
      ? loadDomainLifecycleConfig(flags.stack)
      : loadStackConfig(flags.stack)
  } else {
    throw new Error('缺少 --stack <dsh-stack.json>（作者层用 launchpads/*.stack DSL，由 launchpad 编译）')
  }
  if (cfg.kind === 'domain') {
    cfg = assertDomainConfig(cfg, { forStart: command === 'start' })
    switch (command) {
      case 'start': {
        const result = await startDomain(cfg, flags)
        if (flags.foreground && !result.started.alreadyRunning) await superviseDomain(cfg)
        break
      }
      case 'stop':
        await stopDomain(cfg)
        break
      case 'status':
        await printDomainStatus(cfg)
        break
      case 'doctor':
        await printDomainDoctor(cfg)
        break
      case 'logs': {
        const files = listDomainLogs(cfg)
        if (!files.length) { console.log('（还没有日志）'); break }
        for (const file of files) console.log(file)
        break
      }
      default:
        console.log(USAGE)
        process.exitCode = 1
    }
    return
  }
  if (cfg._stack) {
    if (command === 'start') {
      const applied = applyStack(cfg._stack, { install: !flags['no-install'] })
      cfg.manifest = applied.manifestFile
      cfg._compiled = applied
      console.log(`stack applied: ${applied.profilePackageFile}`)
      if (applied.installSkipped) console.log('stack: install skipped (--no-install)')
    } else {
      // stop/status/doctor/logs 只需要 stateDir；用 stack 文件满足 assertConfig 的 manifest 存在检查
      cfg.manifest = cfg._stackPath
    }
  }
  cfg = assertConfig(cfg)

  const sessionToken = flags['product-session'] ? process.env.DSH_PRODUCT_SESSION_TOKEN : undefined
  if (flags['product-session'] && !/^[a-f0-9]{48}$/.test(sessionToken || '')) throw new Error('产品会话令牌无效')
  switch (command) {
    case 'start': {
      const result = await start(cfg, { ...flags, sessionToken })
      if (flags.foreground && !result.already) await supervise(cfg)
      break
    }
    case 'stop':
      await stop(cfg, { sessionToken })
      break
    case 'status':
      await printStatus(cfg)
      break
    case 'doctor':
      await printDoctor(cfg)
      break
    case 'logs': {
      const files = listLogs(cfg)
      if (!files.length) { console.log('（还没有日志）'); break }
      for (const f of files) console.log(f)
      break
    }
    default:
      console.log(USAGE)
      process.exitCode = 1
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    fail(error.code === 'STACK_INVALID' ? error.message : (error.stack || error.message))
  })
}

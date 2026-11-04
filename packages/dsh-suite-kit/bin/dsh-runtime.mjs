#!/usr/bin/env node
/**
 * dsh-runtime — 每个 DSH 进程一个 runtime lease 的标准启动器。
 *
 *   dsh-runtime create --name a --domain <domain> [--store-root dir] [--harness-port 3080] [--content-port 39311]
 *   dsh-runtime start <runtimeId> [--foreground]
 *   dsh-runtime stop <runtimeId>
 *   dsh-runtime list
 *   dsh-runtime show <runtimeId>
 *   dsh-runtime doctor <runtimeId>
 *   dsh-runtime rm <runtimeId> [--keep-store]
 *   dsh-runtime gc [--ttl-hours 24]
 *
 * 所有 runtime 共享一个 DSH_STORE_ROOT；各自有 namespace token 和独立端口。
 */
import path from 'node:path'
import { parseArgs, fail } from '../../dsh-plugin-kit/src/cli.mjs'
import {
  createRuntime, defaultRuntimeStoreRoot, doctorRuntime, gcRuntimes,
  listRuntimes, readRuntime, removeRuntime, runtimePublicInfo,
  startRuntime, stopRuntime, WorkspaceManager,
} from '../src/index.mjs'

/* CLI 脚手架复用 dsh-plugin-kit（parseArgs/fail）——不再手写。 */

function storeRoot(flags) {
  return path.resolve(flags['store-root'] || defaultRuntimeStoreRoot())
}

async function cmdCreate(flags) {
  if (!flags.name || !flags.domain) fail('用法: dsh-runtime create --name <name> --domain <domain>')
  try {
    const runtime = await createRuntime({
      name: flags.name,
      domainInput: flags.domain,
      storeRoot: storeRoot(flags),
      harnessPort: flags['harness-port'] != null ? Number(flags['harness-port']) : undefined,
      dshPort: flags['dsh-port'] != null ? Number(flags['dsh-port']) : undefined,
      contentPort: flags['content-port'] != null ? Number(flags['content-port']) : undefined,
      portRange: flags['port-range'] != null ? Number(flags['port-range']) : undefined,
      profile: flags.profile,
      workId: flags['work-id'],
      ttlSec: flags['ttl-hours'] != null ? Number(flags['ttl-hours']) * 3600 : undefined,
      runPnpm: !!flags.pnpm,
    })
    console.log(JSON.stringify(runtimePublicInfo(runtime), null, 2))
    console.log(`✓ runtime ${runtime.runtimeId} 已创建；启动: dsh-runtime start ${runtime.runtimeId}`)
  } catch (error) {
    fail(error.stack || error.message)
  }
}

async function cmdStart(runtimeId, flags) {
  if (!runtimeId) fail('用法: dsh-runtime start <runtimeId>')
  try {
    const result = await startRuntime({
      storeRoot: storeRoot(flags),
      runtimeId,
      harnessDir: flags['harness-dir'],
      dshBin: flags['dsh-bin'],
      detached: !flags.foreground,
      waitMs: flags['no-wait'] ? 0 : (flags['wait-ms'] ? Number(flags['wait-ms']) : 30000),
    })
    console.log(JSON.stringify(runtimePublicInfo(result.runtime), null, 2))
    console.log(result.alreadyRunning ? '✓ runtime 已在运行' : `✓ runtime 已启动（pid ${result.pid}${result.ready ? '，已就绪' : '，未在等待时间内就绪'}）`)
  } catch (error) {
    fail(error.stack || error.message)
  }
}

async function cmdStop(runtimeId, flags) {
  if (!runtimeId) fail('用法: dsh-runtime stop <runtimeId>')
  try {
    const runtime = await stopRuntime({ storeRoot: storeRoot(flags), runtimeId })
    console.log(`✓ runtime ${runtime.runtimeId} 已停止`)
  } catch (error) {
    fail(error.message)
  }
}

function cmdList(flags) {
  const list = listRuntimes(storeRoot(flags))
  if (!list.length) { console.log('（没有 runtime）'); return }
  for (const runtime of list) {
    const info = runtimePublicInfo(runtime)
    console.log([
      `${info.running ? '●' : '○'} ${info.runtimeId}`,
      `domain=${info.domain}`,
      `harness=${info.ports.harness}`,
      `content=${info.ports.content}`,
      `profile=${info.profile}`,
      `status=${info.status}`,
    ].join('  '))
  }
}

function cmdWorks(runtimeId, flags) {
  const manager = new WorkspaceManager({ storeRoot: storeRoot(flags) })
  const works = manager.refreshCatalog({ runtimeId: runtimeId || '' })
  if (!works.length) { console.log('（没有 work）'); return }
  for (const work of works) {
    const scope = work.declaration?.files?.join(',') || '**'
    console.log(`${work.runtimeId}/${work.workId}  v${work.version}  files=${work.files}  scope=${scope}  ${work.title || ''}`)
  }
}

function cmdDeclare(runtimeId, workId, flags) {
  if (!runtimeId || !workId) fail('用法: dsh-runtime declare <runtimeId> <workId> --files <a,b> [--no-new]')
  const files = String(flags.files || '**').split(',').map((item) => item.trim()).filter(Boolean)
  const manager = new WorkspaceManager({ storeRoot: storeRoot(flags) })
  const manifest = manager.declareWork(runtimeId, workId, {
    files,
    allowNew: !flags['no-new'],
    title: flags.title || '',
  })
  console.log(JSON.stringify(manifest.declaration, null, 2))
  console.log(`✓ ${runtimeId}/${workId} 声明已更新`)
}

function cmdShow(runtimeId, flags) {
  if (!runtimeId) fail('用法: dsh-runtime show <runtimeId>')
  try {
    const runtime = readRuntime(storeRoot(flags), runtimeId)
    console.log(JSON.stringify(runtimePublicInfo(runtime), null, 2))
  } catch (error) {
    fail(error.message)
  }
}

async function cmdDoctor(runtimeId, flags) {
  if (!runtimeId) fail('用法: dsh-runtime doctor <runtimeId>')
  try {
    const report = await doctorRuntime({ storeRoot: storeRoot(flags), runtimeId })
    for (const check of report.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.id}${check.url ? ` ${check.url}` : ''}${check.error ? ` — ${check.error}` : ''}`)
    }
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    fail(error.message)
  }
}

function cmdRemove(runtimeId, flags) {
  if (!runtimeId) fail('用法: dsh-runtime rm <runtimeId>')
  try {
    const result = removeRuntime({ storeRoot: storeRoot(flags), runtimeId, keepStore: !!flags['keep-store'] })
    console.log(`✓ runtime ${result.runtimeId} 已移除`)
  } catch (error) {
    fail(error.message)
  }
}

async function cmdGc(flags) {
  const ttlHours = flags['ttl-hours'] != null ? Number(flags['ttl-hours']) : 24
  const result = await gcRuntimes({ storeRoot: storeRoot(flags), ttlSec: ttlHours * 3600 })
  console.log(`✓ 检查 ${result.checked} 个 runtime，清理 ${result.removed.length} 个`)
  for (const id of result.removed) console.log(`  - ${id}`)
}

const { positional: args, flags } = parseArgs(process.argv.slice(2))
const [command, runtimeId] = args
if (!command || command === 'help' || command === '--help') {
  console.log(`dsh-runtime — DSH runtime 隔离启动器

  create --name <name> --domain <domain>     分配端口/目录/namespace，安装 profile
  start <runtimeId> [--foreground]           启动 runtime（默认后台）
  stop <runtimeId>                           停止 runtime 及其进程树
  list                                       列出所有 runtime
  show <runtimeId>                           显示 runtime 详情
  works [runtimeId]                          查看中间层的 work 声明
  declare <runtimeId> <workId> --files a,b   声明该 work 管理哪些文件
  doctor <runtimeId>                         检查 harness/content/namespace
  rm <runtimeId> [--keep-store]              删除 runtime 记录与目录
  gc [--ttl-hours 24]                        清理过期且未运行的 runtime

全局参数：
  --store-root <dir>   默认 DSH_STORE_ROOT 或 ~/.dsh-store
`)
  process.exit(0)
}

if (command === 'create') await cmdCreate(flags)
else if (command === 'start') await cmdStart(runtimeId, flags)
else if (command === 'stop') await cmdStop(runtimeId, flags)
else if (command === 'list') cmdList(flags)
else if (command === 'show') cmdShow(runtimeId, flags)
else if (command === 'works') cmdWorks(runtimeId, flags)
else if (command === 'declare') cmdDeclare(runtimeId, args[2], flags)
else if (command === 'doctor') await cmdDoctor(runtimeId, flags)
else if (command === 'rm') cmdRemove(runtimeId, flags)
else if (command === 'gc') await cmdGc(flags)
else fail(`未知命令: ${command}`)

#!/usr/bin/env node
/**
 * 清单驱动的 dsh 启动器。
 *
 * 用法：
 *   node launch-by-manifest.mjs <manifest.json> [--home <dir>] [--workspace <dir>]
 *
 * 做什么：
 *   1. 读清单（plugins / entries）
 *   2. 生成临时 stack（把清单里的 plugins 全装上，禁用由 plugin-sync 做）
 *   3. stack apply + start（拉起 dsh + plugin-sync）
 *   4. 等 dsh 就绪后调 plugin-sync 的 /apply，按清单开关
 *   5. 打印最终 URL 与状态
 *
 * 清单格式：
 * {
 *   "version": 1,
 *   "plugins": [
 *     { "name": "@capyclaw/launchpad", "path": "./extensions/official/capyclaw-launchpad", "enabled": true },
 *     { "name": "@capyclaw/ppt-suite", "path": "./extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite", "enabled": false }
 *   ],
 *   "entries": [
 *     { "entryId": "include:launchpad-host", "enabled": false }
 *   ],
 *   "services": [
 *     { "name": "ppt-workbench", "cmd": ["node","./path/to/server.mjs"], "port": 39311 }
 *   ]
 * }
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DSHD = join(REPO, 'tools', 'dsh-launcher', 'bin', 'dshd.mjs')
const PLUGIN_SYNC_PATH = join(REPO, 'extensions', 'official', 'capyclaw-plugin-sync')
const KIT_PATH = join(REPO, 'packages', 'dsh-plugin-kit')

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function run(args, { cwd = REPO, timeout = 180000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} 失败（${result.status}）\n${result.stderr}`)
  }
  return result
}

async function waitFor(fn, { timeout = 30000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('等待超时')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help') {
    console.log('用法: node launch-by-manifest.mjs <manifest.json> [--home <dir>] [--workspace <dir>]')
    process.exit(0)
  }

  const manifestFile = resolve(args[0])
  if (!existsSync(manifestFile)) die(`清单不存在: ${manifestFile}`)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    die(`清单解析失败: ${error.message}`)
  }

  const homeArg = args.indexOf('--home')
  const workspaceArg = args.indexOf('--workspace')
  const home = homeArg > 0 ? resolve(args[homeArg + 1]) : join(tmpdir(), `dsh-launch-${Date.now()}`)
  const workspace = workspaceArg > 0 ? resolve(args[workspaceArg + 1]) : REPO
  const stateDir = join(home, '..', `${dirname(home).split(/[/\\]/).pop()}-state`)

  console.log(`清单: ${manifestFile}`)
  console.log(`home: ${home}`)
  console.log(`workspace: ${workspace}`)

  // ---- 1) 生成 stack：把清单里所有插件都装上（禁用交给 plugin-sync）----
  const bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    { name: '@capyclaw/plugin-sync', path: PLUGIN_SYNC_PATH },
  ]
  const dependencies = { 'dsh-plugin-kit': { path: KIT_PATH } }

  for (const plugin of manifest.plugins || []) {
    if (!plugin.name) die(`清单 plugins 里有条目缺 name`)
    if (!plugin.path) die(`清单 plugins[${plugin.name}] 缺 path`)
    const abs = resolve(workspace, plugin.path)
    if (!existsSync(join(abs, 'package.json'))) {
      die(`清单 plugins[${plugin.name}].path 下没有 package.json: ${abs}`)
    }
    bundles.push({ name: plugin.name, path: abs })
  }

  const services = (manifest.services || []).map((svc, i) => {
    if (!svc.name) die(`清单 services[${i}] 缺 name`)
    if (!svc.cmd) die(`清单 services[${i}] 缺 cmd（数组）`)
    if (!Array.isArray(svc.cmd)) die(`清单 services[${i}].cmd 必须是数组`)
    const abs = svc.cmd[0].startsWith('.') ? resolve(workspace, svc.cmd[0]) : svc.cmd[0]
    return {
      id: svc.name,
      name: svc.name,
      path: abs,
      args: svc.cmd.slice(1),
      port: svc.port || 0,
      env: svc.env || {},
    }
  })

  const stack = {
    name: `launch-${Date.now()}`,
    home,
    profile: 'web',
    workspace,
    stateDir,
    ports: { broker: 'auto', proxy: 'auto', upstream: 'auto' },
    plugins: {
      bundles,
      dependencies,
      configs: [
        { name: '@capyclaw/plugin-sync', config: { sourcePath: manifestFile, enableHttp: true } },
      ],
      install: true,
    },
    services,
  }

  const stackFile = join(tmpdir(), `stack-${Date.now()}.json`)
  await writeFile(stackFile, JSON.stringify(stack, null, 2))
  console.log(`stack: ${stackFile}\n`)

  // ---- 2) apply + start ----
  try {
    console.log('⏳ stack apply...')
    run([DSHD, 'stack', 'apply', '--stack', stackFile])
    console.log('✓ applied\n')

    console.log('⏳ dsh starting...')
    const startResult = run([DSHD, 'start', '--stack', stackFile], { timeout: 300000 })
    const proxyPort = startResult.stdout.match(/浏览器端口 (\d+)/)?.[1]
    if (!proxyPort) die('未找到代理端口')
    const dshUrl = `http://127.0.0.1:${proxyPort}/`
    console.log(`✓ dsh 就绪: ${dshUrl}\n`)

    // ---- 3) 等 plugin-sync 就绪并执行对齐 ----
    console.log('⏳ 等待 plugin-sync 就绪...')
    await waitFor(async () => {
      const res = await fetch(`${dshUrl}__plugin_sync__/report`, { signal: AbortSignal.timeout(3000) })
      return res.status === 200
    }, { timeout: 60000 })
    console.log('✓ plugin-sync 就绪\n')

    console.log('⏳ 读取差异...')
    const report = await fetch(`${dshUrl}__plugin_sync__/report`).then((r) => r.json())
    if (!report.ok) die(`读取报告失败: ${JSON.stringify(report)}`)

    const diff = report.report.diff
    console.log(`差异: ${diff.bundles.length} bundle + ${diff.entries.length} entry 需调整`)
    if (diff.missing.length) console.log(`⚠ 缺失: ${diff.missing.map((m) => m.name).join(', ')}`)
    if (diff.readonly.length) console.log(`⚠ 只读: ${diff.readonly.map((r) => r.entryId).join(', ')}`)

    if (diff.changes.length === 0) {
      console.log('✓ 已对齐，无需调整\n')
    } else {
      console.log(`\n⏳ 执行 ${diff.changes.length} 个变更...`)
      const applied = await fetch(`${dshUrl}__plugin_sync__/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: diff.changes }),
      }).then((r) => r.json())

      console.log(`✓ applied: ${applied.applied}, pending: ${applied.pending}, failed: ${applied.failed}`)
      if (applied.failed > 0) {
        console.log('失败详情:')
        for (const r of applied.results.filter((x) => !x.ok)) {
          console.log(`  - ${r.op} ${r.target}: ${JSON.stringify(r.error)}`)
        }
      }
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`✓ 启动完成`)
    console.log(`  dsh:       ${dshUrl}`)
    console.log(`  清单:      ${manifestFile}`)
    console.log(`  stack:     ${stackFile}`)
    console.log(`  home:      ${home}`)
    console.log(`  停止:      node ${DSHD} stop --stack ${stackFile}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    try {
      run([DSHD, 'stop', '--stack', stackFile], { timeout: 60000 })
    } catch { /* 尽力清理 */ }
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

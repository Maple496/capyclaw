#!/usr/bin/env node
/**
 * 清单驱动启动器（最小实现）
 * 
 * 用法: node tools/launch.mjs <manifest.json> [--stop]
 * 
 * 清单格式（只要两个字段）:
 * {
 *   "plugins": [
 *     { "name": "@capyclaw/launchpad", "path": "./extensions/official/capyclaw-launchpad", "enabled": true }
 *   ],
 *   "entries": [{ "entryId": "include:xxx", "enabled": false }]
 * }
 * 
 * 做什么: 读清单 → 生成 stack（所有插件都装）→ dshd start → 调 plugin-sync /apply 按清单开关
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSHD = join(REPO, 'tools/dsh-launcher/bin/dshd.mjs')

const run = (args, timeout = 180000) => {
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout, maxBuffer: 1 << 24 })
  if (r.error || r.status !== 0) throw new Error(`${args.join(' ')} 失败\n${r.stderr}`)
  return r
}

const wait = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('等待超时')
}

// ---- main ----
const args = process.argv.slice(2)
if (!args[0] || args[0] === '--help') {
  console.log('用法: node tools/launch.mjs <manifest.json> [--stop]')
  process.exit(0)
}

const manifestPath = resolve(args[0])
if (!existsSync(manifestPath)) throw new Error(`清单不存在: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// stack 文件固定放 manifest 旁边，方便 stop
const stackPath = manifestPath.replace(/\.json$/, '.stack.json')

if (args.includes('--stop')) {
  console.log(`停止: ${stackPath}`)
  try { run([DSHD, 'stop', '--stack', stackPath], 60000) } catch (e) { console.log(e.message) }
  process.exit(0)
}

// 生成 stack（所有插件都装上，禁用交给 plugin-sync）
const bundles = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  { name: '@capyclaw/plugin-sync', path: join(REPO, 'extensions/official/capyclaw-plugin-sync') },
]
for (const p of manifest.plugins || []) {
  if (!p.name || !p.path) throw new Error(`清单 plugins 缺 name 或 path`)
  bundles.push({ name: p.name, path: resolve(REPO, p.path) })
}

const services = (manifest.services || []).map((svc, i) => {
  if (!svc.name || !svc.cmd) throw new Error(`清单 services[${i}] 缺 name 或 cmd`)
  if (!Array.isArray(svc.cmd)) throw new Error(`清单 services[${i}].cmd 必须是数组`)
  const first = svc.cmd[0].startsWith('.') ? resolve(REPO, svc.cmd[0]) : svc.cmd[0]
  // broker 期望 ports: { main: <port> }，不是 port: <port>
  const ports = svc.port ? { main: svc.port } : {}
  const base = { id: svc.name, name: svc.name, ports, env: svc.env || {} }
  if (svc.cmd[0].startsWith('.')) {
    return { ...base, path: first, args: svc.cmd.slice(1) }
  }
  return { ...base, cmd: svc.cmd }
})

const stack = {
  name: `launch-${Date.now()}`,
  home: join(tmpdir(), `dsh-${Date.now()}`),
  profile: 'web',
  workspace: REPO,
  stateDir: join(tmpdir(), `dsh-${Date.now()}-state`),
  ports: { broker: 'auto', proxy: 'auto', upstream: 'auto' },
  plugins: {
    bundles,
    dependencies: {
      'dsh-plugin-kit': { path: join(REPO, 'packages/dsh-plugin-kit') },
      // ppt skill 包（workspace 本地包，不在清单里显式声明）
      'dsh-ppt-skill-ppt': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-ppt') },
      'dsh-ppt-skill-narrative': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-narrative') },
      'dsh-ppt-skill-design': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-design') },
      'dsh-ppt-skill-api': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-api') },
      'dsh-ppt-skill-authoring': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-authoring') },
      'dsh-ppt-skill-editing': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-editing') },
      'dsh-ppt-skill-visual-check': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-visual-check') },
      'dsh-ppt-skill-research': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-skill-research') },
      // ppt 基建
      'dsh-service-host': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-service-host') },
      'dsh-tool-host': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-tool-host') },
      'dsh-asset-service': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-asset-service') },
      'dsh-editor-host': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-editor-host') },
      'dsh-skills-service': { path: join(REPO, 'extensions/bridges/ppt-bridge/dsh-skills-service') },
      'dsh-ppt-workbench': { path: join(REPO, 'extensions/bridges/ppt-bridge/plugin/dsh-ppt-workbench') },
    },
    configs: [{ name: '@capyclaw/plugin-sync', config: { sourcePath: manifestPath } }],
    install: true,
  },
  services,
}
writeFileSync(stackPath, JSON.stringify(stack, null, 2))

// apply + start
console.log('⏳ 启动中...')
run([DSHD, 'stack', 'apply', '--stack', stackPath])
const start = run([DSHD, 'start', '--stack', stackPath], 300000)
const port = start.stdout.match(/浏览器端口 (\d+)/)?.[1]
if (!port) throw new Error('未找到端口')
const base = `http://127.0.0.1:${port}/`

// 等 plugin-sync 就绪并执行
console.log('⏳ 等待 plugin-sync...')
await wait(async () => (await fetch(`${base}__plugin_sync__/report`).then(r => r.status === 200).catch(() => false)), 60000)

const report = await fetch(`${base}__plugin_sync__/report`).then(r => r.json())
const changes = report.report?.diff?.changes || []
console.log(`差异: ${changes.length} 项`)

if (changes.length > 0) {
  console.log('⏳ 执行变更...')
  const result = await fetch(`${base}__plugin_sync__/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  }).then(r => r.json())
  console.log(`✓ applied: ${result.applied}, failed: ${result.failed}`)
}

console.log(`\n✓ 就绪: ${base}`)
console.log(`停止: node tools/launch.mjs ${manifestPath} --stop\n`)

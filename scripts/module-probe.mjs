#!/usr/bin/env node
/**
 * 单模块演化探针：跑一个模块自己的测试，可选再做运行时 health 检查。
 *
 *   node scripts/module-probe.mjs state
 *   node scripts/module-probe.mjs asset --health-url http://127.0.0.1:39311
 *   node scripts/module-probe.mjs all
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MODULES = {
  'plugin-kit': { dir: 'packages/dsh-plugin-kit', test: 'test/kit.test.mjs' },
  'service-host': { dir: 'packages/dsh-service-host', test: 'test/unit.test.mjs' },
  'tool-host': { dir: 'packages/dsh-tool-host', test: 'test/unit.test.mjs' },
  state: { dir: 'packages/dsh-state-service', test: 'test/unit.test.mjs' },
  asset: { dir: 'packages/dsh-asset-service', test: 'test/unit.test.mjs' },
  editor: { dir: 'packages/dsh-editor-host', test: 'test/unit.test.mjs' },
  gateway: { dir: 'packages/dsh-mcp-gateway', test: 'test/unit.test.mjs' },
  'ppt-workbench': { dir: 'bridges/ppt-bridge', test: 'test/plugin.test.mjs' },
}

const args = process.argv.slice(2)
const name = args[0]
const healthAt = args.indexOf('--health-url')
const healthUrl = healthAt >= 0 ? args[healthAt + 1] : ''
if (!name || !MODULES[name] && name !== 'all') {
  console.error(`用法: node scripts/module-probe.mjs <${Object.keys(MODULES).join('|')}|all> [--health-url <url>]`)
  process.exit(1)
}

async function probe(key) {
  const module = MODULES[key]
  console.log(`\n== ${key} ==`)
  const result = spawnSync(process.execPath, ['--test', module.test], {
    cwd: path.join(ROOT, module.dir),
    stdio: 'inherit',
  })
  if (result.status !== 0) return false
  if (healthUrl) {
    try {
      const res = await fetch(`${healthUrl.replace(/\/$/, '')}/healthz`)
      const body = await res.json()
      console.log(`health: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
      if (!res.ok) return false
    } catch (error) {
      console.error(`health 失败: ${String(error.message || error)}`)
      return false
    }
  }
  return true
}

const keys = name === 'all' ? Object.keys(MODULES) : [name]
let ok = true
for (const key of keys) ok = await probe(key) && ok
process.exit(ok ? 0 : 1)

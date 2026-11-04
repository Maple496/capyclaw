#!/usr/bin/env node
/** 一键验证插件标准：kit 测试、suite/domain 校验、脚手架/打包测试、bundle 测试。 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NODE = process.execPath
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const checks = []
function run(name, command, args, cwd) {
  process.stdout.write(`\n== ${name} ==\n`)
  const result = spawnSync(command, args, {
    cwd: cwd || ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  })
  checks.push({ name, ok: result.status === 0 })
  if (result.status !== 0) process.exitCode = 1
}

run('workspace links', NODE, ['scripts/link-workspace.mjs'], ROOT)
run('dsh-plugin-kit tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-plugin-kit'))
run('dsh-document-workbench tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-document-workbench'))
run('dsh-service-host tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-service-host'))
run('dsh-tool-host tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-tool-host'))
run('dsh-state-service tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-state-service'))
run('dsh-asset-service tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-asset-service'))
run('dsh-editor-host tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-editor-host'))
run('dsh-mcp-gateway tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-mcp-gateway'))
run('dsh-suite-kit tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-suite-kit'))
run('dsh-workspace-service E2E', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-workspace-service'))
run('dsh-runtime-control E2E', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-runtime-control'))
run('dsh-catalog tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-catalog'))
run('dsh-installer tests', NPM, ['test'], path.join(ROOT, 'packages', 'dsh-installer'))
run('plugin-generator tests', NPM, ['test'], path.join(ROOT, 'tools/plugin-generator'))
run('bundle tests', NODE, ['--test', 'scripts/test/bundle.test.mjs'], ROOT)
run('suite metadata drift', NODE, ['scripts/check-suite-drift.mjs'], ROOT)

const suiteCli = path.join(ROOT, 'packages', 'dsh-suite-kit', 'bin', 'dsh-suite.mjs')
const domainCli = path.join(ROOT, 'packages', 'dsh-suite-kit', 'bin', 'dsh-domain.mjs')
const targets = [
  ['service-host suite', suiteCli, ['validate', 'packages/dsh-service-host']],
  ['tool-host suite', suiteCli, ['validate', 'packages/dsh-tool-host']],
  ['state-service suite', suiteCli, ['validate', 'packages/dsh-state-service']],
  ['asset-service suite', suiteCli, ['validate', 'packages/dsh-asset-service']],
  ['editor-host suite', suiteCli, ['validate', 'packages/dsh-editor-host']],
  ['mcp-gateway suite', suiteCli, ['validate', 'packages/dsh-mcp-gateway']],
  ['hello suite', suiteCli, ['validate', 'examples/plugins/dsh-hello-service/plugin/dsh-hello-service-suite']],
  ['hello domain', domainCli, ['validate', 'examples/plugins/dsh-hello-service/domains/hello']],
  ['ppt suite', suiteCli, ['validate', 'bridges/ppt-bridge/plugin/capyclaw-ppt-suite']],
  ['ppt domain', domainCli, ['validate', 'bridges/ppt-bridge/domains/ppt']],
]
for (const [name, command, args] of targets) run(name, NODE, [command, ...args], ROOT)

console.log('\n== summary ==')
for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}`)
process.exit(process.exitCode || 0)

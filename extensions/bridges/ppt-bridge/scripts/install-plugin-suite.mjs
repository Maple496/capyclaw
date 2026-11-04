#!/usr/bin/env node
/**
 * 把 dsh-ppt-suite 装进一个 DSH profile。
 *
 * 安装本身走通用标准件 packages/dsh-suite-kit；这里只传 PPT 套件自己的迁移参数：
 * 移除旧版聚合 skill 行；workbench/mcp 的 domain override 行必须保留。
 *
 * 用法：
 *   node scripts/install-plugin-suite.mjs [--profile web] [--dsh-home <dir>] [--dry-run]
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSuites } from 'dsh-suite-kit'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SUITE_DIR = path.join(ROOT, 'plugin', 'dsh-ppt-suite')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
function argValues(name) {
  const values = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1])
  }
  return values
}
const profile = argValue('--profile', process.env.DSH_PROFILE || 'web')
const dshHome = path.resolve(argValue('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const dryRun = process.argv.includes('--dry-run')
const packageSpecs = argValues('--package')
const rollbackTo = argValue('--rollback-to', '')
const artifactRoot = argValue('--artifact-root', '')

const plan = installSuites({
  suiteInputs: [SUITE_DIR],
  profile,
  dshHome,
  dryRun,
  runPnpm: true,
  removeDependencies: ['dsh-ppt-workbench', 'dsh-ppt-skills', ...['ppt','narrative','design','api','authoring','editing','visual-check','research'].map((slug) => 'dsh-ppt-skill-' + slug)],
  removeRows: ['ppt-skills', ...['ppt','narrative','design','api','authoring','editing','visual-check','research'].map((slug) => 'ppt-skill-' + slug)],
  packageSpecs,
  rollbackTo: rollbackTo || undefined,
  artifactRoot: artifactRoot || undefined,
})
for (const warning of plan.warnings || []) console.log(`! ${warning}`)
console.log(`profile: ${plan.dir}`)
console.log(`bundles: ${plan.bundles.join(', ')}`)
console.log(`dependencies: ${plan.dependencies.join(', ')}`)
console.log(`overrides: ${(plan.overrides || []).map((item) => `${item.name}@${item.version}`).join(', ') || '-'}`)
console.log(`linked: ${(plan.linked || plan.managedPackages).join(', ')}`)
if (dryRun) console.log('dry-run：未写入任何文件')
else console.log('✓ dsh-ppt-suite 安装完成；重启 dsh 会话后生效')

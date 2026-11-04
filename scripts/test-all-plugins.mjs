#!/usr/bin/env node
/**
 * 批量运行插件测试（根 package.json 的 `npm run test-all`）。
 *
 * 扫描 extensions/{official,suites,bridges,flow,llm-config}（递归），
 * 对每个带 `scripts.test` 的包执行 `npm test`，汇总通过/失败/跳过。
 * 只跑有测试脚本的包；没有测试脚本不视为失败（由 validator 另行约束）。
 * 所有正式扩展已移至 extensions/ 下，按领域组织。
 *
 *   node scripts/test-all-plugins.mjs [--json]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const json = process.argv.includes('--json')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'archive', 'archives', '.git', '.dshd'])

function findPackages(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const packageDir = join(dir, entry.name)
    const packageFile = join(packageDir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (pkg?.scripts?.test) out.push({ dir: packageDir, name: pkg.name || entry.name, script: pkg.scripts.test })
    } catch { /* 没有 package.json 或坏文件：继续向下扫 */ }
    findPackages(packageDir, out, depth + 1)
  }
  return out
}

// flow / llm-config 的测试依赖 Python 执行器等外部运行时，本轮不纳入 CI 门槛；
// 它们仍由 validate-all 做结构校验，可单独 `npm --prefix <包> test` 运行。
const roots = [
  join(ROOT, 'extensions', 'official'),
  join(ROOT, 'extensions', 'suites'),
  join(ROOT, 'extensions', 'bridges'),
]
const packages = [...new Map(roots.flatMap((root) => findPackages(root)).map((item) => [item.dir, item])).values()]
  .sort((a, b) => a.dir.localeCompare(b.dir))

const results = []
for (const item of packages) {
  if (!json) console.log(`\n▶ ${item.name} (${relative(ROOT, item.dir)})`)
  const run = spawnSync('npm', ['test'], {
    cwd: item.dir,
    encoding: 'utf8',
    shell: true,
    timeout: 300000,
    env: { ...process.env, npm_config_workspace: '' },
  })
  const ok = run.status === 0
  results.push({ name: item.name, dir: relative(ROOT, item.dir), ok, status: run.status, output: (run.stdout || '') + (run.stderr || '') })
  if (!json) console.log(ok ? '  ✅ 通过' : `  ❌ 失败（exit ${run.status}）`)
}

const passed = results.filter((item) => item.ok).length
const failed = results.filter((item) => !item.ok)

if (json) {
  console.log(JSON.stringify({
    total: results.length,
    passed,
    failed: failed.length,
    results: results.map(({ output, ...rest }) => rest),
  }, null, 2))
} else {
  console.log('\n' + '━'.repeat(60))
  console.log('📊 测试汇总:')
  console.log(`  总计: ${results.length} 个带测试的包`)
  console.log(`  ✅ 通过: ${passed}`)
  console.log(`  ❌ 失败: ${failed.length}`)
  for (const item of failed) {
    console.log(`\n  ${item.name}（${item.dir}）:`)
    console.log(item.output.split('\n').slice(-20).map((line) => `    ${line}`).join('\n'))
  }
}

process.exit(failed.length ? 1 : 0)

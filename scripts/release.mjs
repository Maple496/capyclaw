#!/usr/bin/env node
/**
 * 发布流水线编排（原 package.json 里 12 段 && 一行流的脚本化收口）。
 *
 * 步骤与原链完全一致，只做两处收敛：
 *   - 去掉末尾紧跟 gen-registry 的第二次 --check（写完立即查必过，属冗余；
 *     registry 一致性由 check-registry / e2e L1 常态把关）；
 *   - 分阶段计时与汇总，失败即停并指明卡在哪一步。
 *
 * 用法：
 *   node scripts/release.mjs                # 全链
 *   node scripts/release.mjs --only build,lint   # 只跑指定步骤
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STEPS = [
  ['build', '构建全部插件产物', ['npm', ['run', 'build']]],
  ['lint', 'skill lint', ['npm', ['run', 'lint']]],
  ['validate-all', '全部插件结构校验', ['npm', ['run', 'validate-all']]],
  ['release-all', '打包 dist/plugins/*.zip', ['node', ['tools/capyclaw-plugin-release/bin/cli.mjs', 'release', '--all']]],
  ['release-index', '生成 dist/index.json', ['node', ['tools/capyclaw-plugin-release/bin/cli.mjs', 'index']]],
  ['gen-registry', '生成 capyclaw-registry.json', ['node', ['scripts/gen-registry.mjs']]],
]

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1].split(',').map((s) => s.trim()) : null

const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

let failed = null
const results = []
for (const [id, label, [cmd, cmdArgs]] of STEPS) {
  if (only && !only.includes(id)) continue
  const started = Date.now()
  console.log(`\n${'='.repeat(60)}\n== ${id} ${label}\n${'='.repeat(60)}`)
  const r = run(cmd, cmdArgs)
  const secs = Math.round((Date.now() - started) / 1000)
  const ok = r.status === 0
  results.push({ id, ok, secs })
  console.log(`（${id} ${ok ? '通过' : '失败'}，${secs}s）`)
  if (!ok) { failed = id; break }
}

console.log(`\n${'='.repeat(60)}\n== release 汇总\n${'='.repeat(60)}`)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.id}（${r.secs}s）`)
if (failed) {
  console.error(`\n✗ 卡在 ${failed}，后续步骤未执行`)
  process.exitCode = 1
} else {
  console.log('\n✓ 全链完成（产物未发布；发布走 dsh 内的 @capyclaw/publisher 插件，见 docs/PUBLISHING.md）')
}

#!/usr/bin/env node
/**
 * 全链验收（一条命令）：node scripts/verify-chain.mjs
 *
 * 检查两条性质：
 *   独立 —— 每个环节的 CLI 入口都存在且可独立运行（--help 退出码 0）；
 *   咬合 —— 接缝契约在真实工件上成立（真实 domain 的行覆盖审计、
 *          .works 示例通过 deploy validate、works-source 契约模块可加载）。
 *
 * 只做静态/子进程检查，不起 harness（运行编排的动态验证在各自 e2e）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STAGES = [
  { seam: 'S1 生产', entry: 'tools/plugin-generator/bin/create-plugin.mjs' },
  { seam: 'S2 打包', entry: 'tools/plugin-generator/bin/pack-plugin.mjs' },
  { seam: 'S3 分发源', entry: 'packages/dsh-suite-kit/bin/dsh-works.mjs' },
  { seam: 'S4 安装', entry: 'packages/dsh-suite-kit/bin/dsh-works.mjs' },
  { seam: 'S5 部署', entry: 'packages/dsh-suite-kit/bin/dsh-deploy.mjs' },
  { seam: 'S6 运行', entry: 'packages/dsh-suite-kit/bin/dsh-runtime.mjs' },
  { seam: 'S7 组装', entry: 'packages/dsh-assembly-kit/bin/dsh-assembly.mjs' },
]

const results = []
let failed = false

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed = true
}

// 1) 各环节 CLI 独立可运行
for (const stage of STAGES) {
  const entry = path.join(REPO, stage.entry)
  if (!existsSync(entry)) {
    record(`${stage.seam} ${path.basename(stage.entry)}`, false, '入口不存在')
    continue
  }
  const run = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 30000 })
  record(`${stage.seam} ${path.basename(stage.entry)}`, run.status === 0, run.status === 0 ? '独立可运行' : `exit ${run.status}: ${(run.stderr || '').slice(0, 120)}`)
}

// 2) 接缝咬合：真实工件上的契约检查
try {
  const { auditRowCoverage } = await import(pathToFileURL(path.join(REPO, 'packages/dsh-suite-kit/lib/row-audit.mjs')).href)
  const pptDomain = path.join(REPO, 'extensions/bridges/ppt-bridge/domains/ppt/dsh-domain.json')
  const audit = auditRowCoverage(pptDomain)
  record('S5 咬合 PPT domain 行覆盖', audit.ok, audit.ok ? `${audit.declaredCount} 行 / ${audit.suites.length} suite` : JSON.stringify(audit.missing))
} catch (error) {
  record('S5 咬合 PPT domain 行覆盖', false, error.message)
}

try {
  const { loadSourceIndex, assertIndexShape } = await import(pathToFileURL(path.join(REPO, 'packages/dsh-suite-kit/lib/works-source.mjs')).href)
  const distIndex = path.join(REPO, 'dist/index.json')
  if (existsSync(distIndex)) {
    const { index } = await loadSourceIndex(distIndex)
    assertIndexShape(index, distIndex)
    record('S3 咬合 dist/index.json 契约', true, `${index.plugins.length} 个条目（schema 1）`)
  } else {
    record('S3 咬合 dist/index.json 契约', true, 'dist/index.json 不存在（未发布过），跳过')
  }
} catch (error) {
  record('S3 咬合 dist/index.json 契约', false, error.message)
}

try {
  const run = spawnSync(process.execPath, [path.join(REPO, 'packages/dsh-suite-kit/bin/dsh-deploy.mjs'), 'validate', 'examples/deployment-ppt-basic.works'], {
    encoding: 'utf8', timeout: 60000, cwd: path.join(REPO, 'packages/dsh-suite-kit'),
  })
  record('S4→S5 咬合 .works 示例 deploy validate', run.status === 0, run.status === 0 ? '格式+语义+行覆盖审计全过' : (run.stdout + run.stderr).slice(-200))
} catch (error) {
  record('S4→S5 咬合 .works 示例 deploy validate', false, error.message)
}

// 3) 汇总
console.log('\n=== 全链验收 ===')
for (const item of results) {
  console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
}
const pass = results.filter((item) => item.ok).length
console.log(`\n${pass}/${results.length} 通过`)
process.exit(failed ? 1 : 0)

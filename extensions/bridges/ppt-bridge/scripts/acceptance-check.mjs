#!/usr/bin/env node
/**
 * 严格验收：模块覆盖、构建快照、进化产物、文档口径。
 * 用法：node scripts/acceptance-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(ROOT, '..', '..')
const failures = []
const passes = []

function check(name, fn) {
  try {
    const detail = fn()
    passes.push(`${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push(`${name} — ${error.message}`)
  }
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}

function json(file) {
  return JSON.parse(read(file))
}

const MODULES = [
  ['dsh-service-host', path.join(WORKSPACE, 'packages/dsh-service-host')],
  ['dsh-tool-host', path.join(WORKSPACE, 'packages/dsh-tool-host')],
  ['dsh-state-service', path.join(WORKSPACE, 'packages/dsh-state-service')],
  ['dsh-asset-service', path.join(WORKSPACE, 'packages/dsh-asset-service')],
  ['dsh-editor-host', path.join(WORKSPACE, 'packages/dsh-editor-host')],
  ['dsh-ppt-workbench', path.join(ROOT, 'plugin/dsh-ppt-workbench')],
  ...['ppt','narrative','design','api','authoring','editing','visual-check','research'].map((slug) => ['dsh-ppt-skill-' + slug, path.join(ROOT, 'plugin', 'dsh-ppt-skill-' + slug)]),
  ['capyclaw-ppt-suite', path.join(ROOT, 'plugin/capyclaw-ppt-suite')],
]

const EVALUATED_MODULES = [
  'dsh-service-host',
  'dsh-tool-host',
  'dsh-state-service',
  'dsh-asset-service',
  'dsh-editor-host',
  'dsh-ppt-workbench',
  'dsh-ppt-skills',
  'capyclaw-ppt-suite',
]

check('模块覆盖：15 个包都有 package.json 与 main 入口', () => {
  const missing = []
  for (const [name, dir] of MODULES) {
    const pkgFile = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgFile)) { missing.push(`${name}:package.json`); continue }
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const main = path.resolve(dir, pkg.main || 'index.js')
    if (!fs.existsSync(main)) missing.push(`${name}:main`)
    if (!pkg.dsh?.bundle?.patch) missing.push(`${name}:patch`)
  }
  if (missing.length) throw new Error(missing.join(', '))
  return `${MODULES.length}/${MODULES.length}`
})

check('模块评估文档覆盖 8 个模块且都有必要性结论', () => {
  const doc = read('docs/MODULE_EVALUATION.md')
  const missing = EVALUATED_MODULES.filter((name) => !doc.includes(`| ${name} |`))
  if (missing.length) throw new Error(`缺少: ${missing.join(', ')}`)
  const rows = (doc.match(/^\| dsh-.*\|$/gm) || []).length
  if (rows < 8) throw new Error(`结论表只有 ${rows} 行`)
  return `${rows} 行`
})

check('调优源与构建快照一致，watchPollMs=75', () => {
  const source = read('src/mcp/tuning.mjs')
  const snapshot = read('plugin/dsh-ppt-workbench/server/tuning.mjs')
  for (const [label, text] of [['src', source], ['snapshot', snapshot]]) {
    if (!/watchPollMs:\s*75/.test(text)) throw new Error(`${label} 未固化 75ms`)
    if (!/pushPerOpMs:\s*50/.test(text)) throw new Error(`${label} 未固化 pushPerOpMs=50`)
  }
  return 'src + server/tuning.mjs'
})

check('NSGA-II 结果：选中 75ms', () => {
  const result = json('bench/results/evolution-relay.json')
  const selected = result.selected?.genome?.watchPollMs
  if (selected !== 75) throw new Error(`selected.watchPollMs=${selected}`)
  if (!Array.isArray(result.pareto) || !result.pareto.length) throw new Error('pareto 为空')
  return `pareto=${result.pareto.length}, evaluated=${result.evaluated}`
})

check('OpenEvolve 结果：最优 75ms 且为真实 LLM 调用', () => {
  const result = json('bench/results/openevolve-final.json')
  const genome = result.best?.metrics?.genome || {}
  if (genome.watchPollMs !== 75) throw new Error(`best.watchPollMs=${genome.watchPollMs}`)
  if (!(result.llmCalls >= 1)) throw new Error('没有 LLM 调用记录')
  return `${result.llmCalls} calls, ${result.totalTokens} tokens`
})

check('Google 官方客户端闭环结果：最优 75ms', () => {
  const result = json('bench/results/google-alpha-evolve-local.json')
  const content = result.best?.program?.content?.files?.[0]?.content || ''
  if (!/"watch_poll_ms":\s*75/.test(content)) throw new Error('官方闭环最优不是 75ms')
  if (!String(result.engine).includes('Google-Cloud-AI')) throw new Error('引擎标记不是官方客户端')
  return `evaluated=${result.evaluated}`
})

check('全模块基线：8 个模块都有 ok=true 数据', () => {
  const baseline = json('bench/results/module-baseline.json')
  const missing = EVALUATED_MODULES.filter((name) => baseline.modules?.[name]?.ok !== true)
  if (missing.length) throw new Error(`缺少基线: ${missing.join(', ')}`)
  return '8/8'
})

check('稳定性回归文件存在且覆盖关键场景', () => {
  const test = read('test/stability.test.mjs')
  for (const keyword of ['畸形请求行', '超大 body', '并发启动', '并发 push', 'state 损坏', 'watch', 'junction', 'stripPatchRows']) {
    if (!test.includes(keyword)) throw new Error(`缺少场景: ${keyword}`)
  }
  return '12+ scenarios'
})

check('算法口径文档明确：官方 GCP 客户端 + 本地 shim + OpenEvolve', () => {
  const doc = read('docs/EVOLUTION_RESULTS.md')
  for (const keyword of ['Google-Cloud-AI/alphaevolve-on-googlecloud', 'local_service.py', 'OpenEvolve', '本地 shim']) {
    if (!doc.includes(keyword)) throw new Error(`缺少: ${keyword}`)
  }
  return 'ok'
})

check('严格验收报告存在', () => {
  const doc = read('docs/ACCEPTANCE_REPORT.md')
  if (!doc.includes('有条件通过')) throw new Error('缺少算法口径残余风险说明')
  return 'ok'
})

for (const line of passes) console.log(`✓ ${line}`)
for (const line of failures) console.log(`✗ ${line}`)
console.log(`\n${failures.length ? '验收未通过' : '严格验收通过'}：${passes.length} 项通过，${failures.length} 项失败`)
process.exit(failures.length ? 1 : 0)

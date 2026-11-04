#!/usr/bin/env node
/**
 * 确认扫描：对进化入围的基因组做 N 次重复评估，报告中位数/极差。
 * GA 的单次测量会被 ±毫秒级噪声干扰，固化决策以本扫描的中位数为准。
 *
 * 用法：node evolution/scan.mjs --component plugin-kit --cases evolution/cases/plugin-kit.json --reps 3
 * cases 文件：[{ "name": "founder", "genome": { ... } }, ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { COMPONENTS } from './genomes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

const component = arg('component')
const casesFile = arg('cases')
const reps = Number(arg('reps')) || 3
if (!component || !casesFile) {
  console.error('用法: node evolution/scan.mjs --component <name> --cases <cases.json> [--reps N]')
  process.exit(1)
}

const spec = COMPONENTS[component]
const module = await import(`./evaluators/${component}.mjs`)
const fnName = `evaluate${component.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`
const evaluate = module[fnName] || module.default
const cases = JSON.parse(fs.readFileSync(path.resolve(casesFile), 'utf8'))

const objectiveNames = null
for (const item of cases) {
  const runs = []
  for (let i = 0; i < reps; i++) {
    const started = performance.now()
    const result = await evaluate(item.genome, spec.tuning(item.genome))
    runs.push({ elapsed: (performance.now() - started) / 1000, ok: result.ok, objectives: result.objectives })
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const names = objectiveNames || Object.keys(runs[0].objectives)
  const line = names.map((name) => {
    const values = runs.map((run) => Number(run.objectives[name])).filter(Number.isFinite)
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    return `${name}=${median}(${sorted[0]}~${sorted[sorted.length - 1]})`
  }).join(' ')
  const okAll = runs.every((run) => run.ok)
  console.log(`[${component}] ${item.name} ok=${okAll} ${line}`)
}
process.exit(0)

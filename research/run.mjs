#!/usr/bin/env node
/**
 * 基础设施组件进化搜索入口（NSGA-II，引擎复用 bridges/ppt-bridge/bench/evolution/core.mjs）。
 *
 * 用法：
 *   node evolution/run.mjs --component plugin-kit [--population 12] [--generations 6] [--seed 2026]
 *   node evolution/run.mjs --component all
 *
 * 结果写入 evolution/results/<component>.json；日志同时打到 stdout。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvolutionEngine } from '../extensions/bridges/ppt-bridge/bench/evolution/core.mjs'
import { COMPONENTS } from './genomes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
fs.mkdirSync(RESULTS, { recursive: true })

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

async function loadEvaluator(component) {
  const module = await import(`./evaluators/${component}.mjs`)
  const fnName = `evaluate${component.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`
  const fn = module[fnName] || module.default
  if (typeof fn !== 'function') throw new Error(`评估器缺少导出函数: ${component} -> ${fnName}`)
  return fn
}

async function runComponent(name, options = {}) {
  const spec = COMPONENTS[name]
  if (!spec) throw new Error(`未知组件: ${name}`)
  const evaluate = await loadEvaluator(name)
  const population = Number(options.population) || spec.population
  const generations = Number(options.generations) || spec.generations
  const seed = Number(options.seed) || 2026

  const logLines = []
  const log = (line) => {
    console.log(`[${name}] ${line}`)
    logLines.push(line)
  }

  log(`开始进化：population=${population} generations=${generations} seed=${seed} genes=${spec.genome.length}`)
  const engine = new EvolutionEngine({
    genes: spec.genome,
    evaluate: async (genome) => {
      try {
        return await evaluate(genome, spec.tuning(genome))
      } catch (error) {
        log(`评估异常 genome=${JSON.stringify(genome)}: ${(error && error.stack) || error}`)
        throw error
      }
    },
    populationSize: population,
    generations,
    seed,
    weights: spec.weights,
    log,
  })

  const started = Date.now()
  const result = await engine.run()
  const elapsedMs = Date.now() - started

  const founder = {}
  for (const gene of spec.genome) founder[gene.name] = gene.founder
  const report = {
    component: name,
    seed,
    population,
    generations,
    elapsedMs,
    evaluated: result.evaluated,
    weights: spec.weights,
    founderGenome: founder,
    founderTuning: spec.tuning(founder),
    balanced: result.balanced
      ? { genome: result.balanced.genome, objectives: result.balanced.objectives, score: result.balanced.score }
      : null,
    pareto: result.pareto,
    history: result.history,
    finishedAt: new Date().toISOString(),
  }
  const outFile = path.join(RESULTS, `${name}.json`)
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  fs.appendFileSync(path.join(RESULTS, `${name}.log.txt`), logLines.join('\n') + '\n')
  log(`完成：evaluated=${result.evaluated} pareto=${result.pareto.length} elapsed=${(elapsedMs / 1000).toFixed(1)}s -> ${outFile}`)
  if (result.balanced) {
    log(`平衡解 genome: ${JSON.stringify(result.balanced.genome)}`)
    log(`平衡解 objectives: ${JSON.stringify(result.balanced.objectives)}`)
  }
  return report
}

async function main() {
  const component = arg('component')
  if (!component) {
    console.error('用法: node evolution/run.mjs --component <name|all> [--population N] [--generations N] [--seed N]')
    console.error(`可用组件: ${Object.keys(COMPONENTS).join(', ')}`)
    process.exit(1)
  }
  const options = {
    population: arg('population'),
    generations: arg('generations'),
    seed: arg('seed'),
  }
  const names = component === 'all' ? Object.keys(COMPONENTS) : [component]
  const summaries = []
  for (const name of names) {
    try {
      const report = await runComponent(name, options)
      summaries.push({ component: name, balanced: report.balanced?.genome ?? null, evaluated: report.evaluated })
    } catch (error) {
      console.error(`[${name}] 进化失败: ${error && error.stack || error}`)
      summaries.push({ component: name, error: String(error && error.message || error) })
    }
  }
  fs.writeFileSync(path.join(RESULTS, 'summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), summaries }, null, 2))
  console.log('\n=== 全部完成 ===')
  for (const item of summaries) {
    console.log(`${item.component}: ${item.error ? `失败 ${item.error}` : `平衡解 ${JSON.stringify(item.balanced)} (评估 ${item.evaluated} 次)`}`)
  }
  /* 评估器会留下 undici keep-alive socket 等无法显式清理的事件循环句柄：
     结果已全部落盘，显式退出，否则进程永远不结束。 */
  process.exit(0)
}

main().catch((error) => {
  console.error(error && error.stack || error)
  process.exit(1)
})

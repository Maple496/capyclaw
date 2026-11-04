#!/usr/bin/env node
/**
 * 进化搜索 CLI。
 *
 *   node bench/evolution/cli.mjs --module all --generations 5 --population 12 --seed 42
 *
 * 产出 bench/results/evolution-<module>.json：Pareto 前沿 + 平衡解 + 基线对比。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvolutionEngine, genomeKey, pickBalanced } from './core.mjs'
import { RELAY_WEIGHTS, STORE_WEIGHTS, relayGenome, relayTuning, storeGenome, storeTuning } from './genomes.mjs'
import { evaluateRelay, evaluateStore } from './evaluators.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.resolve(HERE, '..', 'results')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function founderOf(genes) {
  return Object.fromEntries(genes.map((gene) => [gene.name, gene.founder]))
}

async function runModule(name, { generations, population, seed }) {
  const spec = name === 'relay'
    ? { genes: relayGenome, weights: RELAY_WEIGHTS, evaluate: evaluateRelay, tuning: relayTuning }
    : { genes: storeGenome, weights: STORE_WEIGHTS, evaluate: evaluateStore, tuning: storeTuning }
  const engine = new EvolutionEngine({
    genes: spec.genes,
    evaluate: (genome) => spec.evaluate(genome, spec.tuning(genome)),
    populationSize: population,
    generations,
    seed,
    weights: spec.weights,
    log: (line) => console.log(line),
  })
  const founder = founderOf(spec.genes)
  console.log(`\n=== ${name} evolution (pop=${population}, gen=${generations}, seed=${seed}) ===`)
  const baseline = await engine.evaluateGenome(founder)
  const result = await engine.run()
  const baselineRecord = engine.cache.get(genomeKey(spec.genes, founder))
  const balanced = pickBalanced(result.pareto, spec.weights)
  const payload = {
    module: name,
    generatedAt: new Date().toISOString(),
    seed,
    generations,
    populationSize: population,
    evaluated: result.evaluated,
    baseline: baselineRecord,
    balanced,
    pareto: result.pareto,
    history: result.history,
  }
  fs.mkdirSync(RESULTS, { recursive: true })
  const file = path.join(RESULTS, `evolution-${name}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`\n${name}: ${result.pareto.length} 个 Pareto 解，${result.evaluated} 次评估 -> ${file}`)
  console.log('baseline:', JSON.stringify(baselineRecord.objectives))
  console.log('best    :', JSON.stringify(balanced?.objectives))
  if (balanced) console.log('genome  :', JSON.stringify(balanced.genome))
  return payload
}

const moduleName = arg('module', 'all')
const generations = Number(arg('generations', 5))
const population = Number(arg('population', 12))
const seed = Number(arg('seed', 42))
const modules = moduleName === 'all' ? ['relay', 'store'] : [moduleName]
const results = []
for (const name of modules) {
  if (!['relay', 'store'].includes(name)) throw new Error(`未知模块: ${name}`)
  results.push(await runModule(name, { generations, population, seed }))
}
console.log('\n完成。')

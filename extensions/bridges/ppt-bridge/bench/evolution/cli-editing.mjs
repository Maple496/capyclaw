#!/usr/bin/env node
/**
 * PPT 编辑链路多轮进化 CLI。
 *
 *   node bench/evolution/cli-editing.mjs --module editing --round 1   # 宽域（pop 12 × 6 代，seed 2026）
 *   node bench/evolution/cli-editing.mjs --module editing --round 2   # 窄域：以第 1 轮膝点为 founder，±2 步，seed 777
 *   node bench/evolution/cli-editing.mjs --module audit   --round 3   # 审计阈值进化
 *   node bench/evolution/cli-editing.mjs --module editing --scan      # founder vs 膝点确认扫描（3 次重复中位数）
 *
 * 产出 bench/results/evolution-<module>-r<round>.json / evolution-<module>-scan.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvolutionEngine, pickBalanced } from './core.mjs'
import {
  EDITING_WEIGHTS, AUDIT_WEIGHTS, editingGenome, auditGenome, editingTuning, auditTuning,
} from './genomes-editing.mjs'
import { evaluateEditing } from './evaluators-editing.mjs'
import { evaluateAudit } from './evaluators-audit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.resolve(HERE, '..', 'results')

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function founderOf(genes) {
  return Object.fromEntries(genes.map((gene) => [gene.name, gene.founder]))
}

/** 以膝点为中心收窄搜索域：±2 步并夹回原范围。 */
function narrowGenes(genes, knee) {
  return genes.map((gene) => {
    if (gene.type === 'enum') {
      const values = gene.values
      const at = values.indexOf(knee[gene.name])
      const lo = Math.max(0, at - 2)
      const hi = Math.min(values.length - 1, at + 2)
      return { ...gene, values: values.slice(lo, hi + 1), founder: knee[gene.name] }
    }
    const step = gene.step || 1
    const lo = Math.max(gene.min, knee[gene.name] - 2 * step)
    const hi = Math.min(gene.max, knee[gene.name] + 2 * step)
    return { ...gene, min: lo, max: hi, founder: knee[gene.name] }
  })
}

async function runEditing({ round, population, generations, seed, genes }) {
  const evaluate = (genome) => evaluateEditing(genome, editingTuning(genome))
  const engine = new EvolutionEngine({
    genes, evaluate, populationSize: population, generations, seed,
    weights: EDITING_WEIGHTS, log: (line) => console.log(line),
  })
  const founder = founderOf(genes)
  console.log(`\n=== editing evolution round ${round} (pop=${population}, gen=${generations}, seed=${seed}, genes=${genes.length}) ===`)
  await engine.evaluateGenome(founder)
  const result = await engine.run()
  const balanced = pickBalanced(result.pareto, EDITING_WEIGHTS)
  const payload = {
    module: 'editing', round, generatedAt: new Date().toISOString(),
    seed, generations, populationSize: population, evaluated: result.evaluated,
    founderGenome: founder,
    founderObjectives: engine.cache.get(Object.keys(engine.cache)[0])?.objectives ?? null,
    balanced: balanced ? { genome: balanced.genome, objectives: balanced.objectives, score: balanced.score } : null,
    pareto: result.pareto,
    history: result.history,
  }
  const file = path.join(RESULTS, `evolution-editing-r${round}.json`)
  fs.mkdirSync(RESULTS, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`\nediting r${round}: ${result.pareto.length} 个 Pareto 解，${result.evaluated} 次评估 -> ${file}`)
  console.log('founder:', JSON.stringify(payload.founderObjectives))
  if (balanced) {
    console.log('balanced:', JSON.stringify(balanced.objectives))
    console.log('genome :', JSON.stringify(balanced.genome))
  }
  return payload
}

async function runAudit({ population, generations, seed }) {
  const evaluate = (genome) => evaluateAudit(genome, auditTuning(genome))
  const engine = new EvolutionEngine({
    genes: auditGenome, evaluate, populationSize: population, generations, seed,
    weights: AUDIT_WEIGHTS, log: (line) => console.log(line),
  })
  const founder = founderOf(auditGenome)
  console.log(`\n=== audit evolution round 3 (pop=${population}, gen=${generations}, seed=${seed}, genes=${auditGenome.length}) ===`)
  await engine.evaluateGenome(founder)
  const result = await engine.run()
  const balanced = pickBalanced(result.pareto, AUDIT_WEIGHTS)
  const payload = {
    module: 'audit', round: 3, generatedAt: new Date().toISOString(),
    seed, generations, populationSize: population, evaluated: result.evaluated,
    founderGenome: founder,
    balanced: balanced ? { genome: balanced.genome, objectives: balanced.objectives, score: balanced.score } : null,
    pareto: result.pareto,
    history: result.history,
  }
  const file = path.join(RESULTS, 'evolution-audit-r3.json')
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`\naudit: ${result.pareto.length} 个 Pareto 解，${result.evaluated} 次评估 -> ${file}`)
  if (balanced) {
    console.log('balanced:', JSON.stringify(balanced.objectives))
    console.log('genome :', JSON.stringify(balanced.genome))
  }
  return payload
}

/** 确认扫描：founder vs 膝点各 3 次，报告中位数。 */
async function scanEditing(r1Payload, r2Payload) {
  const cases = [
    { name: 'founder(当前固化)', genome: r1Payload.founderGenome },
  ]
  if (r2Payload?.balanced) cases.push({ name: '两轮进化膝点', genome: r2Payload.balanced.genome })
  else if (r1Payload?.balanced) cases.push({ name: '第1轮膝点', genome: r1Payload.balanced.genome })
  const lines = []
  for (const item of cases) {
    const runs = []
    for (let i = 0; i < 3; i++) {
      const result = await evaluateEditing(item.genome, editingTuning(item.genome))
      runs.push(result.objectives)
    }
    const names = Object.keys(runs[0])
    const summary = names.map((name) => {
      const values = runs.map((run) => Number(run[name])).filter(Number.isFinite).sort((a, b) => a - b)
      return `${name}=${values[Math.floor(values.length / 2)]}(${values[0]}~${values[values.length - 1]})`
    }).join(' ')
    console.log(`[${item.name}] ${summary}`)
    lines.push({ case: item.name, genome: item.genome, runs })
  }
  const file = path.join(RESULTS, 'evolution-editing-scan.json')
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), cases: lines }, null, 2) + '\n')
  console.log(`-> ${file}`)
}

async function main() {
  const module = arg('module', 'editing')
  const round = Number(arg('round')) || 1
  const population = Number(arg('population')) || 0
  const generations = Number(arg('generations')) || 0
  const seed = Number(arg('seed')) || 0

  if (module === 'editing' && (arg('scan') !== null || process.argv.includes('--scan'))) {
    const r1 = JSON.parse(fs.readFileSync(path.join(RESULTS, 'evolution-editing-r1.json'), 'utf8'))
    let r2 = null
    try { r2 = JSON.parse(fs.readFileSync(path.join(RESULTS, 'evolution-editing-r2.json'), 'utf8')) } catch { /* 可选 */ }
    await scanEditing(r1, r2)
    process.exit(0)
  }

  if (module === 'editing') {
    if (round === 1) {
      await runEditing({ round: 1, population: population || 12, generations: generations || 6, seed: seed || 2026, genes: editingGenome })
    } else {
      const prevFile = path.join(RESULTS, `evolution-editing-r${round - 1}.json`)
      const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'))
      if (!prev.balanced) throw new Error(`第 ${round - 1} 轮没有平衡解，无法窄域搜索`)
      const genes = narrowGenes(editingGenome, prev.balanced.genome)
      await runEditing({ round, population: population || 10, generations: generations || 5, seed: seed || 777, genes })
    }
  } else if (module === 'audit') {
    await runAudit({ population: population || 10, generations: generations || 5, seed: seed || 2026 })
  } else {
    throw new Error(`未知模块: ${module}`)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(error && error.stack || error)
  process.exit(1)
})

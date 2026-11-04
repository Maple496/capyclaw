#!/usr/bin/env node
/** 冒烟：用 founder 基因各跑一次评估器，验证接线与目标合理性。 */
import { COMPONENTS } from './genomes.mjs'
import { performance } from 'node:perf_hooks'

const names = process.argv.slice(2).filter((item) => !item.startsWith('-'))
const list = names.length ? names : Object.keys(COMPONENTS)

for (const name of list) {
  const spec = COMPONENTS[name]
  const module = await import(`./evaluators/${name}.mjs`)
  const fnName = `evaluate${name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`
  const fn = module[fnName] || module.default
  const founder = {}
  for (const gene of spec.genome) founder[gene.name] = gene.founder
  const started = performance.now()
  try {
    const result = await fn(founder, spec.tuning(founder))
    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`\n=== ${name} (${elapsed}s) ok=${result.ok} ===`)
    console.log('genome :', JSON.stringify(founder))
    console.log('objectives:', JSON.stringify(result.objectives))
    console.log('meta   :', JSON.stringify(result.meta))
  } catch (error) {
    console.error(`\n=== ${name} 失败 ===\n${error && error.stack || error}`)
    process.exitCode = 1
  }
}

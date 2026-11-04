/**
 * AlphaEvolve 风格的进化搜索引擎（NSGA-II 多目标）。
 *
 * Google DeepMind 的 AlphaEvolve 论文核心是「程序数据库 + 变异/交叉 + 多目标进化选择」；
 * 本实现把「程序」抽象成模块的可调参数基因组（typed genome），评估器真实运行
 * 模块基准（而非 LLM 生成代码），因此结果可复现、可回归。
 *
 * 目标全部转成「最小化」：吞吐/成功率这类收益项由评估器返回负值或 1-成功率。
 */

export function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function randomGene(gene, rng) {
  if (gene.type === 'bool') return rng() < 0.5
  if (gene.type === 'enum') return pick(rng, gene.values)
  const step = gene.step || 1
  const steps = Math.floor((gene.max - gene.min) / step)
  return gene.min + Math.floor(rng() * (steps + 1)) * step
}

export function mutateGene(gene, value, rng) {
  if (gene.type === 'bool') return rng() < (gene.mutationRate ?? 0.2) ? !value : value
  if (gene.type === 'enum') {
    if (rng() > (gene.mutationRate ?? 0.25)) return value
    const others = gene.values.filter((item) => item !== value)
    return others.length ? pick(rng, others) : value
  }
  if (rng() > (gene.mutationRate ?? 0.25)) return value
  const step = gene.step || 1
  const span = Math.max(1, Math.round((gene.max - gene.min) / step))
  const jump = Math.max(1, Math.round(span * 0.25))
  const delta = (rng() < 0.5 ? -1 : 1) * Math.ceil(rng() * jump) * step
  return clamp(value + delta, gene.min, gene.max)
}

export function crossoverGenome(genes, a, b, rng) {
  const child = {}
  for (const gene of genes) {
    if (gene.type === 'bool' || gene.type === 'enum') {
      child[gene.name] = rng() < 0.5 ? a[gene.name] : b[gene.name]
    } else if (rng() < 0.5) {
      child[gene.name] = a[gene.name]
    } else {
      /* 数值基因用混合交叉，避免只在中点附近震荡 */
      const alpha = 0.25 + rng() * 0.5
      const raw = a[gene.name] * alpha + b[gene.name] * (1 - alpha)
      const step = gene.step || 1
      child[gene.name] = clamp(Math.round(raw / step) * step, gene.min, gene.max)
    }
  }
  return child
}

export function genomeKey(genes, genome) {
  return genes.map((gene) => `${gene.name}=${genome[gene.name]}`).join('|')
}

function objectiveVector(objectives, order) {
  return order.map((name) => {
    const value = Number(objectives[name])
    return Number.isFinite(value) ? value : 1e12
  })
}

function dominates(a, b) {
  let better = false
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return false
    if (a[i] < b[i]) better = true
  }
  return better
}

function fastNonDominatedSort(items) {
  const fronts = []
  const dominatedBy = new Map()
  const dominationCount = new Map()
  for (const item of items) {
    dominatedBy.set(item, [])
    dominationCount.set(item, 0)
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (dominates(a.values, b.values)) {
        dominatedBy.get(a).push(b)
        dominationCount.set(b, dominationCount.get(b) + 1)
      } else if (dominates(b.values, a.values)) {
        dominatedBy.get(b).push(a)
        dominationCount.set(a, dominationCount.get(a) + 1)
      }
    }
  }
  let current = items.filter((item) => dominationCount.get(item) === 0)
  let rank = 0
  while (current.length) {
    for (const item of current) item.rank = rank
    fronts.push(current)
    const next = []
    for (const item of current) {
      for (const other of dominatedBy.get(item)) {
        const count = dominationCount.get(other) - 1
        dominationCount.set(other, count)
        if (count === 0) next.push(other)
      }
    }
    current = next
    rank++
  }
  return fronts
}

function assignCrowding(front, order) {
  const size = front.length
  if (!size) return
  for (const item of front) item.crowding = 0
  if (size <= 2) {
    for (const item of front) item.crowding = Infinity
    return
  }
  for (let objective = 0; objective < order.length; objective++) {
    const sorted = [...front].sort((a, b) => a.values[objective] - b.values[objective])
    sorted[0].crowding = Infinity
    sorted[size - 1].crowding = Infinity
    const min = sorted[0].values[objective]
    const max = sorted[size - 1].values[objective]
    const range = max - min
    if (range <= 0) continue
    for (let i = 1; i < size - 1; i++) {
      sorted[i].crowding += (sorted[i + 1].values[objective] - sorted[i - 1].values[objective]) / range
    }
  }
}

function rankPopulation(items, order) {
  for (const item of items) item.values = objectiveVector(item.objectives, order)
  const fronts = fastNonDominatedSort(items)
  for (const front of fronts) assignCrowding(front, order)
  const ranked = []
  fronts.forEach((front, index) => {
    for (const item of front) {
      item.rank = index
      ranked.push(item)
    }
  })
  ranked.sort((a, b) => a.rank - b.rank || b.crowding - a.crowding)
  return ranked
}

function tournament(population, rng) {
  const a = pick(rng, population)
  const b = pick(rng, population)
  if (a.rank !== b.rank) return a.rank < b.rank ? a : b
  return a.crowding >= b.crowding ? a : b
}

export function normalizeObjectives(front) {
  const names = front.length ? Object.keys(front[0].objectives) : []
  const bounds = {}
  for (const name of names) {
    const values = front.map((item) => Number(item.objectives[name])).filter(Number.isFinite)
    bounds[name] = { min: Math.min(...values), max: Math.max(...values) }
  }
  return bounds
}

export function pickBalanced(front, weights = {}) {
  if (!front.length) return null
  const bounds = normalizeObjectives(front)
  let best = null
  let bestScore = Infinity
  for (const item of front) {
    let score = 0
    let total = 0
    for (const [name, value] of Object.entries(item.objectives)) {
      const weight = Number(weights[name] ?? 1)
      const { min, max } = bounds[name]
      const norm = max === min ? 0 : (Number(value) - min) / (max - min)
      score += weight * norm
      total += weight
    }
    score = total ? score / total : 0
    if (score < bestScore) { best = item; bestScore = score }
  }
  return { ...best, score: bestScore }
}

export class EvolutionEngine {
  constructor({
    genes, evaluate, populationSize = 16, generations = 6, seed = 42,
    crossoverRate = 0.85, mutationRate = 0.3, elite = 2, weights = {}, log = null,
  }) {
    this.genes = genes
    this.evaluate = evaluate
    this.populationSize = populationSize
    this.generations = generations
    this.seed = seed
    this.crossoverRate = crossoverRate
    this.mutationRate = mutationRate
    this.elite = elite
    this.weights = weights
    this.log = log || (() => {})
    this.cache = new Map()
    this.history = []
  }

  async evaluateGenome(genome) {
    const key = genomeKey(this.genes, genome)
    if (!this.cache.has(key)) {
      const started = Date.now()
      try {
        const result = await this.evaluate(genome)
        this.cache.set(key, {
          genome,
          objectives: result.objectives || {},
          meta: result.meta || {},
          ok: result.ok !== false,
          error: result.error || '',
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        const objectives = {}
        for (const gene of this.genes) objectives[gene.objective || gene.name] = 1e12
        this.cache.set(key, {
          genome, objectives, meta: {}, ok: false,
          error: String(error && error.message || error),
          elapsedMs: Date.now() - started,
        })
      }
      this.log(`  eval ${key} -> ${JSON.stringify(this.cache.get(key).objectives)}`)
    }
    return this.cache.get(key)
  }

  async evaluatePopulation(genomes) {
    const out = []
    for (const genome of genomes) out.push(await this.evaluateGenome(genome))
    return out
  }

  async run() {
    const rng = mulberry32(this.seed)
    const founder = {}
    for (const gene of this.genes) founder[gene.name] = gene.founder ?? randomGene(gene, rng)
    let population = [await this.evaluateGenome(founder)]
    while (population.length < this.populationSize) {
      const genome = {}
      for (const gene of this.genes) genome[gene.name] = randomGene(gene, rng)
      population.push(await this.evaluateGenome(genome))
    }
    const order = Object.keys(population[0].objectives)
    rankPopulation(population, order)

    for (let generation = 0; generation < this.generations; generation++) {
      const offspringGenomes = []
      while (offspringGenomes.length < this.populationSize) {
        const p1 = tournament(population, rng)
        const p2 = tournament(population, rng)
        let genome = rng() < this.crossoverRate
          ? crossoverGenome(this.genes, p1.genome, p2.genome, rng)
          : { ...p1.genome }
        for (const gene of this.genes) {
          genome[gene.name] = mutateGene(gene, genome[gene.name], rng)
        }
        offspringGenomes.push(genome)
      }
      const offspring = await this.evaluatePopulation(offspringGenomes)
      const combined = rankPopulation([...population, ...offspring], order)
      population = combined.slice(0, this.populationSize)
      const pareto = population.filter((item) => item.rank === 0)
      this.history.push({
        generation: generation + 1,
        best: pareto[0] ? { genome: pareto[0].genome, objectives: pareto[0].objectives } : null,
        paretoSize: pareto.length,
      })
      this.log(`generation ${generation + 1}/${this.generations}: pareto=${pareto.length}`)
    }

    const ranked = rankPopulation(population, order)
    const pareto = ranked.filter((item) => item.rank === 0)
    return {
      seed: this.seed,
      genes: this.genes,
      generations: this.generations,
      populationSize: this.populationSize,
      evaluated: this.cache.size,
      pareto: pareto.map((item) => ({
        genome: item.genome, objectives: item.objectives,
        meta: item.meta, ok: item.ok, error: item.error,
      })),
      balanced: pickBalanced(pareto, this.weights || {}),
      history: this.history,
    }
  }
}

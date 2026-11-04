#!/usr/bin/env node
/**
 * 真实基准测试：DIContainer vs Cordis Context
 *
 * 说明：
 * - DIContainer 使用仓库真实实现 packages/dsh-contracts/src/di/container.mjs
 * - Cordis 解析自 devDependencies 的 @deepseek-ai/cordis
 * - 所有数字均为实测，无任何硬编码
 *
 * 运行：node tests/performance/real-benchmark.mjs
 */

import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const require = createRequire(import.meta.url)

// 真实导入 DIContainer
const { DIContainer } = await import(
  pathToFileURL(path.join(repoRoot, 'packages/dsh-contracts/src/di/container.mjs')).href
)

// 真实导入 Cordis（根 devDependencies；dsh 宿主已移出本仓库）
let Context
let cordisVersion = 'unknown'
try {
  ({ Context } = require('@deepseek-ai/cordis'))
  cordisVersion = require(require.resolve('@deepseek-ai/cordis/package.json')).version
} catch {
  throw new Error(
    '找不到 @deepseek-ai/cordis。请先在仓库根执行 `npm install`（它是 devDependencies）。\n'
    + '说明：dsh 宿主（原 apps/harness）已移出本仓库，性能测试不再从宿主的 node_modules 读取 cordis。',
  )
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n
}

/**
 * 统计型基准：跑固定轮次，取中位数，避免单次抖动
 */
function bench(label, fn, { rounds = 5, iters = 200000 } = {}) {
  const samples = []
  for (let r = 0; r < rounds; r++) {
    // 预热
    for (let i = 0; i < Math.min(iters, 2000); i++) fn(i)
    if (global.gc) global.gc()
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn(i)
    const t1 = performance.now()
    samples.push(((iters / (t1 - t0)) * 1000)) // ops/s
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  return { label, iters, rounds, median, samples }
}

console.log('='.repeat(72))
console.log('真实基准测试：DIContainer vs Cordis Context')
console.log('='.repeat(72))
console.log(`Node        : ${process.version}`)
console.log(`Platform    : ${process.platform} ${process.arch}`)
console.log(`DIContainer : packages/dsh-contracts/src/di/container.mjs`)
console.log(`Cordis      : @deepseek-ai/cordis v${cordisVersion}`)
console.log('')

// ---------------------------------------------------------------
// 场景 1: 服务解析/访问热路径
// ---------------------------------------------------------------
console.log('【场景 1】服务解析/访问（热路径）')

const container = new DIContainer()
container.registerInstance('svc', { value: 42, getValue() { return this.value } })

const ctx = new Context()
ctx.provide('svc')
ctx.svc = { value: 42, getValue() { return this.value } }

const r1a = bench('DIContainer.resolve()', () => {
  const s = container.resolve('svc')
  return s.getValue()
})
const r1b = bench('Cordis ctx 属性访问', () => {
  const s = ctx.svc
  return s.getValue()
})

console.log(`  DIContainer.resolve() : ${fmt(r1a.median)} ops/s`)
console.log(`  Cordis ctx 属性访问   : ${fmt(r1b.median)} ops/s`)
console.log(`  倍率                  : ${(r1b.median / r1a.median).toFixed(2)}x`)
console.log('')

// ---------------------------------------------------------------
// 场景 2: 每次访问都创建实例（工厂注册）
// ---------------------------------------------------------------
console.log('【场景 2】工厂注册 + 每次新建实例')

const container2 = new DIContainer()
container2.register('factorySvc', () => ({ n: Math.random() }))

const r2a = bench('DIContainer 工厂 resolve', () => {
  return container2.resolve('factorySvc')
})

const r2b = bench('Cordis 直接构造（等价语义）', () => {
  return { n: Math.random() }
}, { iters: 200000 })

console.log(`  DIContainer 工厂      : ${fmt(r2a.median)} ops/s`)
console.log(`  直接对象构造          : ${fmt(r2b.median)} ops/s`)
console.log(`  倍率                  : ${(r2b.median / r2a.median).toFixed(2)}x`)
console.log('')

// ---------------------------------------------------------------
// 场景 3: 事件分发（Cordis 独有能力，DIContainer 无对应能力）
// ---------------------------------------------------------------
console.log('【场景 3】事件分发（Cordis 专有，DIContainer 无此能力）')

let hits = 0
const ctx3 = new Context()
for (let i = 0; i < 50; i++) {
  ctx3.on('bench-event', () => { hits++ })
}
const r3 = bench('Cordis emit (50 listeners)', () => {
  ctx3.emit('bench-event')
}, { iters: 20000 })

console.log(`  Cordis emit x50 listener : ${fmt(r3.median)} ops/s`)
console.log(`  listeners 触发总数       : ${fmt(hits)}`)
console.log('')

// ---------------------------------------------------------------
// 场景 4: 插件加载（Cordis 真实插件生命周期）
// ---------------------------------------------------------------
console.log('【场景 4】插件加载/卸载（Cordis 真实生命周期）')

// Cordis v4 真实 API: ctx.provide(name, value) 声明服务；ctx.plugin() 返回 thenable Fiber
async function pluginCycle() {
  const c = new Context()
  const fibers = []
  for (let i = 0; i < 10; i++) {
    fibers.push(c.plugin({
      name: `p${i}`,
      apply(cx) {
        cx.provide(`service${i}`, { v: i })
      },
    }))
  }
  await Promise.all(fibers)
  const loaded = c.service0 !== undefined
  for (const f of fibers) f.dispose()
  return { loaded, fiberCount: fibers.length }
}

// 预热 + 校验语义
const firstCycle = await pluginCycle()
console.log(`  语义校验: 插件生效=${firstCycle.loaded}, fibers=${firstCycle.fiberCount}`)

const PLUGIN_ROUNDS = 200
const t0p = performance.now()
for (let i = 0; i < PLUGIN_ROUNDS; i++) await pluginCycle()
const t1p = performance.now()
const pluginCyclesPerSec = (PLUGIN_ROUNDS / (t1p - t0p)) * 1000

console.log(`  10 插件加载+卸载 : ${fmt(pluginCyclesPerSec)} cycles/s (实测)`)
console.log(`  单轮耗时         : ${((t1p - t0p) / PLUGIN_ROUNDS).toFixed(3)} ms`)
console.log(`  完成轮次         : ${fmt(PLUGIN_ROUNDS)}`)
console.log('')

// ---------------------------------------------------------------
// 场景 5: 内存测量（真实 heap 差值）
// ---------------------------------------------------------------
console.log('【场景 5】内存占用（真实 heapUsed 差值）')

async function measureMemory(label, setup, iterate, cycles = 200) {
  if (global.gc) global.gc()
  await new Promise((r) => setTimeout(r, 100))

  const before = process.memoryUsage().heapUsed
  const keep = []

  for (let i = 0; i < cycles; i++) {
    keep.push(setup())
  }

  if (global.gc) global.gc()
  await new Promise((r) => setTimeout(r, 100))
  const after = process.memoryUsage().heapUsed

  const deltaMB = (after - before) / 1024 / 1024
  console.log(`  ${label.padEnd(28)} : ${deltaMB >= 0 ? '+' : ''}${deltaMB.toFixed(2)} MB / ${cycles} 轮`)
  return { keep, deltaMB }
}

const memA = await measureMemory('DIContainer x200', () => {
  const c = new DIContainer()
  c.registerInstance('a', { v: 1 })
  c.registerSingleton('b', () => ({ v: 2 }))
  c.resolve('a'); c.resolve('b')
  return c
})

const memB = await measureMemory('Cordis Context x200', () => {
  const c = new Context()
  c.provide('a')
  c.a = { v: 1 }
  const f = c.plugin({ name: 'p', apply(cx) { cx.provide('b', { v: 2 }) } })
  return { c, f }
})

console.log('')

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
console.log('='.repeat(72))
console.log('实测汇总')
console.log('='.repeat(72))
const rows = [
  ['服务访问 DIContainer.resolve()', fmt(r1a.median) + ' ops/s'],
  ['服务访问 Cordis ctx 属性', fmt(r1b.median) + ' ops/s'],
  ['  访问倍率', (r1b.median / r1a.median).toFixed(2) + 'x'],
  ['工厂新建 DIContainer', fmt(r2a.median) + ' ops/s'],
  ['工厂新建 直接构造', fmt(r2b.median) + ' ops/s'],
  ['  工厂倍率', (r2b.median / r2a.median).toFixed(2) + 'x'],
  ['事件分发 Cordis x50', fmt(r3.median) + ' ops/s'],
  ['插件加载 Cordis 10个', fmt(pluginCyclesPerSec) + ' cycles/s'],
  ['内存 DIContainer x200', memA.deltaMB.toFixed(2) + ' MB'],
  ['内存 Cordis x200', memB.deltaMB.toFixed(2) + ' MB'],
]
for (const [k, v] of rows) console.log(`  ${k.padEnd(34)} ${v}`)
console.log('')

// 结论只基于实测
const ratio = r1b.median / r1a.median
console.log('实测结论：')
if (ratio >= 1.1) {
  console.log(`  Cordis ctx 属性访问比 DIContainer.resolve() 快 ${ratio.toFixed(2)}x（实测）`)
} else if (ratio >= 0.9) {
  console.log(`  两者访问性能接近（实测倍率 ${ratio.toFixed(2)}x），性能不是选型主要理由`)
} else {
  console.log(`  DIContainer.resolve() 比 Cordis ctx 属性访问快 ${(1 / ratio).toFixed(0)}x（实测）`)
  console.log(`  即：Cordis 的 ctx 读取有 Proxy + 反射开销，约 ${(1e6 / r1b.median).toFixed(2)} µs/次`)
  console.log(`  选 Cordis 的理由应是事件/生命周期/热重载等结构性能力，不是速度`)
  console.log(`  若在热路径，请在 apply() 里把服务取到局部变量，避免循环内反复读 ctx.xxx`)
}
console.log('')
console.log('注意：DIContainer 无事件系统 / 生命周期 / 热重载，这些是 Cordis 的结构性优势，')
console.log('      不是性能层面的比较。')

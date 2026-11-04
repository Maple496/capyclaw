#!/usr/bin/env node
/**
 * 热路径优化基准：Cordis ctx 服务访问的两种写法
 *
 * 背景（实测）：
 *   Cordis v4 的 ctx 是 Proxy，每次读属性走 ReflectService 反射 + 依赖追踪，
 *   单次约 7 µs。在循环里反复读 ctx.xxx 会成为真实瓶颈。
 *
 * 本测试量化「循环内反复读 ctx」vs「apply() 顶部取局部变量」的差距，
 * 给出可在业务代码里直接套用的正确写法。
 *
 * 运行：node --expose-gc tests/performance/hot-path.mjs
 */

import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// Cordis 来自根 devDependencies（dsh 宿主已移出本仓库，不再从 apps/ 下读）
let Context
try {
  ({ Context } = require('@deepseek-ai/cordis'))
} catch {
  throw new Error(
    '找不到 @deepseek-ai/cordis。请先在仓库根执行 `npm install`（它是 devDependencies）。',
  )
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n
}

function medianBench(fn, { rounds = 5, iters = 100000 } = {}) {
  const samples = []
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < Math.min(iters, 1000); i++) fn(i)
    if (global.gc) global.gc()
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn(i)
    samples.push(((iters / (performance.now() - t0)) * 1000))
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

console.log('='.repeat(72))
console.log('热路径优化基准：循环内反复读 ctx vs 局部变量缓存')
console.log('='.repeat(72))
console.log(`Node: ${process.version} | ${process.platform} ${process.arch}`)
console.log('')

// 构造一个真实形状的服务：带一个可调用方法
function makeService() {
  let counter = 0
  return {
    query() { return ++counter },
  }
}

const N = 1000 // 每次迭代内部循环 1000 次业务调用

// ── 写法 A：循环里反复读 ctx（反模式）
const ctxA = new Context()
ctxA.provide('db')
ctxA.db = makeService()

const rateA = medianBench(() => {
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += ctxA.db.query()   // ← 每次都走 Proxy
  }
  return sum
}, { iters: 200 })

// ── 写法 B：apply() 顶部取局部变量（推荐）
const ctxB = new Context()
ctxB.provide('db')
ctxB.db = makeService()

const rateB = medianBench(() => {
  const db = ctxB.db            // ← 只读一次
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += db.query()
  }
  return sum
}, { iters: 200 })

console.log(`每次迭代内部业务调用: ${N} 次`)
console.log('')

// 先单独测一次 ctx 读取的成本，用于解释后面的数字
const rateRead = medianBench(() => ctxA.db, { iters: 100000 })
const nsPerRead = 1e9 / rateRead

console.log(`  单次 ctx.db 读取       : ${fmt(rateRead)} reads/s = ${nsPerRead.toFixed(0)} ns/次`)
console.log('')
console.log(`  写法 A 循环内读 ctx.db  : ${fmt(rateA)} iterations/s`)
console.log(`  写法 B 局部变量缓存     : ${fmt(rateB)} iterations/s`)
console.log(`  提升                   : ${(rateB / rateA).toFixed(1)}x`)
console.log('')
console.log(`  写法 A 每轮耗时         : ${(1e9 / rateA / 1e6).toFixed(2)} ms（≈ ${N} 次 ctx 读取）`)
console.log(`  写法 B 每轮耗时         : ${(1e9 / rateB / 1e3).toFixed(2)} µs（≈ 1 次 ctx 读取 + ${N} 次普通调用）`)
console.log(`  结论：瓶颈就是 ctx 读取本身，业务调用几乎免费`)
console.log('')

// ── 补充：直接不经过 ctx 的基线，说明 B 已接近理论上限
const plain = makeService()
const rateC = medianBench(() => {
  let sum = 0
  for (let i = 0; i < N; i++) sum += plain.query()
  return sum
}, { iters: 200 })

console.log(`  基线（完全不经过 ctx）  : ${fmt(rateC)} iterations/s`)
console.log(`  写法 B / 基线           : ${(rateB / rateC).toFixed(3)}x（越接近 1 越好）`)
console.log('')

// ── 多服务场景：3 个服务在循环内反复读
const ctxD = new Context()
for (const name of ['db', 'cache', 'log']) {
  ctxD.provide(name)
  ctxD[name] = makeService()
}

const rateD = medianBench(() => {
  let sum = 0
  for (let i = 0; i < 300; i++) {
    sum += ctxD.db.query()
    sum += ctxD.cache.query()
    sum += ctxD.log.query()
  }
  return sum
}, { iters: 200 })

const rateE = medianBench(() => {
  const { db, cache, log } = ctxD   // 解构一次即可
  let sum = 0
  for (let i = 0; i < 300; i++) {
    sum += db.query()
    sum += cache.query()
    sum += log.query()
  }
  return sum
}, { iters: 200 })

console.log('3 服务场景（循环内 900 次调用）')
console.log(`  反复读 ctx.{db,cache,log} : ${fmt(rateD)} iterations/s`)
console.log(`  解构到局部变量            : ${fmt(rateE)} iterations/s`)
console.log(`  提升                      : ${(rateE / rateD).toFixed(1)}x`)
console.log('')

// ── 结论（只陈述实测）
console.log('='.repeat(72))
console.log('实测结论')
console.log('='.repeat(72))
const gain1 = rateB / rateA
const gain3 = rateE / rateD
console.log(`  单次 ctx 读取成本: ${nsPerRead.toFixed(0)} ns（${(rateRead / 1e6).toFixed(2)}M reads/s）`)
console.log(`  单服务循环: 局部变量缓存快 ${gain1.toFixed(1)}x`)
console.log(`  3 服务循环: 解构缓存快 ${gain3.toFixed(1)}x`)
console.log(`  基线（纯对象调用，无 ctx）: ${fmt(rateC)} iterations/s = ${(1e9 / (rateC * N)).toFixed(2)} ns/次调用`)
console.log('')
console.log('  可套用的规则：')
console.log('    在 apply(ctx, config) 开头，把本次需要的服务全部取到局部变量；')
console.log('    循环/高频回调内部只用局部变量，不要出现 ctx.xxx。')
console.log('')
console.log('  反例（应避免）：')
console.log('    for (const row of rows) { await ctx.db.insert(row) }')
console.log('  正例：')
console.log('    const db = ctx.db; for (const row of rows) { await db.insert(row) }')

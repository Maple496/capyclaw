#!/usr/bin/env node
/**
 * 内存稳定性测试（真实堆测量）
 *
 * 方法：
 *   - 必须用 --expose-gc 运行，否则只做趋势观察并明确标注
 *   - 每轮之间强制 GC 并等待，取 heapUsed
 *   - 判据：多轮循环后堆基线是否持续单调上升（泄漏特征）
 *   - 不做绝对内存阈值断言（受机器影响），只看趋势与是否回收
 *
 * 场景：
 *   1. Cordis 插件创建/销毁循环 —— dispose 后是否真的释放
 *   2. 事件监听器注册/注销 —— 是否会累积
 *   3. 服务访问热循环 —— 是否产生稳定垃圾（可回收）
 *
 * 运行：node --expose-gc tests/performance/memory-stability.mjs
 */

import { createRequire } from 'node:module'

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

const HAS_GC = typeof global.gc === 'function'
const MB = (n) => (n / 1024 / 1024).toFixed(2)

async function settle() {
  if (HAS_GC) global.gc()
  await new Promise((r) => setTimeout(r, 60))
  if (HAS_GC) global.gc()
  await new Promise((r) => setTimeout(r, 20))
  return process.memoryUsage().heapUsed
}

/**
 * 判定趋势：分段斜率。
 * 真正的泄漏特征是「后半段每轮增长仍显著，且不收敛」。
 * 预热/缓存造成的增长会随轮次递减并趋于平台，不算泄漏。
 */
function segments(samples) {
  const n = samples.length
  const half = Math.floor(n / 2)
  const slopeOf = (arr) => {
    const m = arr.length
    if (m < 2) return 0
    const meanX = (m - 1) / 2
    const meanY = arr.reduce((a, b) => a + b, 0) / m
    let num = 0
    let den = 0
    for (let i = 0; i < m; i++) {
      num += (i - meanX) * (arr[i] - meanY)
      den += (i - meanX) ** 2
    }
    return den === 0 ? 0 : num / den
  }
  return {
    all: slopeOf(samples),
    first: slopeOf(samples.slice(0, half)),
    second: slopeOf(samples.slice(half)),
  }
}

/**
 * 泄漏判据（只依赖本进程测量，不做绝对阈值承诺）：
 *   - 后半段每轮增长 < 16KB → 平台，无泄漏特征
 *   - 或 后半段斜率显著低于前半段（< 70%）→ 预热收敛，不算泄漏
 * 必须要求「显著」收敛：等速增长是典型泄漏特征，不能当作收敛放过。
 */
function judge(samples) {
  const s = segments(samples)
  const flat = Math.abs(s.second) < 16 * 1024
  const converging = Math.abs(s.second) < Math.abs(s.first) * 0.7
  return { ...s, ok: flat || converging, flat, converging }
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, ...detail })
  console.log(`${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(detail)}`)
}

console.log('='.repeat(74))
console.log('内存稳定性测试')
console.log('='.repeat(74))
console.log(`Node: ${process.version} | ${process.platform} ${process.arch}`)
console.log(`--expose-gc: ${HAS_GC ? '是（可做精确判据）' : '否（仅趋势观察）'}`)
console.log('')

// ── 场景 1：Cordis 插件创建/销毁循环
console.log('【1】Cordis 插件创建/销毁（40 轮 × 每轮 10 插件）')
{
  const ROUNDS = 40
  const samples = []

  // 预热，避免把首次模块初始化算进来
  for (let w = 0; w < 3; w++) {
    const c = new Context()
    const fs = []
    for (let i = 0; i < 10; i++) {
      fs.push(c.plugin({ name: `p${i}`, apply(cx) { cx.provide(`s${i}`, { v: i }) } }))
    }
    await Promise.all(fs)
    for (const f of fs) f.dispose()
  }

  samples.push(await settle())

  for (let r = 0; r < ROUNDS; r++) {
    const c = new Context()
    const fibers = []
    for (let i = 0; i < 10; i++) {
      fibers.push(c.plugin({
        name: `p${i}`,
        apply(cx) {
          cx.provide(`s${i}`, { v: i, buf: new Array(50).fill(i) })
          cx.on('ping', () => {})
        },
      }))
    }
    await Promise.all(fibers)
    // 真实使用一下
    for (let i = 0; i < 10; i++) c.emit('ping')
    for (const f of fibers) f.dispose()
    samples.push(await settle())
  }

  const v = judge(samples)
  const delta = samples[samples.length - 1] - samples[0]
  record('插件创建/销毁后堆是否回收', v.ok, {
    rounds: ROUNDS,
    startMB: MB(samples[0]),
    endMB: MB(samples[samples.length - 1]),
    deltaMB: MB(delta),
    firstHalfKBPerRound: (v.first / 1024).toFixed(1),
    secondHalfKBPerRound: (v.second / 1024).toFixed(1),
    converging: v.converging,
  })
}
console.log('')

// ── 场景 2：事件监听器注册/注销
console.log('【2】事件监听器注册/注销（12 轮 × 每轮 200 监听器）')
{
  const ctx = new Context()
  const samples = []
  const emitCounts = []          // 每轮 emit 实际触发的监听器数，用于行为断言
  samples.push(await settle())

  const ROUNDS2 = 12
  for (let r = 0; r < ROUNDS2; r++) {
    const batch = []
    let hits = 0
    for (let i = 0; i < 200; i++) {
      // Cordis: ctx.on() 返回取消函数（没有 ctx.off）
      batch.push(ctx.on('evt', () => { hits++ }))
    }
    ctx.emit('evt')
    emitCounts.push(hits)
    // 注销后立刻丢引用，避免测试自身持有闭包造成假泄漏
    for (const dispose of batch) dispose()
    batch.length = 0
    samples.push(await settle())
  }

  const v = judge(samples)
  const delta = samples[samples.length - 1] - samples[0]
  // 行为断言：每轮只应触发当轮注册的 200 个监听器，不累积
  const behaviorOk = emitCounts.every((n) => n === 200)

  record('监听器注销后堆是否回收', v.ok && behaviorOk, {
    startMB: MB(samples[0]),
    endMB: MB(samples[samples.length - 1]),
    deltaMB: MB(delta),
    firstHalfKBPerRound: (v.first / 1024).toFixed(1),
    secondHalfKBPerRound: (v.second / 1024).toFixed(1),
    listenersPerEmit: `min=${Math.min(...emitCounts)} max=${Math.max(...emitCounts)}`,
    leakFreeByBehavior: behaviorOk,
  })
}
console.log('')

// ── 场景 3：服务访问热循环（应产生可回收垃圾）
console.log('【3】服务访问热循环（5 轮 × 每轮 200k 次调用）')
{
  const ctx = new Context()
  ctx.provide('svc')
  ctx.svc = { n: 0, inc() { return ++this.n } }

  const samples = []
  samples.push(await settle())

  for (let r = 0; r < 5; r++) {
    const svc = ctx.svc           // 局部变量，热路径正确写法
    let sum = 0
    for (let i = 0; i < 200000; i++) sum += svc.inc()
    samples.push(await settle())
  }

  const v = judge(samples)
  const delta = samples[samples.length - 1] - samples[0]

  record('热循环后堆是否回收', v.ok, {
    startMB: MB(samples[0]),
    endMB: MB(samples[samples.length - 1]),
    deltaMB: MB(delta),
    firstHalfKBPerRound: (v.first / 1024).toFixed(1),
    secondHalfKBPerRound: (v.second / 1024).toFixed(1),
  })
}
console.log('')

// ── 汇总
console.log('='.repeat(74))
console.log('汇总')
console.log('='.repeat(74))
console.table(results.map((r) => ({
  项目: r.name,
  结果: r.ok ? 'PASS' : 'FAIL',
  详情: JSON.stringify(Object.fromEntries(
    Object.entries(r).filter(([k]) => !['name', 'ok'].includes(k)),
  )),
})))

const failed = results.filter((r) => !r.ok).length
console.log(`\n通过 ${results.length - failed}/${results.length}`)
if (!HAS_GC) {
  console.log('⚠️ 未启用 --expose-gc：上面的判据降级为趋势观察，不算精确泄漏结论。')
  console.log('   请用：node --expose-gc tests/performance/memory-stability.mjs')
}
console.log('')
console.log('判据说明：后半段每轮增长 <16KB 或 斜率收敛（后半段 < 前半段）视为无泄漏特征。')
console.log('绝对数值受机器与 Node 版本影响，跨机对比请只看趋势一致性。')

process.exit(failed === 0 ? 0 : 1)

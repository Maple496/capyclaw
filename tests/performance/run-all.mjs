#!/usr/bin/env node
/**
 * 性能套件统一运行器
 *
 * 依次跑完 tests/performance 下的真实测试，汇总结果并落盘 JSON。
 * 不隐藏失败：任何子测试非 0 退出都会在汇总里标 FAIL，并让本进程非 0 退出。
 *
 * 用法：
 *   node --expose-gc tests/performance/run-all.mjs
 *   node --expose-gc tests/performance/run-all.mjs --skip-broker   # 跳过需起进程的 broker 压测
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const skipBroker = process.argv.includes('--skip-broker')
const hasGc = typeof global.gc === 'function'

const SUITES = [
  {
    file: 'real-benchmark.mjs',
    name: 'DIContainer vs Cordis 基准',
    needsGc: true,
    note: '纯访问路径、事件、插件生命周期、堆占用',
  },
  {
    file: 'hot-path.mjs',
    name: '热路径优化基准',
    needsGc: true,
    note: '循环内读 ctx vs 局部变量缓存',
  },
  {
    file: 'memory-stability.mjs',
    name: '内存稳定性',
    needsGc: true,
    note: '插件销毁/监听器注销/热循环后堆是否回收',
  },
  {
    file: 'broker-stress.mjs',
    name: 'Service Broker 压测',
    needsGc: false,
    note: '真实 broker + 真实子服务：启动/并发/doctor/重启/清理',
    skip: skipBroker,
  },
]

function runSuite(suite) {
  return new Promise((resolve) => {
    const args = []
    if (suite.needsGc) args.push('--expose-gc')
    args.push(path.join(__dirname, suite.file))

    const t0 = performance.now()
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c) })
    child.stderr.on('data', (c) => { err += c; process.stderr.write(c) })

    child.on('close', (code) => {
      resolve({
        suite: suite.name,
        file: suite.file,
        note: suite.note,
        exitCode: code,
        ok: code === 0,
        durationMs: Math.round(performance.now() - t0),
        stdoutTail: out.split(/\r?\n/).filter(Boolean).slice(-6),
        stderrTail: err.split(/\r?\n/).filter(Boolean).slice(-3),
      })
    })
    child.on('error', (e) => resolve({
      suite: suite.name,
      file: suite.file,
      ok: false,
      exitCode: null,
      durationMs: Math.round(performance.now() - t0),
      stderrTail: [e.message],
    }))
  })
}

console.log('='.repeat(74))
console.log('DSH 性能套件')
console.log('='.repeat(74))
console.log(`Node: ${process.version} | ${process.platform} ${process.arch}`)
console.log(`--expose-gc: ${hasGc ? '是' : '否（建议加上以启用精确内存判据）'}`)
if (skipBroker) console.log('已按 --skip-broker 跳过 broker 压测')
console.log('')

const results = []
for (const suite of SUITES) {
  if (suite.skip) {
    results.push({ suite: suite.name, file: suite.file, skipped: true, ok: true })
    console.log(`\n⏭  跳过：${suite.name}\n`)
    continue
  }
  console.log(`\n▶ 运行：${suite.name}  (${suite.file})`)
  console.log('-'.repeat(74))
  results.push(await runSuite(suite))
}

console.log('\n' + '='.repeat(74))
console.log('汇总')
console.log('='.repeat(74))

console.table(results.map((r) => ({
  套件: r.suite,
  结果: r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL'),
  耗时: r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-',
})))

const executed = results.filter((r) => !r.skipped)
const failed = executed.filter((r) => !r.ok)

const report = {
  timestamp: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    exposeGc: hasGc,
  },
  results,
  summary: {
    executed: executed.length,
    passed: executed.length - failed.length,
    failed: failed.length,
    skipped: results.length - executed.length,
  },
}

mkdirSync(path.join(repoRoot, 'tests/performance/reports'), { recursive: true })
const reportPath = path.join(
  repoRoot,
  'tests/performance/reports',
  `perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
)
writeFileSync(reportPath, JSON.stringify(report, null, 2))

console.log(`\n通过 ${report.summary.passed}/${report.summary.executed}` +
  (report.summary.skipped ? `（跳过 ${report.summary.skipped}）` : ''))
console.log(`报告：${path.relative(repoRoot, reportPath)}`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  - ${f.suite}（exit ${f.exitCode}）`)
}

process.exit(failed.length === 0 ? 0 : 1)

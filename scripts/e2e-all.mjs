#!/usr/bin/env node
/**
 * 统一 e2e 入口：六层验证一次跑全（重构回归的主力防线）。
 *
 *   L1 静态清单层   scripts/e2e/l1-static.mjs   结构/构建漂移/清单/一致性（离线秒级）
 *   L2 单元层       canvas node --test（55 项）
 *   L3 服务冒烟层   scripts/e2e/l3-services.mjs 双 relay /mcp + stdio + skills + host 模板 + 12 skill 包
 *   L4 broker 层    scripts/e2e/l4-broker.mjs   services.json 新代规格全链路消费
 *   L5 发布链路层   scripts/e2e/l5-release.mjs  release + 源校验 + dry-run + 可安装性抽检
 *   L6 真浏览器层   canvas test:e2e（Playwright 全链路 + 性能预算）
 *
 * 用法：
 *   node scripts/e2e-all.mjs                      # 全部六层
 *   node scripts/e2e-all.mjs --layer l1,l3        # 只跑指定层
 *   node scripts/e2e-all.mjs --skip-browser       # 跳过 L6
 *   node scripts/e2e-all.mjs --skip-network       # 跳过需网络的部分（dry-run / 可安装性）
 */
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const layerArg = args[args.indexOf('--layer') + 1]
const layers = layerArg && !layerArg.startsWith('--') ? layerArg.split(',').map((s) => s.trim()) : ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']
const skipBrowser = hasFlag('--skip-browser')
const skipNetwork = hasFlag('--skip-network')

const { Recorder, run: runCmd } = await import('./e2e/harness.mjs')

const summaries = []
let current = null

async function layer(id, name, fn) {
  if (!layers.includes(id)) return
  console.log(`\n${'='.repeat(60)}\n== ${id.toUpperCase()} ${name}\n${'='.repeat(60)}`)
  const started = Date.now()
  try {
    summaries.push(await fn())
  } catch (error) {
    console.error(`✗ ${id} 层执行异常: ${error.stack || error.message}`)
    summaries.push({ name: `${id} ${name}`, pass: 0, fail: 1, skip: 0 })
  }
  console.log(`（${id} 用时 ${Math.round((Date.now() - started) / 1000)}s）`)
}

await layer('l1', '静态清单层', async () => (await import('./e2e/l1-static.mjs')).runLayer())
await layer('l2', '单元层（canvas node --test）', async () => {
  const rec = new Recorder('L2 单元层')
  const r = runCmd('npm', ['--prefix', 'extensions/bridges/canvas-bridge', 'test'])
  const passLine = r.stdout.split('\n').find((l) => l.includes('ℹ pass'))
  const failLine = r.stdout.split('\n').find((l) => l.includes('ℹ fail'))
  const pass = parseInt(/pass (\d+)/.exec(passLine || '')[1] || '0', 10)
  const fail = parseInt(/fail (\d+)/.exec(failLine || '')[1] || '0', 10)
  rec.check(`canvas 单测 ${pass} 项通过`, r.status === 0 && fail === 0, (failLine || '').trim())
  return rec.summary()
})
await layer('l3', '服务/MCP 冒烟层', async () => (await import('./e2e/l3-services.mjs')).runLayer())
await layer('l4', 'broker 套件链路层', async () => (await import('./e2e/l4-broker.mjs')).runLayer())
await layer('l5', '发布链路层', async () => (await import('./e2e/l5-release.mjs')).runLayer({ skipNetwork }))
if (!skipBrowser) {
  await layer('l6', '真浏览器层（canvas Playwright e2e）', async () => {
    const rec = new Recorder('L6 真浏览器层')
    const r = runCmd('npm', ['--prefix', 'extensions/bridges/canvas-bridge', 'run', 'test:e2e'])
    const tail = (r.stdout || '').split('\n').filter((l) => l.includes('E2E') || l.includes('✗')).slice(-5).join(' | ')
    rec.check('canvas test:e2e（Playwright 全链路 + 性能预算）', r.status === 0, tail)
    return rec.summary()
  })
} else {
  console.log('\n· L6 真浏览器层（跳过：--skip-browser）')
  summaries.push({ name: 'L6 真浏览器层', pass: 0, fail: 0, skip: 1 })
}

console.log(`\n${'='.repeat(60)}\n== e2e 总汇\n${'='.repeat(60)}`)
let pass = 0, fail = 0, skip = 0
for (const s of summaries) {
  pass += s.pass || 0
  fail += s.fail || 0
  skip += s.skip || 0
  console.log(`${(s.fail ? '✗' : '✓')} ${s.name}: ${s.pass} 通过${s.fail ? ` / ${s.fail} 失败` : ''}${s.skip ? ` / ${s.skip} 跳过` : ''}`)
}
console.log(`\n合计: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
process.exit(fail ? 1 : 0)

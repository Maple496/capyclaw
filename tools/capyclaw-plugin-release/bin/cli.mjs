#!/usr/bin/env node
/**
 * DSH 插件发布 CLI（生产中心侧）。
 *
 *   dsh-release release <name|path>   发布单个插件（规范闸 + 发布闸 + 打 zip）
 *   dsh-release release --all         发布本仓所有可发布插件
 *   dsh-release index                 只重建 index.json（扫 dist/plugins/*.zip）
 *   dsh-release bundle                把整个源打成单一 zip（dist 之外）
 *   dsh-release list                  列出源里有什么
 *   dsh-release verify <源目录|URL>    按 PLUGIN_SOURCE_STANDARD.md 校验任意源
 *
 * 选项：--out <dir>（默认 <repo>/dist）、--root <dir>、--channel <name>、--json
 */
import path from 'node:path'

import {
  DEFAULT_OUT, REPO_ROOT, buildIndex, discoverPlugins, packSource,
  releasePlugin, readIndex,
} from '../lib/index.mjs'
import { verifySource } from '../lib/verify.mjs'

function usage(code = 0) {
  const text = `DSH 插件发布 CLI

用法:
  dsh-release release <插件名|目录>     发布单个插件
  dsh-release release --all             发布本仓所有可发布插件
  dsh-release index                     重建 index.json
  dsh-release bundle                    把源打成单一 zip
  dsh-release list                      列出源内容
  dsh-release verify <源目录|URL>        按 plugin-source/1 校验任意源

选项:
  --out <dir>       源目录（默认 <repo>/dist）
  --root <dir>      生产中心根（默认自动探测）
  --channel <name>  渠道名（默认 stable）
  --json            机器可读输出
`
  ;(code === 0 ? console.log : console.error)(text)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { _: [], out: DEFAULT_OUT, root: REPO_ROOT, channel: 'stable', json: false }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === '--out') args.out = path.resolve(argv[++i])
    else if (item === '--root') args.root = path.resolve(argv[++i])
    else if (item === '--channel') args.channel = argv[++i]
    else if (item === '--json') args.json = true
    else if (item === '-h' || item === '--help') usage(0)
    else args._.push(item)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]

try {
  if (command === 'release') {
    const target = args._[1]
    const list = target === '--all' ? discoverPlugins({ root: args.root })
      : target ? [target] : usage(1)
    const skipped = discoverPlugins.lastSkipped || []
    if (!args.json && target === '--all' && skipped.length) {
      console.log(`未就绪（未进源，可用 release <路径> 单独看原因）：`)
      for (const item of skipped) {
        console.log(`  · ${item.name}: ${item.reasons[0]}${item.reasons.length > 1 ? ` 等 ${item.reasons.length} 项` : ''}`)
      }
      console.log('')
    }
    const released = []
    const failed = []
    for (const item of list) {
      try {
        const result = await releasePlugin(item, { out: args.out, root: args.root })
        released.push({ name: result.pkg.name, version: result.pkg.version, file: result.outFile })
        if (!args.json) console.log(`  ✓ ${result.pkg.name}@${result.pkg.version} → ${path.relative(process.cwd(), result.outFile)}`)
      } catch (error) {
        failed.push({ item: String(item), error: error.message })
        if (!args.json) console.error(`  ✗ ${item}\n${String(error.message).split('\n').map((l) => `    ${l}`).join('\n')}`)
      }
    }
    const index = buildIndex(args.out, { channel: args.channel })
    if (args.json) {
      console.log(JSON.stringify({
        released, failed,
        skipped: skipped.map((s) => ({ name: s.name, reasons: s.reasons })),
        index: { plugins: index.plugins.length },
      }, null, 2))
    } else {
      console.log(`\n源索引: ${path.relative(process.cwd(), path.join(args.out, 'index.json'))}（${index.plugins.length} 条）`)
    }
    if (failed.length) process.exitCode = 1
  } else if (command === 'index') {
    const index = buildIndex(args.out, { channel: args.channel })
    console.log(args.json ? JSON.stringify(index, null, 2) : `index.json: ${index.plugins.length} 条插件版本`)
  } else if (command === 'bundle') {
    const result = packSource(args.out)
    console.log(args.json ? JSON.stringify(result, null, 2)
      : `源已打成单一文件: ${path.relative(process.cwd(), result.outFile)}（${result.files} 个文件）`)
  } else if (command === 'list') {
    const index = readIndex(args.out)
    if (args.json) console.log(JSON.stringify(index, null, 2))
    else {
      console.log(`源: ${args.out}（channel ${index.channel}）`)
      for (const p of index.plugins) {
        console.log(`  ${p.latest ? '★' : ' '} ${p.name}@${p.version}  dsh ${p.dsh || '?'}  ${p.file}`)
      }
    }
  } else if (command === 'verify') {
    const target = args._[1] || args.out
    const report = await verifySource(target)
    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      const head = `源: ${report.target}（channel ${report.channel || '?'}）`
      console.log(head)
      for (const item of report.plugins) {
        console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}@${item.version}` +
          (item.error ? '' : '') + `  ${item.file}`)
        for (const err of item.errors) console.log(`      · ${err}`)
      }
      for (const warn of report.warnings) console.log(`  ⚠ ${warn}`)
      for (const err of report.errors.filter((e) => !e.includes(':'))) console.log(`  ✗ ${err}`)
      console.log(report.ok
        ? `\n✓ 源符合 plugin-source/1（${report.plugins.length} 个插件版本）`
        : `\n✗ 源不符合 plugin-source/1（${report.errors.length} 项问题）`)
    }
    if (!report.ok) process.exitCode = 1
  } else {
    usage(command ? 1 : 0)
  }
} catch (error) {
  console.error(`✗ ${error.message}`)
  process.exit(1)
}

#!/usr/bin/env node
/**
 * DSH 插件独立打包工具。
 *
 * 用法:
 *   node pack-plugin.mjs <插件目录> [--out <目录>]
 *
 * 输出:
 *   <out>/<name>-v<version>.zip
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packPlugin } from '@capyclaw/plugin-kit/packaging/pack'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function usage() {
  console.log(`
DSH 插件打包工具

用法:
  node pack-plugin.mjs <插件目录> [--out <目录>]

说明:
  - 始终包含 package.json、README、LICENSE、THIRD_PARTY_NOTICES（存在时）
  - 支持 package.json files 中的目录、文件和 ! 排除项
  - 打包后自动自检，再写跨平台 ZIP
`)
}

function parseArgs(argv) {
  const options = { src: '', out: path.join(HERE, 'dist') }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--out' || arg === '-o') options.out = argv[++i]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (!options.src) options.src = arg
    else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    usage()
    process.exit(1)
  }
  if (options.help || !options.src) {
    usage()
    process.exit(options.help ? 0 : 1)
  }

  const srcDir = path.resolve(options.src)
  if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
    console.error(`✗ 找不到插件 package.json: ${srcDir}`)
    process.exit(1)
  }

  try {
    const result = packPlugin({
      srcDir,
      outDir: path.resolve(options.out),
    })
    console.log(`✓ 已打包: ${result.outFile}`)
    console.log(`  文件数: ${result.entries.length}`)
    for (const warning of result.warnings || []) console.warn(`  ⚠ ${warning}`)
    console.log('  安装:')
    console.log('    1) 解压到任意目录')
    if (result.pkg.dsh?.suite) {
      console.log('    2) node packages/capyclaw-suite-kit/bin/dsh-suite.mjs install <解压后的目录> --profile web')
    } else {
      console.log('    2) dsh plugin --profile web add <解压后的目录>')
    }
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
}

main()

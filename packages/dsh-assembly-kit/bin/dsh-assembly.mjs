#!/usr/bin/env node
/**
 * dsh-assembly CLI
 * 
 * 命令：
 *   scan          扫描工作区，生成组件库索引
 *   search        搜索组件
 *   init          创建新产品清单
 *   add           添加组件到产品清单
 *   plan          解析依赖，显示计划
 *   build         构建产物
 *   verify        验证产物
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  scan,
  search,
  resolve,
  build as buildProduct,
  verify,
  stats,
  listTags,
  listTools,
  listServices
} from '../src/index.mjs'

const CACHE_FILE = 'component-library.json'

function parseArgs(argv) {
  const args = []
  const flags = {}
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      args.push(arg)
      continue
    }
    
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  
  return { args, flags }
}

function printHelp() {
  console.log(`
dsh-assembly - DSH 统一组合系统

用法:
  dsh-assembly <command> [options]

命令:
  scan [dir]                      扫描工作区，生成组件库索引
  search <query>                  搜索组件
  list <tags|tools|services>      列出所有标签/工具/服务
  stats                           显示组件库统计信息
  init <name>                     创建新产品清单
  add <id...>                     添加组件到产品清单
  plan <manifest>                 解析依赖，显示计划
  build <manifest>                构建产物
  verify <dir>                    验证产物

选项:
  --workspace <dir>               工作区根目录（默认当前目录）
  --out <dir>                     输出目录（默认 ./dist）
  --manifest <file>               产品清单文件（默认 dsh-product.json）
  --target <registry|bundle>      目标类型
  --cache                         使用缓存（scan）
  --kind <type>                   过滤组件类型（search）
  --provides <key:pattern>        过滤 provides（search）
  --strict                        严格模式（build/plan）
  --help, -h                      显示帮助

示例:
  # 扫描并缓存
  dsh-assembly scan --cache

  # 搜索组件
  dsh-assembly search "图片"
  dsh-assembly search --kind capability --provides tools:ppt_*

  # 创建产品清单
  dsh-assembly init my-product --target registry

  # 添加组件
  dsh-assembly add deck text image

  # 构建
  dsh-assembly build dsh-product.json --out ./dist

  # 验证
  dsh-assembly verify ./dist --target registry
`)
}

async function cmdScan(dir, flags) {
  const workspaceRoot = path.resolve(dir || flags.workspace || '.')
  console.log(`扫描工作区: ${workspaceRoot}`)
  
  const library = await scan(workspaceRoot, {
    cache: flags.cache,
    cacheFile: CACHE_FILE
  })
  
  // 保存到文件
  const outFile = path.join(workspaceRoot, CACHE_FILE)
  fs.writeFileSync(outFile, JSON.stringify(library, null, 2) + '\n')
  
  console.log(`✓ 扫描完成: ${library.components.length} 个组件`)
  console.log(`  保存到: ${outFile}`)
  
  const stat = stats(library)
  console.log(`\n统计:`)
  console.log(`  总计: ${stat.total}`)
  for (const [kind, count] of Object.entries(stat.byKind)) {
    console.log(`    ${kind}: ${count}`)
  }
  console.log(`  工具: ${stat.tools}`)
  console.log(`  服务: ${stat.services}`)
  console.log(`  能力: ${stat.capabilities}`)
}

async function cmdSearch(query, flags) {
  const workspaceRoot = path.resolve(flags.workspace || '.')
  const libraryFile = path.join(workspaceRoot, CACHE_FILE)
  
  if (!fs.existsSync(libraryFile)) {
    console.error(`✗ 组件库索引不存在，请先运行: dsh-assembly scan`)
    process.exit(1)
  }
  
  const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
  
  const options = { kind: flags.kind, fuzzy: !flags.exact }
  
  if (flags.provides) {
    // 解析 provides: "tools:ppt_*,services:serviceHost"
    options.provides = {}
    for (const item of flags.provides.split(',')) {
      const [key, pattern] = item.split(':')
      if (key && pattern) {
        options.provides[key] = pattern
      }
    }
  }
  
  const results = search(query, library, options)
  
  console.log(`找到 ${results.length} 个组件:\n`)
  for (const comp of results) {
    console.log(`  ${comp.kind.padEnd(12)} ${comp.id.padEnd(30)} ${comp.title || ''}`)
    if (comp.description) {
      console.log(`    ${comp.description}`)
    }
    if (comp.provides?.tools?.length) {
      console.log(`    工具: ${comp.provides.tools.slice(0, 3).join(', ')}${comp.provides.tools.length > 3 ? '...' : ''}`)
    }
    console.log()
  }
}

async function cmdList(what, flags) {
  const workspaceRoot = path.resolve(flags.workspace || '.')
  const libraryFile = path.join(workspaceRoot, CACHE_FILE)
  
  if (!fs.existsSync(libraryFile)) {
    console.error(`✗ 组件库索引不存在，请先运行: dsh-assembly scan`)
    process.exit(1)
  }
  
  const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
  
  if (what === 'tags') {
    const tags = listTags(library)
    console.log(`标签 (${tags.length}):`)
    for (const tag of tags) console.log(`  ${tag}`)
  } else if (what === 'tools') {
    const tools = listTools(library)
    console.log(`工具 (${tools.length}):`)
    for (const tool of tools) console.log(`  ${tool}`)
  } else if (what === 'services') {
    const services = listServices(library)
    console.log(`服务 (${services.length}):`)
    for (const service of services) console.log(`  ${service}`)
  } else {
    console.error(`✗ 未知的列表类型: ${what}`)
    process.exit(1)
  }
}

async function cmdStats(flags) {
  const workspaceRoot = path.resolve(flags.workspace || '.')
  const libraryFile = path.join(workspaceRoot, CACHE_FILE)
  
  if (!fs.existsSync(libraryFile)) {
    console.error(`✗ 组件库索引不存在，请先运行: dsh-assembly scan`)
    process.exit(1)
  }
  
  const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
  const stat = stats(library)
  
  console.log(`组件库统计:\n`)
  console.log(`  总计: ${stat.total}`)
  console.log(`\n按类型:`)
  for (const [kind, count] of Object.entries(stat.byKind)) {
    console.log(`    ${kind}: ${count}`)
  }
  console.log(`\n提供:`)
  console.log(`    工具: ${stat.tools}`)
  console.log(`    服务: ${stat.services}`)
  console.log(`    能力: ${stat.capabilities}`)
}

async function cmdInit(name, flags) {
  const target = flags.target || 'registry'
  const manifestFile = flags.manifest || 'dsh-product.json'
  
  if (fs.existsSync(manifestFile)) {
    console.error(`✗ 文件已存在: ${manifestFile}`)
    process.exit(1)
  }
  
  const manifest = {
    $schema: "../packages/dsh-assembly-kit/product.schema.json",
    name,
    version: "0.1.0",
    title: name,
    description: `${name} 产品`,
    target,
    select: {
      capabilities: [],
      packages: []
    }
  }
  
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`✓ 已创建: ${manifestFile}`)
}

async function cmdAdd(ids, flags) {
  const manifestFile = flags.manifest || 'dsh-product.json'
  
  if (!fs.existsSync(manifestFile)) {
    console.error(`✗ 产品清单不存在: ${manifestFile}`)
    process.exit(1)
  }
  
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.select = manifest.select || {}
  manifest.select.capabilities = manifest.select.capabilities || []
  manifest.select.packages = manifest.select.packages || []
  
  for (const id of ids) {
    if (!manifest.select.capabilities.includes(id) && !manifest.select.packages.includes(id)) {
      // 简单判断：如果包含连字符且不以 dsh- 开头，可能是 capability
      if (id.includes('-') && !id.startsWith('dsh-')) {
        manifest.select.capabilities.push(id)
      } else {
        manifest.select.packages.push(id)
      }
    }
  }
  
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`✓ 已添加 ${ids.length} 个组件到 ${manifestFile}`)
}

async function cmdPlan(manifestPath, flags) {
  const workspaceRoot = path.resolve(flags.workspace || '.')
  const libraryFile = path.join(workspaceRoot, CACHE_FILE)
  
  if (!fs.existsSync(libraryFile)) {
    console.error(`✗ 组件库索引不存在，请先运行: dsh-assembly scan`)
    process.exit(1)
  }
  
  const library = JSON.parse(fs.readFileSync(libraryFile, 'utf8'))
  const productManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  
  const resolved = resolve(productManifest, library, { strict: false })
  
  console.log(`解析计划:\n`)
  console.log(`  产品: ${productManifest.name} v${productManifest.version}`)
  console.log(`  目标: ${productManifest.target}`)
  console.log(`  选中: ${resolved.selected.length} 个组件`)
  console.log(`  展开: ${resolved.expanded.length} 个组件（含依赖）\n`)
  
  if (resolved.conflicts.length > 0) {
    console.log(`⚠ 冲突 (${resolved.conflicts.length}):`)
    for (const conflict of resolved.conflicts) {
      console.log(`  - ${conflict.type}: ${JSON.stringify(conflict)}`)
    }
    console.log()
  }
  
  if (resolved.warnings.length > 0) {
    console.log(`⚠ 警告 (${resolved.warnings.length}):`)
    for (const warning of resolved.warnings) {
      console.log(`  - ${warning.type}: ${warning.message || JSON.stringify(warning)}`)
    }
    console.log()
  }
  
  if (resolved.errors.length > 0) {
    console.log(`✗ 错误 (${resolved.errors.length}):`)
    for (const error of resolved.errors) {
      console.log(`  - ${error.type}: ${error.message || JSON.stringify(error)}`)
    }
    console.log()
  }
  
  console.log(`组件列表:`)
  for (const comp of resolved.components) {
    console.log(`  ${comp.kind.padEnd(12)} ${comp.id}`)
  }
  
  if (!resolved.ok) {
    process.exit(1)
  }
}

async function cmdBuild(manifestPath, flags) {
  const outDir = flags.out || './dist'
  
  console.log(`构建: ${manifestPath}`)
  console.log(`输出: ${outDir}\n`)
  
  try {
    const result = await buildProduct(manifestPath, {
      workspaceRoot: flags.workspace,
      outDir,
      cache: flags.cache !== false,
      strict: flags.strict
    })
    
    console.log(`✓ 构建成功`)
    console.log(`  目标: ${result.target}`)
    console.log(`  输出: ${result.outDir}`)
    console.log(`  文件:`)
    for (const [key, file] of Object.entries(result.files)) {
      console.log(`    ${key}: ${path.basename(file)}`)
    }
    
    if (result.target === 'registry') {
      console.log(`  能力: ${result.capabilities.length} 个`)
    } else if (result.target === 'bundle') {
      console.log(`  包: ${result.packages.length} 个`)
      console.log(`  行: ${result.rows} 个`)
    }
  } catch (error) {
    console.error(`✗ 构建失败: ${error.message}`)
    if (flags.verbose) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

async function cmdVerify(dir, flags) {
  const target = flags.target
  
  if (!target) {
    console.error(`✗ 需要指定 --target (registry 或 bundle)`)
    process.exit(1)
  }
  
  console.log(`验证: ${dir}`)
  console.log(`目标: ${target}\n`)
  
  try {
    const result = await verify(dir, target)
    
    if (result.ok) {
      console.log(`✓ 验证通过`)
      if (target === 'registry') {
        console.log(`  能力: ${result.count} 个`)
        console.log(`  列表: ${result.capabilities.join(', ')}`)
      } else if (target === 'bundle') {
        console.log(`  suite: ${result.suite} v${result.version}`)
        console.log(`  包: ${result.packages} 个`)
        console.log(`  行: ${result.rows} 个`)
      }
    } else {
      console.error(`✗ 验证失败: ${result.error}`)
      if (result.stack && flags.verbose) {
        console.error(result.stack)
      }
      process.exit(1)
    }
  } catch (error) {
    console.error(`✗ 验证失败: ${error.message}`)
    if (flags.verbose) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2))
  
  if (flags.help || flags.h || args.length === 0) {
    printHelp()
    return
  }
  
  const [command, ...cmdArgs] = args
  
  try {
    if (command === 'scan') {
      await cmdScan(cmdArgs[0], flags)
    } else if (command === 'search') {
      await cmdSearch(cmdArgs[0], flags)
    } else if (command === 'list') {
      await cmdList(cmdArgs[0], flags)
    } else if (command === 'stats') {
      await cmdStats(flags)
    } else if (command === 'init') {
      await cmdInit(cmdArgs[0], flags)
    } else if (command === 'add') {
      await cmdAdd(cmdArgs, flags)
    } else if (command === 'plan') {
      await cmdPlan(cmdArgs[0], flags)
    } else if (command === 'build') {
      await cmdBuild(cmdArgs[0], flags)
    } else if (command === 'verify') {
      await cmdVerify(cmdArgs[0], flags)
    } else {
      console.error(`✗ 未知命令: ${command}`)
      console.error(`运行 dsh-assembly --help 查看帮助`)
      process.exit(1)
    }
  } catch (error) {
    console.error(`✗ ${error.message}`)
    if (flags.verbose) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

main()

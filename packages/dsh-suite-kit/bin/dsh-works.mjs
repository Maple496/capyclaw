#!/usr/bin/env node
/**
 * DSH Works 管理工具
 *
 * 管理本地的"作品"缓存，包括部署配置、工作流、插件等
 *
 * 用法：
 *   dsh-works install <file.works|name> [--from <index.json|URL>] [--version <v>]
 *   dsh-works list                      列出已安装的作品
 *   dsh-works show <WORKS-id>           查看作品详情
 *   dsh-works search <query>            搜索作品
 *   dsh-works check <WORKS-id> [--auto-install]  检查依赖
 *   dsh-works update <WORKS-id>         更新作品
 *   dsh-works uninstall <WORKS-id>      卸载作品
 *
 * 分发源：--from 或 DSH_WORKS_SOURCE（本地 index.json 路径/目录或 http(s) URL）。
 * 平台注册表（P3）上线后 DSH_WORKS_SOURCE 指向平台 URL 即完成切换。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, isMain } from '../../dsh-plugin-kit/src/cli.mjs'
import { writeJsonAtomic } from '../../dsh-plugin-kit/src/util/fs-lock.mjs'
import { parseWorksFile, validateWorksFormat } from '../lib/works-parser.mjs'
import { DependencyResolver } from '../lib/dependency-resolver.mjs'
import {
  assertIndexShape,
  extractWorksFiles,
  fetchEntryBytes,
  loadSourceIndex,
  pickWorksEntry,
} from '../lib/works-source.mjs'

// 获取本地存储根目录
function getStoreRoot() {
  return process.env.DSH_STORE_ROOT ||
         join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
}

// 获取作品缓存目录
function getWorksDir() {
  const dir = join(getStoreRoot(), 'works')
  mkdirSync(dir, { recursive: true })
  return dir
}

// 获取注册表文件路径（独立于 runtime 租约的 registry.json——
// 两套 schema 曾混写同一文件，互相覆盖；单一真源：works 数据归本文件，租约归 runtime）
function getRegistryFile() {
  return join(getStoreRoot(), 'works-registry.json')
}

// 旧 registry.json 里若有 works 数组则一次性收养迁移（runtime 租约文件保持不动）
function adoptLegacyRegistry(targetFile) {
  const legacy = join(getStoreRoot(), 'registry.json')
  if (!existsSync(legacy) || existsSync(targetFile)) return
  try {
    const data = JSON.parse(readFileSync(legacy, 'utf-8'))
    if (Array.isArray(data.works)) {
      mkdirSync(dirname(targetFile), { recursive: true })
      copyFileSync(legacy, targetFile)
      console.log(`  ↳ 已从旧 registry.json 收养 works 注册表 → ${targetFile}`)
    }
  } catch { /* 旧文件不可读则不收养 */ }
}

// 加载注册表
function loadRegistry() {
  const file = getRegistryFile()
  if (!existsSync(file)) {
    adoptLegacyRegistry(file)
  }
  if (!existsSync(file)) {
    return {
      version: '1.0.0',
      works: [],
      capabilities: {}
    }
  }
  return JSON.parse(readFileSync(file, 'utf-8'))
}

// 保存注册表（原子写，防半截文件）
function saveRegistry(registry) {
  const file = getRegistryFile()
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, registry)
}

// 解析作品引用
function parseWorkRef(ref) {
  // 支持格式: WORKS-12345, WORKS-local-xxx, WORKS-src-xxx, works-12345, 12345
  if (ref.startsWith('WORKS-local-') || ref.startsWith('WORKS-src-')) {
    return ref
  }
  const match = ref.match(/^(?:WORKS-)?(\d+)$/i)
  if (!match) {
    throw new Error(`无效的作品引用: ${ref}`)
  }
  return `WORKS-${match[1]}`
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'work'
}

/** 安装单个 .works 文件到本地注册表（本地文件与分发源共用）。返回 workRef。 */
async function installWorkFile(sourcePath, { workRef, originName } = {}) {
  const { meta, code } = parseWorksFile(sourcePath)
  const { valid, errors } = validateWorksFormat(meta, code)

  if (!valid) {
    throw new Error(`作品格式验证失败:\n- ${errors.join('\n- ')}`)
  }

  if (!workRef) workRef = `WORKS-local-${Date.now()}`

  console.log(`  ${meta.emoji || '📄'} ${meta.name}`)
  console.log(`  类型: ${meta.view?.kind}`)
  console.log(`  版本: ${meta.schema_version || '1.0.0'}`)

  // 创建作品目录
  const workDir = join(getWorksDir(), workRef)
  mkdirSync(workDir, { recursive: true })

  // 保存元数据和内容
  writeFileSync(join(workDir, 'meta.json'), JSON.stringify(meta, null, 2))
  writeFileSync(join(workDir, 'content.json'), JSON.stringify(code, null, 2))
  writeFileSync(join(workDir, 'installed'), new Date().toISOString())

  // 复制原始文件
  cpSync(sourcePath, join(workDir, originName || basename(sourcePath)))

  // 更新注册表
  const registry = loadRegistry()

  // 确保 works 数组存在
  if (!registry.works) {
    registry.works = []
  }

  // 移除旧条目
  registry.works = registry.works.filter(w => w.ref !== workRef)

  // 添加新条目
  registry.works.push({
    ref: workRef,
    type: meta.view?.kind,
    title: meta.name,
    version: meta.schema_version || '1.0.0',
    installed: true,
    installed_at: new Date().toISOString(),
    capabilities: meta.capabilities || [],
    requires: meta.requires || {},
    source: registrySource,
  })

  // 更新能力索引
  if (!registry.capabilities) {
    registry.capabilities = {}
  }

  for (const cap of meta.capabilities || []) {
    if (!registry.capabilities[cap]) {
      registry.capabilities[cap] = []
    }
    if (!registry.capabilities[cap].includes(workRef)) {
      registry.capabilities[cap].push(workRef)
    }
  }

  saveRegistry(registry)

  console.log(`\n✅ 安装成功: ${workDir}`)
  console.log(`   引用: ${workRef}`)
  return { workRef, workDir }
}

// registry 来源标注由 install 命令写入（installWorkFile 读取）
let registrySource = 'local'

// 命令实现
const commands = {
  async install(ref, options = {}) {
    console.log(`\n📦 安装作品: ${ref}`)

    // 形态一：本地 .works 文件
    if (existsSync(ref)) {
      registrySource = 'local'
      console.log(`  来源: 本地文件`)
      await installWorkFile(resolve(ref))
      return
    }

    // 形态二：分发源条目（名称引用）
    const source = options.from || process.env.DSH_WORKS_SOURCE
    if (!source) {
      throw new Error(`无效的作品引用或文件路径: ${ref}；按名称安装需要 --from <index.json|URL> 或环境变量 DSH_WORKS_SOURCE（P3 平台注册表上线后为缺省来源）`)
    }
    const name = ref.replace(/^WORKS-src-/, '')
    console.log(`  来源: ${options.from ? '--from' : 'DSH_WORKS_SOURCE'} ${source}`)

    const { index, base } = await loadSourceIndex(source)
    assertIndexShape(index, source)
    const entry = pickWorksEntry(index, name, options.version)
    console.log(`  条目: ${entry.name}@${entry.version}${entry.title ? `（${entry.title}）` : ''}`)

    const bytes = await fetchEntryBytes(base, entry)
    const files = extractWorksFiles(bytes, `${entry.name}@${entry.version}`)
    if (!files.length) throw new Error(`zip 里没有 .works 文件: ${entry.file}`)

    registrySource = source
    for (const file of files) {
      const incoming = join(getWorksDir(), `.incoming-${process.pid}-${Date.now()}.works`)
      writeFileSync(incoming, file.content)
      try {
        await installWorkFile(incoming, {
          workRef: `WORKS-src-${slugify(entry.name)}`,
          originName: file.name.split('/').pop(),
        })
      } finally {
        rmSync(incoming, { force: true })
      }
    }
  },

  async list() {
    const registry = loadRegistry()

    console.log(`\n📋 已安装的作品`)
    console.log(`存储根: ${getStoreRoot()}`)

    if (registry.works.length === 0) {
      console.log(`\n暂无已安装的作品`)
      return
    }

    console.log(`\n共 ${registry.works.length} 个作品:\n`)

    for (const work of registry.works) {
      const workDir = join(getWorksDir(), work.ref)
      const installed = existsSync(workDir)

      console.log(`  ${work.ref}`)
      console.log(`    标题: ${work.title}`)
      console.log(`    类型: ${work.type}`)
      console.log(`    版本: ${work.version}`)
      console.log(`    状态: ${installed ? '✓ 已安装' : '⚠️ 未找到'}`)
      console.log(`    安装时间: ${work.installed_at}`)

      if (work.capabilities && work.capabilities.length > 0) {
        console.log(`    能力: ${work.capabilities.join(', ')}`)
      }
      console.log()
    }
  },

  async show(ref) {
    const workRef = parseWorkRef(ref)
    const registry = loadRegistry()

    const work = registry.works.find(w => w.ref === workRef)
    if (!work) {
      throw new Error(`未找到作品: ${workRef}`)
    }

    const workDir = join(getWorksDir(), workRef)
    if (!existsSync(workDir)) {
      throw new Error(`作品目录不存在: ${workDir}`)
    }

    const meta = JSON.parse(readFileSync(join(workDir, 'meta.json'), 'utf-8'))

    console.log(`\n📦 作品详情`)
    console.log(`\n引用: ${workRef}`)
    console.log(`标题: ${meta.emoji || ''} ${meta.name}`)
    console.log(`描述: ${meta.brief}`)
    console.log(`类型: ${meta.view?.kind}`)
    console.log(`版本: ${meta.schema_version || '1.0.0'}`)
    console.log(`标签: ${meta.tags}`)

    if (meta.capabilities && meta.capabilities.length > 0) {
      console.log(`\n能力:`)
      meta.capabilities.forEach(cap => console.log(`  - ${cap}`))
    }

    if (meta.requires) {
      console.log(`\n依赖:`)
      console.log(JSON.stringify(meta.requires, null, 2))
    }

    console.log(`\n路径: ${workDir}`)
    console.log(`安装时间: ${work.installed_at}`)
  },

  async search(query) {
    console.log(`\n🔍 搜索作品: "${query}"`)

    const registry = loadRegistry()
    const results = registry.works.filter(w =>
      String(w.title).toLowerCase().includes(query.toLowerCase()) ||
      w.type?.toLowerCase().includes(query.toLowerCase()) ||
      (w.capabilities || []).some(c => c.toLowerCase().includes(query.toLowerCase()))
    )

    if (results.length === 0) {
      console.log(`\n未找到匹配的作品`)
      return
    }

    console.log(`\n找到 ${results.length} 个作品:\n`)

    for (const work of results) {
      console.log(`  ${work.ref} - ${work.title}`)
      console.log(`    类型: ${work.type} | 版本: ${work.version}`)
      if (work.capabilities && work.capabilities.length > 0) {
        console.log(`    能力: ${work.capabilities.join(', ')}`)
      }
      console.log()
    }
  },

  async check(ref, options = {}) {
    const workRef = parseWorkRef(ref)
    const registry = loadRegistry()
    const worksDir = getWorksDir()

    const work = registry.works.find(w => w.ref === workRef)
    if (!work) {
      throw new Error(`未找到作品: ${workRef}`)
    }

    console.log(`\n🔍 检查依赖: ${work.title}`)

    // 使用依赖解析器
    const resolver = new DependencyResolver(registry, worksDir)

    // 检查循环依赖
    const cycles = resolver.detectCycles(workRef)
    if (cycles.length > 0) {
      console.error(`\n⚠️ 检测到循环依赖:`)
      cycles.forEach(cycle => {
        console.error(`  ${cycle.join(' → ')}`)
      })
    }

    // 获取所有依赖
    const deps = resolver.getDependencies(workRef)

    if (deps.length === 0) {
      console.log(`\n✅ 无依赖`)
      return
    }

    console.log(`\n依赖树:`)
    console.log(resolver.printTree(workRef))

    // 检查缺失的依赖
    const missing = resolver.getMissingDependencies(workRef)

    if (missing.length > 0) {
      console.log(`\n⚠️ 缺少 ${missing.length} 个依赖:`)
      missing.forEach(m => {
        if (m.error) {
          console.log(`  ✗ ${m.ref} - ${m.error}`)
        } else {
          console.log(`  ✗ ${m.ref} - 未安装`)
        }
      })

      if (options['auto-install']) {
        console.log(`\n自动安装依赖（经分发源）...`)
        // "未找到作品" → 可从分发源补装；循环依赖等致命错误才跳过
        const blocked = missing.filter((m) => m.error && !/未找到作品/.test(m.error))
        const installable = missing.filter((m) => !m.error || /未找到作品/.test(m.error))
        for (const m of blocked) console.log(`  ✗ ${m.ref} - ${m.error}（无法自动安装）`)
        for (const m of installable) await commands.install(m.ref, options)
        return
      }
      console.log(`\n提示: 使用 'dsh-works check ${workRef} --auto-install --from <源>' 自动安装缺失的依赖`)
      throw new Error(`缺少 ${missing.length} 个依赖`)
    }
    console.log(`\n✅ 所有依赖已满足`)
  },

  async uninstall(ref) {
    const workRef = parseWorkRef(ref)
    const registry = loadRegistry()

    const work = registry.works.find(w => w.ref === workRef)
    if (!work) {
      throw new Error(`未找到作品: ${workRef}`)
    }

    console.log(`\n🗑️ 卸载作品: ${work.title}`)

    const workDir = join(getWorksDir(), workRef)
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true })
      console.log(`  ✓ 删除目录: ${workDir}`)
    }

    // 更新注册表
    registry.works = registry.works.filter(w => w.ref !== workRef)

    // 清理能力索引
    for (const cap in registry.capabilities) {
      registry.capabilities[cap] = registry.capabilities[cap].filter(r => r !== workRef)
      if (registry.capabilities[cap].length === 0) {
        delete registry.capabilities[cap]
      }
    }

    saveRegistry(registry)

    console.log(`\n✅ 卸载成功`)
  }
}

export { commands, parseWorkRef }

// 参数解析复用 dsh-plugin-kit cli 脚手架（parseArgs）；此处仅为兼容旧导入路径再导出
export { parseArgs }

async function main() {
  const [,, cmd, ...rest] = process.argv

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
DSH Works 管理工具

用法:
  dsh-works install <file.works|name> [--from <index.json|URL>] [--version <v>]   安装作品
  dsh-works list                             列出已安装的作品
  dsh-works show <WORKS-id>                  查看作品详情
  dsh-works search <query>                   搜索作品
  dsh-works check <WORKS-id> [--auto-install]  检查依赖（--auto-install 需配合 --from）
  dsh-works update <WORKS-id>                更新作品（暂未实现）
  dsh-works uninstall <WORKS-id>             卸载作品

分发源:
  --from <index.json|目录|URL>   静态分发源（schema 1，含 sha256/size 强校验）
  DSH_WORKS_SOURCE               缺省源；P3 平台注册表上线后指向平台 URL 即可

示例:
  dsh-works install deployment-ppt-basic.works
  dsh-works install deploy-ppt-basic --from ./dist/index.json
  dsh-works install deploy-ppt-basic --from https://ddr0.example/works/index.json --version 1.0.0
  dsh-works list
  dsh-works check WORKS-src-deploy-ppt-basic --auto-install --from ./dist/index.json

存储位置: ${getStoreRoot()}
  `)
    process.exit(0)
  }

  if (!commands[cmd]) {
    console.error(`未知命令: ${cmd}`)
    console.log(`使用 'dsh-works help' 查看帮助`)
    process.exit(1)
  }

  const { flags, positional } = parseArgs(rest)
  try {
    await commands[cmd](positional[0], flags)
  } catch (err) {
    console.error(`执行失败: ${err.message}`)
    process.exit(1)
  }
}

if (isMain(import.meta.url)) main()

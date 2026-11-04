#!/usr/bin/env node
/**
 * DSH 统一部署启动器
 * 
 * 用法：
 *   dsh-deploy start <config.json>    # 根据配置创建并启动 runtime
 *   dsh-deploy stop <config.json>     # 停止配置对应的 runtime
 *   dsh-deploy restart <config.json>  # 重启
 *   dsh-deploy status <config.json>   # 查看状态
 *   dsh-deploy validate <config.json> # 验证配置
 *   dsh-deploy list                   # 列出所有部署
 *   dsh-deploy clean <config.json>    # 停止并删除
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import { worksToDeploymentConfig, validateWorksDeployment } from '../lib/works-parser.mjs'
import { auditRowCoverage } from '../lib/row-audit.mjs'
import { createRuntime as sdkCreateRuntime,
  defaultRuntimeStoreRoot,
  probeHttp,
  readRuntime,
  removeRuntime as sdkRemoveRuntime,
  runtimePublicInfo,
  safeSlug,
  startRuntime as sdkStartRuntime,
  stopRuntime as sdkStopRuntime,
} from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 加载配置
function loadConfig(configPath) {
  const abs = resolve(configPath)
  if (!existsSync(abs)) {
    throw new Error(`配置文件不存在: ${abs}`)
  }
  
  let config
  
  // 支持 .works 和 .json 两种格式
  if (abs.endsWith('.works')) {
    console.log(`加载 .works 格式配置: ${basename(abs)}`)
    try {
      config = worksToDeploymentConfig(abs)
    } catch (err) {
      throw new Error(`.works 文件解析失败: ${err.message}`)
    }
    // CODE 段语义校验（deployment/source 必填口径，与控制面一致）
    const deep = validateWorksDeployment(config)
    if (!deep.valid) {
      throw new Error(`.works 部署语义校验失败:\n- ${deep.errors.join('\n- ')}`)
    }
  } else {
    config = JSON.parse(readFileSync(abs, 'utf-8'))
  }
  
  // 验证必需字段
  if (!config.name || !config.version || !config.deployment) {
    throw new Error('配置缺少必需字段: name, version, deployment')
  }
  
  // 解析相对路径
  const configDir = dirname(abs)
  if (config.deployment.source && !config.deployment.source.startsWith('/')) {
    config.deployment.source = resolve(configDir, config.deployment.source)
  }
  
  config._configPath = abs
  config._configDir = configDir
  
  return config
}

// 生成 runtime ID（slug 化 + 名称摘要：中文名/特殊字符安全，且跨次执行确定性一致）
function getRuntimeId(config) {
  const slug = safeSlug(config.name) || 'deploy'
  const digest = crypto.createHash('sha256').update(`${config.name}@${config.version}`).digest('hex').slice(0, 4)
  return `rt-${slug}-${digest}`
}

// 获取部署状态文件路径
function getStateFile(config) {
  const storeRoot = config.deployment.storeRoot || join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
  return join(storeRoot, 'deployments', `${config.name}.json`)
}

// 保存部署状态
function saveState(config, runtimeId, status) {
  const stateFile = getStateFile(config)
  mkdirSync(dirname(stateFile), { recursive: true })
  
  const state = {
    name: config.name,
    version: config.version,
    runtimeId,
    configPath: config._configPath,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  return state
}

// 读取部署状态
function loadState(config) {
  const stateFile = getStateFile(config)
  if (!existsSync(stateFile)) return null
  return JSON.parse(readFileSync(stateFile, 'utf-8'))
}

// 执行钩子命令
function executeHooks(hooks, context) {
  if (!hooks || hooks.length === 0) return
  
  console.log(`\n执行钩子 (${hooks.length} 个命令)...`)
  for (const cmd of hooks) {
    try {
      // 替换变量
      const resolved = cmd
        .replace(/\$\{runtimeId\}/g, context.runtimeId || '')
        .replace(/\$\{configPath\}/g, context.configPath || '')
      
      console.log(`  → ${resolved}`)
      execSync(resolved, { 
        stdio: 'inherit',
        cwd: context.configDir,
        shell: true
      })
    } catch (err) {
      console.error(`  ✗ 钩子执行失败: ${err.message}`)
      throw err
    }
  }
}

// 部署级 store root（deployment.storeRoot > DSH_STORE_ROOT > ~/.dsh-store）
function storeRootOf(config) {
  return config.deployment.storeRoot ? resolve(config.deployment.storeRoot) : defaultRuntimeStoreRoot()
}

// 健康检查：进程内读 runtime + fetch 探测（不依赖外部 curl / 子进程 JSON 解析）
async function healthCheck(config, runtimeId) {
  const healthCfg = config.launcher?.healthCheck
  if (!healthCfg || !healthCfg.enabled) return true

  let info
  try {
    info = runtimePublicInfo(readRuntime(storeRootOf(config), runtimeId))
  } catch (err) {
    console.error(`  ✗ 无法读取 runtime: ${err.message}`)
    return false
  }

  const harnessUrl = info.harnessUrl
  const contentUrl = info.contentUrl

  console.log(`\n健康检查...`)
  console.log(`  Harness: ${harnessUrl}`)
  console.log(`  Content: ${contentUrl}`)

  try {
    const timeoutMs = Math.max(1, Number(healthCfg.timeout) || 10) * 1000
    const ok = await probeHttp(`${contentUrl.replace(/\/+$/, '')}/healthz`, timeoutMs)
    if (ok) console.log(`  ✓ 健康检查通过`)
    else console.error(`  ✗ 健康检查失败`)
    return ok
  } catch (err) {
    console.error(`  ✗ 健康检查失败: ${err.message}`)
    return false
  }
}

// 创建 runtime（进程内 SDK 调用，替代 execSync + JSON.parse stdout 粘合）
async function createRuntimeFor(config) {
  const runtimeId = getRuntimeId(config)
  console.log(`\n创建 runtime: ${runtimeId}`)

  const { deployment, runtime } = config

  if (deployment.type !== 'domain') {
    throw new Error(`不支持的部署类型: ${deployment.type}（当前仅支持 domain；suite 请先组装为 domain 包）`)
  }

  const ports = runtime?.ports || {}
  const ranges = [ports.harness?.range, ports.content?.range].filter((value) => Number.isFinite(Number(value))).map(Number)

  console.log(`  domain: ${deployment.source}`)

  try {
    const created = await sdkCreateRuntime({
      name: config.name,
      runtimeId,
      domainInput: deployment.source,
      storeRoot: storeRootOf(config),
      workId: runtime?.workId || undefined,
      model: runtime?.model,
      harnessPort: ports.harness?.preferred,
      contentPort: ports.content?.preferred,
      portRange: ranges.length ? Math.max(...ranges) : undefined,
    })
    const info = runtimePublicInfo(created)
    console.log(`✓ Runtime 创建成功: ${info.runtimeId}`)
    return info
  } catch (err) {
    console.error(`✗ Runtime 创建失败:`, err.message)
    throw err
  }
}

// 启动 runtime（进程内 SDK 调用）
async function startRuntimeFor(config, runtimeId) {
  console.log(`\n启动 runtime: ${runtimeId}`)

  const mode = config.launcher?.mode || 'background'

  try {
    const result = await sdkStartRuntime({
      storeRoot: storeRootOf(config),
      runtimeId,
      detached: mode !== 'foreground',
      waitMs: 30000,
    })
    console.log(`✓ Runtime 启动成功 (pid ${result.pid || 'N/A'}${result.ready ? '，已就绪' : '，未在等待时间内就绪'})`)
    return runtimePublicInfo(result.runtime)
  } catch (err) {
    console.error(`✗ Runtime 启动失败:`, err.message)
    throw err
  }
}

// 停止 runtime（进程内 SDK 调用）
async function stopRuntimeFor(config, runtimeId) {
  console.log(`\n停止 runtime: ${runtimeId}`)

  try {
    await sdkStopRuntime({ storeRoot: storeRootOf(config), runtimeId })
    console.log(`✓ Runtime 已停止`)
  } catch (err) {
    console.error(`✗ Runtime 停止失败:`, err.message)
    throw err
  }
}

// 命令处理
const commands = {
  async start(configPath) {
    const config = loadConfig(configPath)
    const runtimeId = getRuntimeId(config)
    
    console.log(`\n🚀 部署启动: ${config.title || config.name}`)
    console.log(`配置: ${configPath}`)
    console.log(`Runtime ID: ${runtimeId}`)
    
    // 检查是否已存在
    const state = loadState(config)
    if (state && state.status === 'running') {
      console.log(`\n⚠️  Runtime 已在运行: ${state.runtimeId}`)
      console.log(`使用 'restart' 命令重启，或 'stop' 后再启动`)
      return
    }
    
    const context = {
      runtimeId,
      configPath: config._configPath,
      configDir: config._configDir
    }
    
    try {
      // beforeStart 钩子
      executeHooks(config.launcher?.beforeStart, context)

      // 创建 runtime
      const runtime = await createRuntimeFor(config)

      // 启动 runtime
      if (config.deployment.autoStart !== false) {
        await startRuntimeFor(config, runtime.runtimeId)

        // 健康检查
        await new Promise(resolve => setTimeout(resolve, 2000)) // 等待启动
        let healthy = await healthCheck(config, runtime.runtimeId)

        if (!healthy && config.launcher?.healthCheck?.retries) {
          console.log(`\n重试健康检查...`)
          for (let i = 0; i < config.launcher.healthCheck.retries; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000))
            if (await healthCheck(config, runtime.runtimeId)) {
              healthy = true
              break
            }
          }
        }
        if (!healthy) {
          throw new Error(`健康检查未通过（runtime 可能未就绪）: ${runtime.runtimeId}`)
        }
      }

      // afterStart 钩子
      executeHooks(config.launcher?.afterStart, context)

      // 保存状态
      saveState(config, runtime.runtimeId, 'running')

      console.log(`\n✅ 部署成功完成！`)
      console.log(`\nHarness: ${runtime.harnessUrl}`)
      console.log(`Content: ${runtime.contentUrl}`)

    } catch (err) {
      console.error(`\n❌ 部署失败:`, err.message)
      saveState(config, runtimeId, 'failed')
      throw err
    }
  },
  
  async stop(configPath) {
    const config = loadConfig(configPath)
    const state = loadState(config)
    
    if (!state) {
      console.log(`⚠️  未找到部署状态: ${config.name}`)
      return
    }
    
    console.log(`\n🛑 停止部署: ${config.title || config.name}`)
    
    const context = {
      runtimeId: state.runtimeId,
      configPath: config._configPath,
      configDir: config._configDir
    }
    
    try {
      // beforeStop 钩子
      executeHooks(config.launcher?.beforeStop, context)

      // 停止 runtime
      await stopRuntimeFor(config, state.runtimeId)

      // afterStop 钩子
      executeHooks(config.launcher?.afterStop, context)

      // 更新状态
      saveState(config, state.runtimeId, 'stopped')

      console.log(`\n✅ 部署已停止`)

    } catch (err) {
      console.error(`\n❌ 停止失败:`, err.message)
      throw err
    }
  },
  
  async restart(configPath) {
    console.log(`\n🔄 重启部署...`)
    await commands.stop(configPath)
    await new Promise(resolve => setTimeout(resolve, 2000))
    await commands.start(configPath)
  },
  
  async status(configPath) {
    const config = loadConfig(configPath)
    const state = loadState(config)
    
    console.log(`\n📊 部署状态`)
    console.log(`名称: ${config.name}`)
    console.log(`版本: ${config.version}`)
    console.log(`配置: ${configPath}`)
    
    if (!state) {
      console.log(`状态: 未部署`)
      return
    }
    
    console.log(`Runtime ID: ${state.runtimeId}`)
    console.log(`状态: ${state.status}`)
    console.log(`创建时间: ${state.createdAt}`)
    console.log(`更新时间: ${state.updatedAt}`)
    
    // 查询实际运行状态（进程内读取，替代 execSync + JSON.parse）
    try {
      const runtime = runtimePublicInfo(readRuntime(storeRootOf(config), state.runtimeId))

      console.log(`\n运行时信息:`)
      console.log(`  运行中: ${runtime.running}`)
      console.log(`  Harness: ${runtime.harnessUrl}`)
      console.log(`  Content: ${runtime.contentUrl}`)
      console.log(`  端口: harness=${runtime.ports.harness}, content=${runtime.ports.content}`)
    } catch (err) {
      console.log(`\n⚠️  无法获取运行时信息: ${err.message}`)
    }
  },
  
  async validate(configPath) {
    console.log(`\n🔍 验证配置: ${configPath}`)

    try {
      const config = loadConfig(configPath)

      console.log(`✓ 配置文件格式正确`)
      console.log(`  名称: ${config.name}`)
      console.log(`  版本: ${config.version}`)
      console.log(`  类型: ${config.deployment.type}`)
      console.log(`  源: ${config.deployment.source}`)

      // 检查源路径
      if (!existsSync(config.deployment.source)) {
        throw new Error(`源路径不存在: ${config.deployment.source}`)
      }
      console.log(`✓ 源路径存在`)

      // 检查 domain/suite 配置
      if (config.deployment.type === 'domain') {
        const domainFile = join(config.deployment.source, 'dsh-domain.json')
        if (!existsSync(domainFile)) {
          throw new Error(`domain 配置不存在: ${domainFile}`)
        }
        console.log(`✓ Domain 配置存在`)

        // 行覆盖审计：bindings/removeRows 引用的行必须在组件链有声明，
        // 否则运行时会静默失去宿主（行不存在不是错误，无任何日志）
        const audit = auditRowCoverage(config.deployment.source)
        if (!audit.ok) {
          throw new Error(
            `行覆盖审计失败（以下行在组件链无声明，运行时将静默失去宿主）:\n- ${audit.missing.map((item) => `${item.id}（被 ${item.referencedBy} 引用）`).join('\n- ')}`,
          )
        }
        console.log(`✓ 行覆盖审计通过（${audit.declaredCount} 行声明于 ${audit.suites.length} 个 suite）`)
      }

      console.log(`\n✅ 配置验证通过`)

    } catch (err) {
      console.error(`\n❌ 配置验证失败:`, err.message)
      throw err
    }
  },
  
  async list() {
    const storeRoot = process.env.DSH_STORE_ROOT || join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
    const deploymentsDir = join(storeRoot, 'deployments')
    
    console.log(`\n📋 所有部署`)
    console.log(`存储根: ${storeRoot}`)
    
    if (!existsSync(deploymentsDir)) {
      console.log(`\n无部署记录`)
      return
    }
    
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(deploymentsDir).filter(f => f.endsWith('.json'))
    
    if (files.length === 0) {
      console.log(`\n无部署记录`)
      return
    }
    
    console.log(`\n找到 ${files.length} 个部署:\n`)
    
    for (const file of files) {
      const state = JSON.parse(readFileSync(join(deploymentsDir, file), 'utf-8'))
      console.log(`  ${state.name} (${state.version})`)
      console.log(`    Runtime: ${state.runtimeId}`)
      console.log(`    状态: ${state.status}`)
      console.log(`    配置: ${state.configPath}`)
      console.log(`    更新: ${state.updatedAt}`)
      console.log()
    }
  },
  
  async clean(configPath) {
    const config = loadConfig(configPath)
    const state = loadState(config)
    
    if (!state) {
      console.log(`⚠️  未找到部署状态: ${config.name}`)
      return
    }
    
    console.log(`\n🗑️  清理部署: ${config.title || config.name}`)
    
    try {
      // 先停止
      if (state.status === 'running') {
        await commands.stop(configPath)
      }

      // 删除 runtime
      console.log(`\n删除 runtime: ${state.runtimeId}`)
      sdkRemoveRuntime({ storeRoot: storeRootOf(config), runtimeId: state.runtimeId })

      // 删除状态文件
      const stateFile = getStateFile(config)
      if (existsSync(stateFile)) {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(stateFile)
      }

      console.log(`\n✅ 部署已清理`)

    } catch (err) {
      console.error(`\n❌ 清理失败:`, err.message)
      throw err
    }
  }
}

// 主程序（仅直接执行时运行；作为模块导入时可测试 commands）
export { commands, loadConfig, getRuntimeId }

async function main() {
  const [,, cmd, ...args] = process.argv

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
DSH 统一部署启动器

用法:
  dsh-deploy start <config.json>      创建并启动部署（支持 .works 与 .json 配置）
  dsh-deploy stop <config.json>       停止部署
  dsh-deploy restart <config.json>    重启部署
  dsh-deploy status <config.json>     查看部署状态
  dsh-deploy validate <config.json>   验证配置文件
  dsh-deploy list                     列出所有部署
  dsh-deploy clean <config.json>      停止并删除部署

配置示例: packages/dsh-suite-kit/examples/deployment-*.json / *.works
  `)
    process.exit(0)
  }

  if (!commands[cmd]) {
    console.error(`未知命令: ${cmd}`)
    console.log(`使用 'dsh-deploy help' 查看帮助`)
    process.exit(1)
  }

  try {
    await commands[cmd](...args)
  } catch (err) {
    console.error('执行失败:', err.message)
    process.exit(1)
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()

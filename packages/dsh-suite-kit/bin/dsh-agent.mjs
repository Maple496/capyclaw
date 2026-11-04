#!/usr/bin/env node
/**
 * DSH Agent 助手
 * 
 * 对话式作品推荐和任务执行
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { AgentTaskExecutor, ConversationalAgent } from '../lib/agent-integration.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 加载注册表
function loadRegistry() {
  const storeRoot = process.env.DSH_STORE_ROOT || 
                   join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
  const registryFile = join(storeRoot, 'registry.json')
  
  try {
    return JSON.parse(readFileSync(registryFile, 'utf-8'))
  } catch {
    return { version: '1.0.0', works: [], capabilities: {} }
  }
}

// 获取作品目录
function getWorksDir() {
  const storeRoot = process.env.DSH_STORE_ROOT || 
                   join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
  return join(storeRoot, 'works')
}

// 命令处理
const commands = {
  async recommend(query) {
    const registry = loadRegistry()
    const worksDir = getWorksDir()
    const executor = new AgentTaskExecutor(registry, worksDir)
    
    console.log(executor.generateRecommendation(query))
  },
  
  async chat(intent) {
    const registry = loadRegistry()
    const worksDir = getWorksDir()
    const executor = new AgentTaskExecutor(registry, worksDir)
    const agent = new ConversationalAgent(executor)
    
    console.log(agent.handleIntent(intent))
  },
  
  async checkTask(taskFile) {
    const registry = loadRegistry()
    const worksDir = getWorksDir()
    const executor = new AgentTaskExecutor(registry, worksDir)
    
    const task = JSON.parse(readFileSync(taskFile, 'utf-8'))
    const result = await executor.preCheckTask(task)
    
    if (result.ready) {
      console.log('✅ 任务准备就绪')
      console.log('\n可用能力:')
      result.available.forEach(a => {
        console.log(`  ✓ ${a.capability}`)
        a.works.forEach(w => console.log(`    - ${w.title} (${w.ref})`))
      })
    } else {
      console.log(result.message)
    }
  }
}

// 主程序
const [,, cmd, ...args] = process.argv

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`
DSH Agent 助手

用法:
  dsh-agent recommend <query>       推荐作品
  dsh-agent chat <intent>           对话式交互
  dsh-agent check-task <task.json>  检查任务依赖

示例:
  dsh-agent recommend "PPT部署"
  dsh-agent chat "帮我部署一个PPT工作台"
  dsh-agent check-task task.json
  `)
  process.exit(0)
}

if (!commands[cmd.replace(/-/g, '')]) {
  console.error(`未知命令: ${cmd}`)
  process.exit(1)
}

const cmdName = cmd.replace(/-/g, '')
commands[cmdName](...args).catch(err => {
  console.error('执行失败:', err.message)
  process.exit(1)
})

/**
 * AI Agent 集成模块
 * 
 * 功能：
 * - 任务依赖自动检查
 * - 配方推荐
 * - 智能安装建议
 */

import { DependencyResolver } from './dependency-resolver.mjs'

/**
 * Agent 任务执行器
 */
export class AgentTaskExecutor {
  constructor(registry, worksDir) {
    this.registry = registry
    this.worksDir = worksDir
    this.resolver = new DependencyResolver(registry, worksDir)
  }
  
  /**
   * 根据能力查找作品
   * @param {string} capability - 能力标识
   * @returns {Array} 匹配的作品列表
   */
  findWorksByCapability(capability) {
    const workRefs = this.registry.capabilities[capability] || []
    return workRefs.map(ref => {
      const work = this.registry.works.find(w => w.ref === ref)
      return work
    }).filter(Boolean)
  }
  
  /**
   * 检查任务所需的能力
   * @param {object} task - 任务对象
   * @returns {object} 检查结果
   */
  checkTaskCapabilities(task) {
    const requiredCaps = task.requires_capabilities || []
    const missing = []
    const available = []
    
    for (const cap of requiredCaps) {
      const works = this.findWorksByCapability(cap)
      
      if (works.length === 0) {
        missing.push({
          capability: cap,
          reason: '未找到提供此能力的作品'
        })
      } else {
        const installed = works.filter(w => w.installed)
        if (installed.length === 0) {
          missing.push({
            capability: cap,
            works: works.map(w => ({ ref: w.ref, title: w.title })),
            reason: '作品未安装'
          })
        } else {
          available.push({
            capability: cap,
            works: installed.map(w => ({ ref: w.ref, title: w.title }))
          })
        }
      }
    }
    
    return {
      ready: missing.length === 0,
      available,
      missing
    }
  }
  
  /**
   * 推荐配方
   * @param {string} query - 查询关键词
   * @param {object} context - 上下文信息
   * @returns {Array} 推荐的作品列表
   */
  recommendWorks(query, context = {}) {
    const results = []
    const queryLower = query.toLowerCase()
    
    // 关键词匹配
    for (const work of this.registry.works) {
      let score = 0
      
      // 标题匹配
      if (work.title.toLowerCase().includes(queryLower)) {
        score += 10
      }
      
      // 类型匹配
      if (context.type && work.type === context.type) {
        score += 5
      }
      
      // 能力匹配
      if (context.capabilities) {
        const matchedCaps = (work.capabilities || []).filter(cap => 
          context.capabilities.includes(cap)
        )
        score += matchedCaps.length * 3
      }
      
      // 标签匹配（修复：支持中文）
      if (work.tags) {
        const tags = work.tags.split(',').map(t => t.trim())
        if (tags.some(t => t.includes(query) || query.includes(t))) {
          score += 5
        }
      }
      
      // 简介匹配
      if (work.brief && work.brief.includes(query)) {
        score += 3
      }
      
      if (score > 0) {
        results.push({
          work,
          score,
          installed: work.installed
        })
      }
    }
    
    // 按分数排序
    results.sort((a, b) => b.score - a.score)
    
    return results.slice(0, 10) // 返回前10个结果
  }
  
  /**
   * 生成对话式推荐
   * @param {string} userIntent - 用户意图
   * @returns {string} 推荐文本
   */
  generateRecommendation(userIntent) {
    const recommendations = this.recommendWorks(userIntent)
    
    if (recommendations.length === 0) {
      return `没有找到与"${userIntent}"相关的作品。\n\n您可以：\n1. 尝试其他关键词\n2. 浏览所有作品：dsh-works list\n3. 创建新的配置`
    }
    
    const top = recommendations[0]
    const work = top.work
    
    let response = `我找到了一个现成的配方：\n\n`
    response += `📦 ${work.title} (${work.ref}) ${top.installed ? '✅ 已安装' : '⚠️ 未安装'}\n`
    response += `   类型: ${work.type} | 版本: ${work.version}\n`
    
    if (work.capabilities && work.capabilities.length > 0) {
      response += `   能力: ${work.capabilities.join(', ')}\n`
    }
    
    response += `\n`
    
    // 检查依赖
    try {
      const deps = this.resolver.getDependencies(work.ref)
      const missing = deps.filter(d => !d.installed || d.error)
      
      if (deps.length > 0) {
        response += `依赖项：\n`
        deps.forEach(d => {
          const status = d.installed ? '✓' : '✗'
          response += `  ${status} ${d.ref}\n`
        })
        response += `\n`
      }
      
      if (missing.length > 0) {
        response += `⚠️ 需要安装 ${missing.length} 个依赖\n\n`
      }
    } catch (err) {
      // 忽略依赖检查错误
    }
    
    response += `我可以帮你：\n`
    if (!top.installed) {
      response += `1. [安装] - dsh-works install ${work.ref}\n`
    }
    response += `2. [查看详情] - dsh-works show ${work.ref}\n`
    response += `3. [检查依赖] - dsh-works check ${work.ref}\n`
    
    if (top.installed) {
      response += `4. [直接部署] - dsh-deploy start ${work.ref}\n`
    }
    
    if (recommendations.length > 1) {
      response += `\n还有 ${recommendations.length - 1} 个其他选项可供选择。`
    }
    
    return response
  }
  
  /**
   * 执行任务前的预检查
   * @param {object} task - 任务对象
   * @returns {object} 预检查结果
   */
  async preCheckTask(task) {
    const check = this.checkTaskCapabilities(task)
    
    if (!check.ready) {
      const suggestions = []
      
      for (const missing of check.missing) {
        if (missing.works && missing.works.length > 0) {
          suggestions.push({
            capability: missing.capability,
            action: 'install',
            works: missing.works
          })
        } else {
          suggestions.push({
            capability: missing.capability,
            action: 'search',
            query: missing.capability
          })
        }
      }
      
      return {
        ready: false,
        missing: check.missing,
        suggestions,
        message: this.generateMissingCapabilitiesMessage(check.missing, suggestions)
      }
    }
    
    return {
      ready: true,
      available: check.available
    }
  }
  
  /**
   * 生成缺失能力的提示消息
   * @param {Array} missing - 缺失的能力
   * @param {Array} suggestions - 建议
   * @returns {string}
   */
  generateMissingCapabilitiesMessage(missing, suggestions) {
    let msg = `⚠️ 任务需要以下能力，但当前不可用：\n\n`
    
    for (let i = 0; i < missing.length; i++) {
      const m = missing[i]
      const s = suggestions[i]
      
      msg += `${i + 1}. ${m.capability}\n`
      
      if (s.action === 'install' && s.works.length > 0) {
        msg += `   推荐作品：\n`
        s.works.forEach(w => {
          msg += `   - ${w.title} (${w.ref})\n`
        })
        msg += `   安装命令：dsh-works install ${s.works[0].ref}\n`
      } else {
        msg += `   建议：搜索提供此能力的作品\n`
        msg += `   命令：dsh-works search "${m.capability}"\n`
      }
      msg += `\n`
    }
    
    return msg
  }
}

/**
 * 对话式 Agent 助手
 */
export class ConversationalAgent {
  constructor(executor) {
    this.executor = executor
  }
  
  /**
   * 处理用户意图
   * @param {string} intent - 用户意图
   * @param {object} context - 对话上下文
   * @returns {string} 响应
   */
  handleIntent(intent, context = {}) {
    const lowerIntent = intent.toLowerCase()
    
    // 部署意图
    if (lowerIntent.includes('部署') || lowerIntent.includes('deploy')) {
      if (lowerIntent.includes('ppt') || lowerIntent.includes('演示')) {
        return this.executor.generateRecommendation('PPT部署')
      }
      return this.executor.generateRecommendation('部署')
    }
    
    // 开发意图
    if (lowerIntent.includes('开发') || lowerIntent.includes('dev')) {
      return this.executor.generateRecommendation('开发环境')
    }
    
    // 搜索意图
    if (lowerIntent.includes('搜索') || lowerIntent.includes('查找')) {
      const query = intent.replace(/搜索|查找/g, '').trim()
      return this.executor.generateRecommendation(query)
    }
    
    // 通用推荐
    return this.executor.generateRecommendation(intent)
  }
}

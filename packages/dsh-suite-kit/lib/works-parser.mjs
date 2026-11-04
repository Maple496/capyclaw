#!/usr/bin/env node
/**
 * .works 格式解析器
 * 
 * 解析 .works 文件的双段式格式:
 *   %%%WORKS-META%%%
 *   { JSON metadata }
 *   
 *   %%%WORKS-CODE%%%
 *   { JSON content or code }
 */

import { readFileSync, existsSync } from 'node:fs'

/**
 * 解析 .works 内容（字符串形态；parseWorksFile 委托到这里）。
 * @param {string} content - .works 文本内容
 * @returns {{ meta: object, code: object|string }} 解析结果
 */
export function parseWorksContent(content) {
  const metaStart = content.indexOf('%%%WORKS-META%%%')
  const codeStart = content.indexOf('%%%WORKS-CODE%%%')

  if (metaStart === -1) {
    throw new Error('缺少 %%%WORKS-META%%% 标记')
  }

  if (codeStart === -1) {
    throw new Error('缺少 %%%WORKS-CODE%%% 标记')
  }

  const metaContent = content.substring(
    metaStart + '%%%WORKS-META%%%'.length,
    codeStart
  ).trim()

  const codeContent = content.substring(
    codeStart + '%%%WORKS-CODE%%%'.length
  ).trim()

  let meta, code

  try {
    meta = JSON.parse(metaContent)
  } catch (err) {
    throw new Error(`META 段落解析失败: ${err.message}`)
  }

  // CODE 段可能是 JSON 或纯文本
  try {
    code = JSON.parse(codeContent)
  } catch (err) {
    // 如果不是 JSON，保留为字符串
    code = codeContent
  }

  return { meta, code }
}

/**
 * 解析 .works 文件
 * @param {string} filePath - .works 文件路径
 * @returns {{ meta: object, code: object|string }} 解析结果
 */
export function parseWorksFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }

  return parseWorksContent(readFileSync(filePath, 'utf-8'))
}

/**
 * 部署类 .works 的 CODE 段语义校验（deployment 语境）。
 * 必填口径与 dsh-deploy loadConfig / PYTHON_DEPLOYMENT_ADAPTER 保持一致：
 * CODE 为对象、deployment 必填、deployment.source 必填。
 * 返回 { valid: boolean, errors: string[] }
 */
export function validateWorksDeployment(code) {
  const errors = []

  if (!code || typeof code !== 'object' || Array.isArray(code)) {
    return { valid: false, errors: ['CODE 段必须是 JSON 对象（部署配置）'] }
  }
  if (!code.deployment || typeof code.deployment !== 'object' || Array.isArray(code.deployment)) {
    errors.push('CODE.deployment 缺失或不是对象')
  } else {
    if (typeof code.deployment.source !== 'string' || !code.deployment.source) {
      errors.push('CODE.deployment.source 必填（domain 目录或 manifest 路径）')
    }
    if (code.deployment.type != null && code.deployment.type !== 'domain') {
      errors.push(`CODE.deployment.type 暂只支持 domain: ${code.deployment.type}`)
    }
  }
  if (code.runtime != null && (typeof code.runtime !== 'object' || Array.isArray(code.runtime))) {
    errors.push('CODE.runtime 必须是对象')
  }
  if (code.launcher != null && (typeof code.launcher !== 'object' || Array.isArray(code.launcher))) {
    errors.push('CODE.launcher 必须是对象')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 验证 .works 文件格式（META 结构 + 部署类作品的 CODE 段语义）
 * @param {object} meta - 元数据
 * @param {object|string} code - 代码内容
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWorksFormat(meta, code) {
  const errors = []

  // 验证必需字段
  const requiredMetaFields = ['name', 'brief', 'view']
  for (const field of requiredMetaFields) {
    if (!meta[field]) {
      errors.push(`META 缺少必需字段: ${field}`)
    }
  }

  // 验证 view.kind
  if (meta.view && !meta.view.kind) {
    errors.push('META.view 缺少 kind 字段')
  }

  // 验证 schema_version
  if (meta.schema_version && !meta.schema_version.match(/^\d+\.\d+\.\d+$/)) {
    errors.push('META.schema_version 格式错误，应为 x.y.z')
  }

  // 部署类作品：CODE 段语义校验（与安装/启动/控制面的必填口径一致）
  if (meta.view?.kind === 'deployment') {
    const deep = validateWorksDeployment(code)
    errors.push(...deep.errors)
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * 转换 .works 为部署配置
 * @param {string} worksPath - .works 文件路径
 * @returns {object} 部署配置对象
 */
export function worksToDeploymentConfig(worksPath) {
  const { meta, code } = parseWorksFile(worksPath)
  
  // 验证是否为部署类型
  if (meta.view?.kind !== 'deployment') {
    throw new Error(`作品类型错误: 期望 'deployment'，实际 '${meta.view?.kind}'`)
  }
  
  // 验证 code 是对象
  if (typeof code !== 'object') {
    throw new Error('部署配置的 CODE 段必须是 JSON 对象')
  }
  
  // 转换为 deployment config 格式
  return {
    name: meta.name,
    version: meta.schema_version || '1.0.0',
    title: meta.name,
    description: meta.brief,
    
    // 从 code 段提取配置
    deployment: code.deployment,
    runtime: code.runtime,
    launcher: code.launcher,
    monitoring: code.monitoring,
    metadata: {
      ...code.metadata,
      tags: meta.tags ? meta.tags.split(',').map(t => t.trim()) : [],
      emoji: meta.emoji,
      capabilities: meta.capabilities,
      requires: meta.requires
    }
  }
}

// CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, command, ...args] = process.argv
  
  if (command === 'parse') {
    const filePath = args[0]
    if (!filePath) {
      console.error('用法: works-parser.mjs parse <file.works>')
      process.exit(1)
    }
    
    try {
      const { meta, code } = parseWorksFile(filePath)
      console.log('META:')
      console.log(JSON.stringify(meta, null, 2))
      console.log('\nCODE:')
      console.log(typeof code === 'string' ? code : JSON.stringify(code, null, 2))
    } catch (err) {
      console.error('解析失败:', err.message)
      process.exit(1)
    }
  } else if (command === 'validate') {
    const filePath = args[0]
    if (!filePath) {
      console.error('用法: works-parser.mjs validate <file.works>')
      process.exit(1)
    }
    
    try {
      const { meta, code } = parseWorksFile(filePath)
      const { valid, errors } = validateWorksFormat(meta, code)
      
      if (valid) {
        console.log('✓ 格式验证通过')
      } else {
        console.error('✗ 格式验证失败:')
        errors.forEach(err => console.error(`  - ${err}`))
        process.exit(1)
      }
    } catch (err) {
      console.error('解析失败:', err.message)
      process.exit(1)
    }
  } else if (command === 'convert') {
    const filePath = args[0]
    if (!filePath) {
      console.error('用法: works-parser.mjs convert <file.works>')
      process.exit(1)
    }
    
    try {
      const config = worksToDeploymentConfig(filePath)
      console.log(JSON.stringify(config, null, 2))
    } catch (err) {
      console.error('转换失败:', err.message)
      process.exit(1)
    }
  } else {
    console.log(`
.works 格式解析器

用法:
  works-parser.mjs parse <file.works>      解析并显示内容
  works-parser.mjs validate <file.works>   验证格式
  works-parser.mjs convert <file.works>    转换为部署配置
    `)
  }
}

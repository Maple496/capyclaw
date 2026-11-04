/**
 * 依赖管理模块
 * 
 * 功能：
 * - 递归解析依赖树
 * - 循环依赖检测
 * - 版本兼容性检查
 * - 自动安装依赖
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 依赖树节点
 */
class DependencyNode {
  constructor(ref, work, depth = 0) {
    this.ref = ref
    this.work = work
    this.depth = depth
    this.children = []
    this.installed = false
    this.optional = false
  }
}

/**
 * 依赖解析器
 */
export class DependencyResolver {
  constructor(registry, worksDir) {
    this.registry = registry
    this.worksDir = worksDir
    this.resolved = new Map()
    this.visiting = new Set()
  }
  
  /**
   * 递归解析依赖树
   * @param {string} workRef - 作品引用
   * @param {number} depth - 递归深度
   * @returns {DependencyNode}
   */
  resolve(workRef, depth = 0) {
    // 已解析过，直接返回
    if (this.resolved.has(workRef)) {
      return this.resolved.get(workRef)
    }
    
    // 检测循环依赖
    if (this.visiting.has(workRef)) {
      throw new Error(`检测到循环依赖: ${workRef}`)
    }
    
    // 查找作品
    const work = this.registry.works.find(w => w.ref === workRef)
    if (!work) {
      throw new Error(`未找到作品: ${workRef}`)
    }
    
    // 创建节点
    const node = new DependencyNode(workRef, work, depth)
    node.installed = work.installed && existsSync(`${this.worksDir}/${workRef}`)
    
    // 标记正在访问
    this.visiting.add(workRef)
    
    // 解析依赖
    const requires = work.requires || {}
    
    // 解析 runtime 依赖
    if (requires.runtime) {
      // TODO: 检查 runtime 版本
    }
    
    // 解析 components 依赖
    if (requires.components) {
      for (const comp of requires.components) {
        if (comp.startsWith('WORKS-') || comp.match(/^\d+$/)) {
          try {
            const childNode = this.resolve(comp, depth + 1)
            node.children.push(childNode)
          } catch (err) {
            // 依赖不存在或循环依赖
            node.children.push({
              ref: comp,
              error: err.message,
              depth: depth + 1
            })
          }
        }
      }
    }
    
    // 取消访问标记
    this.visiting.delete(workRef)
    
    // 缓存结果
    this.resolved.set(workRef, node)
    
    return node
  }
  
  /**
   * 获取依赖列表（广度优先，去重）
   * @param {string} workRef - 作品引用
   * @returns {Array<{ref, work, depth, installed}>}
   */
  getDependencies(workRef) {
    const root = this.resolve(workRef)
    const deps = []
    const seen = new Set([workRef])
    const queue = [...root.children]
    
    while (queue.length > 0) {
      const node = queue.shift()
      
      if (node.error) {
        deps.push({
          ref: node.ref,
          error: node.error,
          depth: node.depth
        })
        continue
      }
      
      if (!seen.has(node.ref)) {
        seen.add(node.ref)
        deps.push({
          ref: node.ref,
          work: node.work,
          depth: node.depth,
          installed: node.installed
        })
        queue.push(...node.children)
      }
    }
    
    return deps
  }
  
  /**
   * 获取缺失的依赖
   * @param {string} workRef - 作品引用
   * @returns {Array}
   */
  getMissingDependencies(workRef) {
    const deps = this.getDependencies(workRef)
    return deps.filter(d => !d.installed || d.error)
  }
  
  /**
   * 检查是否有循环依赖
   * @param {string} workRef - 作品引用
   * @returns {Array<string>} 循环依赖路径
   */
  detectCycles(workRef) {
    const cycles = []
    const path = []
    const visited = new Set()
    
    const dfs = (ref) => {
      if (path.includes(ref)) {
        cycles.push([...path, ref])
        return
      }
      
      if (visited.has(ref)) {
        return
      }
      
      visited.add(ref)
      path.push(ref)
      
      const work = this.registry.works.find(w => w.ref === ref)
      if (work && work.requires && work.requires.components) {
        for (const comp of work.requires.components) {
          if (comp.startsWith('WORKS-') || comp.match(/^\d+$/)) {
            dfs(comp)
          }
        }
      }
      
      path.pop()
    }
    
    dfs(workRef)
    return cycles
  }
  
  /**
   * 生成依赖树的文本表示
   * @param {string} workRef - 作品引用
   * @returns {string}
   */
  printTree(workRef) {
    const root = this.resolve(workRef)
    const lines = []
    
    const print = (node, prefix = '', isLast = true) => {
      const marker = isLast ? '└─' : '├─'
      const status = node.installed ? '✓' : '✗'
      const title = node.work ? node.work.title : node.ref
      
      lines.push(`${prefix}${marker} ${status} ${node.ref} - ${title}`)
      
      if (node.children && node.children.length > 0) {
        const childPrefix = prefix + (isLast ? '  ' : '│ ')
        node.children.forEach((child, i) => {
          print(child, childPrefix, i === node.children.length - 1)
        })
      }
    }
    
    print(root)
    return lines.join('\n')
  }
}

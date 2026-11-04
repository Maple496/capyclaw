/**
 * dsh-assembly-kit 主入口
 */

// 扫描器
export { scan, scanMultiple } from './scanner.mjs'

// 目录/搜索
export {
  search,
  findById,
  findByIds,
  filterByKind,
  listTags,
  listTools,
  listServices,
  listCapabilities,
  stats
} from './catalog.mjs'

// 解析器
export {
  resolve,
  topologicalSort
} from './resolver.mjs'

// 生成器
export {
  emitRegistry,
  verifyRegistry
} from './emitter-registry.mjs'

export {
  emitBundle,
  verifyBundle
} from './emitter-suite.mjs'

/**
 * 统一的 emit 函数，根据 target 分发
 */
export async function emit(resolved, productManifest, options = {}) {
  const target = productManifest.target || options.target
  
  if (!target) {
    throw new Error('emit 需要指定 target (registry 或 bundle)')
  }
  
  if (target === 'registry') {
    const { emitRegistry } = await import('./emitter-registry.mjs')
    return emitRegistry(resolved, options)
  } else if (target === 'bundle') {
    const { emitBundle } = await import('./emitter-suite.mjs')
    return emitBundle(resolved, productManifest, options)
  } else {
    throw new Error(`未知的 target: ${target}`)
  }
}

/**
 * 统一的 verify 函数
 */
export async function verify(outDir, target, options = {}) {
  if (!target) {
    throw new Error('verify 需要指定 target (registry 或 bundle)')
  }
  
  if (target === 'registry') {
    const { verifyRegistry } = await import('./emitter-registry.mjs')
    return verifyRegistry(outDir, options)
  } else if (target === 'bundle') {
    const { verifyBundle } = await import('./emitter-suite.mjs')
    return verifyBundle(outDir)
  } else {
    throw new Error(`未知的 target: ${target}`)
  }
}

/**
 * 完整工作流：扫描 → 解析 → 生成
 */
export async function build(productManifestPath, options = {}) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  const manifestFile = path.resolve(productManifestPath)
  const productManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  
  const workspaceRoot = options.workspaceRoot || path.dirname(manifestFile)
  const outDir = options.outDir || path.join(path.dirname(manifestFile), 'dist')
  
  // 扫描
  const library = await scan(workspaceRoot, {
    cache: options.cache !== false
  })
  
  // 解析
  const resolved = resolve(productManifest, library, {
    strict: options.strict
  })
  
  if (!resolved.ok && options.strict !== false) {
    throw new Error(`依赖解析失败:\n${resolved.errors.map(e => `  - ${e.type}: ${e.message || JSON.stringify(e)}`).join('\n')}`)
  }
  
  // 生成
  const result = await emit(resolved, productManifest, {
    ...options,
    outDir
  })
  
  return {
    ...result,
    resolved,
    productManifest
  }
}

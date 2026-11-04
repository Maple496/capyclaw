/**
 * 生成能力注册表产物：capabilities.manifest.json + capabilities.loader.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 生成 capabilities.manifest.json
 */
function generateManifest(components, options = {}) {
  const { baseUrl = './' } = options
  
  const capabilities = components
    .filter(c => c.kind === 'capability')
    .map(c => ({
      id: c.id,
      module: c.entry?.module || `./${c.id}.mjs`,
      export: c.entry?.export || `${c.id}Capability`,
      version: c.version,
      title: c.title,
      description: c.description
    }))
  
  return {
    version: 1,
    baseUrl,
    capabilities
  }
}

/**
 * 生成 capabilities.loader.mjs
 */
function generateLoader(manifest, options = {}) {
  const { 
    useTopLevelAwait = true,
    manifestPath = './capabilities.manifest.json'
  } = options
  
  const lines = [
    '/**',
    ' * 由 dsh-assembly-kit 生成的能力加载器',
    ' * 不要手动编辑此文件',
    ' */',
    '',
    "import manifest from './capabilities.manifest.json' assert { type: 'json' }",
    '',
    'const HERE = new URL(\'.\', import.meta.url)',
    '',
    '/**',
    ' * 动态加载所有能力模块',
    ' */',
    'export async function loadCapabilities() {',
    '  const capabilities = []',
    '  ',
    '  for (const entry of manifest.capabilities) {',
    '    const moduleUrl = new URL(entry.module, HERE)',
    '    const mod = await import(moduleUrl.href)',
    '    const capability = mod[entry.export]',
    '    ',
    '    if (!capability) {',
    '      throw new Error(',
    '        `模块 ${entry.module} 不导出 ${entry.export}. ` +',
    '        `可用导出: ${Object.keys(mod).join(\', \')}`',
    '      )',
    '    }',
    '    ',
    '    capabilities.push(capability)',
    '  }',
    '  ',
    '  return capabilities',
    '}',
    ''
  ]
  
  if (useTopLevelAwait) {
    lines.push(
      '/**',
      ' * 预加载的能力列表（使用 top-level await）',
      ' */',
      'export const CAPABILITIES = await loadCapabilities()',
      ''
    )
  } else {
    lines.push(
      '/**',
      ' * CAPABILITIES 需要异步加载',
      ' * 使用: const CAPABILITIES = await loadCapabilities()',
      ' */',
      ''
    )
  }
  
  return lines.join('\n')
}

/**
 * 生成 registry target 产物
 */
export async function emitRegistry(resolved, options = {}) {
  const {
    outDir,
    manifestPath = 'capabilities.manifest.json',
    loaderPath = 'capabilities.loader.mjs',
    baseUrl = './',
    useTopLevelAwait = true
  } = options
  
  if (!outDir) {
    throw new Error('emitRegistry 需要 outDir')
  }
  
  const absOut = path.resolve(outDir)
  fs.mkdirSync(absOut, { recursive: true })
  
  // 只选择 capability 类型的组件
  const capabilities = resolved.components.filter(c => c.kind === 'capability')
  
  if (capabilities.length === 0) {
    throw new Error('没有 capability 组件可生成')
  }
  
  // 生成 manifest
  const manifest = generateManifest(capabilities, { baseUrl })
  const manifestFile = path.join(absOut, manifestPath)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  
  // 生成 loader
  const loader = generateLoader(manifest, { useTopLevelAwait, manifestPath })
  const loaderFile = path.join(absOut, loaderPath)
  fs.writeFileSync(loaderFile, loader)
  
  return {
    target: 'registry',
    outDir: absOut,
    files: {
      manifest: manifestFile,
      loader: loaderFile
    },
    capabilities: capabilities.map(c => c.id)
  }
}

/**
 * 验证生成的 registry（尝试动态加载）
 */
export async function verifyRegistry(outDir, options = {}) {
  const {
    loaderPath = 'capabilities.loader.mjs'
  } = options
  
  const absOut = path.resolve(outDir)
  const loaderFile = path.join(absOut, loaderPath)
  
  if (!fs.existsSync(loaderFile)) {
    throw new Error(`loader 文件不存在: ${loaderFile}`)
  }
  
  try {
    // 动态导入 loader
    const { fileURLToPath } = await import('node:url')
    const loaderUrl = `file://${loaderFile.replace(/\\/g, '/')}`
    const mod = await import(loaderUrl)
    
    if (!mod.CAPABILITIES) {
      throw new Error('loader 未导出 CAPABILITIES')
    }
    
    if (!Array.isArray(mod.CAPABILITIES)) {
      throw new Error('CAPABILITIES 不是数组')
    }
    
    // 验证每个 capability 的形状
    for (const cap of mod.CAPABILITIES) {
      if (!cap.id || typeof cap.id !== 'string') {
        throw new Error(`capability 缺少有效的 id: ${JSON.stringify(cap)}`)
      }
      if (!Array.isArray(cap.tools) || cap.tools.length === 0) {
        throw new Error(`capability ${cap.id} 缺少 tools`)
      }
    }
    
    return {
      ok: true,
      count: mod.CAPABILITIES.length,
      capabilities: mod.CAPABILITIES.map(c => c.id)
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      stack: error.stack
    }
  }
}

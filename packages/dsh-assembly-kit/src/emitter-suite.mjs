/**
 * 生成 suite bundle 产物：dsh-suite.json + cordis.patch.yml
 */
import fs from 'node:fs'
import path from 'node:path'
import { renderCordisPatch } from 'dsh-suite-kit'

/**
 * 从组件列表生成 suite manifest
 */
function generateSuiteManifest(productManifest, components, options = {}) {
  const {
    suiteName = `${productManifest.name}-suite`,
    baseDir = '.'
  } = options
  
  const packages = {}
  const rows = []
  const checks = []
  
  for (const component of components) {
    if (component.kind === 'capability') {
      // capability 组件不直接生成 package/row，它们属于某个 plugin
      continue
    }
    
    if (component.kind === 'library') {
      // 纯库作为 support 角色
      packages[component.id] = {
        role: 'support',
        version: component.version,
        path: path.relative(baseDir, component.source.package || `./${component.id}`)
      }
      continue
    }
    
    // plugin 或 skill
    const pkg = {
      role: component.kind === 'skill' ? 'skills' : 'runtime',
      version: component.version,
      path: path.relative(baseDir, component.source.package || `./${component.id}`)
    }
    
    if (component.provides) {
      pkg.provides = component.provides
    }
    
    if (component.requires && component.requires.length > 0) {
      pkg.requires = {}
      for (const req of component.requires) {
        pkg.requires[req] = '*'
      }
    }
    
    packages[component.id] = pkg
    
    // 生成 row（假设 row id 为 <id>-host 或直接用 id）
    const rowId = component.id.endsWith('-host') ? component.id : `${component.id}-host`
    rows.push({
      id: rowId,
      name: component.id
    })
  }
  
  // 合并额外的 rows 和 checks
  const extraRows = productManifest.bundle?.rows || []
  const extraChecks = productManifest.bundle?.checks || []
  
  return {
    name: suiteName,
    version: productManifest.version,
    title: productManifest.title || suiteName,
    description: productManifest.description || `${productManifest.title || suiteName} 组合套件`,
    packages,
    rows: [...rows, ...extraRows],
    checks: [...checks, ...extraChecks]
  }
}

/**
 * 生成 bundle target 产物
 */
export async function emitBundle(resolved, productManifest, options = {}) {
  const {
    outDir,
    suiteName = `${productManifest.name}-suite`,
    baseDir = '.'
  } = options
  
  if (!outDir) {
    throw new Error('emitBundle 需要 outDir')
  }
  
  const absOut = path.resolve(outDir)
  fs.mkdirSync(absOut, { recursive: true })
  
  // 生成 suite manifest
  const suiteManifest = generateSuiteManifest(productManifest, resolved.components, {
    suiteName,
    baseDir
  })
  
  const suiteFile = path.join(absOut, 'dsh-suite.json')
  fs.writeFileSync(suiteFile, JSON.stringify(suiteManifest, null, 2) + '\n')
  
  // 生成 cordis.patch.yml
  const patch = renderCordisPatch(suiteManifest.rows, { header: true })
  const patchFile = path.join(absOut, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, patch)
  
  return {
    target: 'bundle',
    outDir: absOut,
    files: {
      suite: suiteFile,
      patch: patchFile
    },
    suiteName,
    packages: Object.keys(suiteManifest.packages),
    rows: suiteManifest.rows.length
  }
}

/**
 * 验证生成的 suite
 */
export async function verifyBundle(outDir) {
  const absOut = path.resolve(outDir)
  const suiteFile = path.join(absOut, 'dsh-suite.json')
  
  if (!fs.existsSync(suiteFile)) {
    throw new Error(`suite 文件不存在: ${suiteFile}`)
  }
  
  try {
    const manifest = JSON.parse(fs.readFileSync(suiteFile, 'utf8'))
    
    // 基本结构验证
    if (!manifest.name || !manifest.version) {
      throw new Error('suite manifest 缺少 name 或 version')
    }
    
    if (!manifest.packages || typeof manifest.packages !== 'object') {
      throw new Error('suite manifest 缺少 packages')
    }
    
    if (!Array.isArray(manifest.rows)) {
      throw new Error('suite manifest 的 rows 必须是数组')
    }
    
    return {
      ok: true,
      suite: manifest.name,
      version: manifest.version,
      packages: Object.keys(manifest.packages).length,
      rows: manifest.rows.length
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message
    }
  }
}

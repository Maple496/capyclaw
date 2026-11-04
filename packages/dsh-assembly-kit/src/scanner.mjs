/**
 * 扫描工作区，生成组件库索引。
 * 
 * 扫描来源：
 * 1. dsh-suite.json - plugin 组件
 * 2. package.json.dsh.capabilities - capability 组件
 * 3. bridges plugin dsh-suite.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadSuiteManifest } from 'dsh-suite-kit'

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function findFiles(dir, pattern, options = {}) {
  const { exclude = [], maxDepth = 10 } = options
  const results = []
  
  function walk(current, depth) {
    if (depth > maxDepth) return
    if (!fs.existsSync(current)) return
    
    const stat = fs.statSync(current)
    if (!stat.isDirectory()) return
    
    const base = path.basename(current)
    if (exclude.includes(base)) return
    
    const entries = fs.readdirSync(current)
    
    for (const entry of entries) {
      const fullPath = path.join(current, entry)
      const stat = fs.statSync(fullPath)
      
      if (stat.isDirectory()) {
        walk(fullPath, depth + 1)
      } else if (stat.isFile() && entry === pattern) {
        results.push(fullPath)
      }
    }
  }
  
  walk(dir, 0)
  return results
}

/**
 * 从 suite manifest 提取 plugin 组件
 */
function extractPluginComponents(suiteFile, workspaceRoot) {
  try {
    const loaded = loadSuiteManifest(path.dirname(suiteFile))
    const manifest = loaded.manifest
    const components = []
    
    for (const [name, entry] of Object.entries(manifest.packages || {})) {
      if (entry.role === 'support') continue  // 纯库，单独处理
      
      const component = {
        id: name,
        name,
        version: entry.version?.replace(/^[^0-9]*/, '') || '0.0.0',
        kind: entry.role === 'skills' ? 'skill' : 'plugin',
        title: manifest.title || name,
        description: manifest.description || '',
        tags: manifest.tags || [],
        provides: entry.provides || {},
        requires: Object.keys(entry.requires || {}),
        dependsOn: [],
        source: {
          workspace: workspaceRoot,
          package: path.relative(workspaceRoot, path.dirname(suiteFile)),
          suite: path.relative(workspaceRoot, suiteFile)
        }
      }
      
      // 转换 requires.capabilities 到 dependsOn
      if (entry.requires?.capabilities) {
        for (const cap of Object.keys(entry.requires.capabilities)) {
          component.dependsOn.push(cap)
        }
      }
      
      components.push(component)
    }
    
    return components
  } catch (error) {
    console.warn(`[scanner] 跳过无效 suite: ${suiteFile} - ${error.message}`)
    return []
  }
}

/**
 * 从 package.json.dsh.capabilities 提取 capability 组件
 */
function extractCapabilityComponents(packageDir, workspaceRoot) {
  const packageJson = readJsonSafe(path.join(packageDir, 'package.json'))
  if (!packageJson?.dsh?.capabilities) return []
  
  const capConfig = packageJson.dsh.capabilities
  const manifestFile = path.join(packageDir, capConfig.manifest || 'capabilities.json')
  const capManifest = readJsonSafe(manifestFile)
  
  if (!capManifest?.capabilities) {
    console.warn(`[scanner] ${packageJson.name}: dsh.capabilities 声明了 manifest 但文件不存在或格式错误: ${manifestFile}`)
    return []
  }
  
  return capManifest.capabilities.map((cap) => ({
    id: cap.id,
    name: `${packageJson.name}-${cap.id}`,
    version: cap.version || packageJson.version || '0.0.0',
    kind: 'capability',
    title: cap.title || cap.id,
    description: cap.description || '',
    tags: cap.tags || [],
    keywords: cap.keywords || [],
    entry: cap.entry || {},
    provides: cap.provides || {},
    requires: cap.requires || [],
    dependsOn: cap.dependsOn || [],
    source: {
      workspace: workspaceRoot,
      package: path.relative(workspaceRoot, packageDir),
      file: cap.entry?.module || ''
    }
  }))
}

/**
 * 扫描工作区，生成组件库索引
 */
export async function scan(workspaceRoot, options = {}) {
  const {
    include = ['packages/*', 'bridges/*/plugin/*', 'plugin-development/examples/*/plugin/*'],
    exclude = ['node_modules', 'dist', 'archives', 'bundles', '.git', '.tmp*'],
    cache = false,
    cacheFile = '.assembly-cache.json'
  } = options
  
  const absRoot = path.resolve(workspaceRoot)
  const cacheP = path.join(absRoot, cacheFile)
  
  // 检查缓存
  if (cache && fs.existsSync(cacheP)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheP, 'utf8'))
      const age = Date.now() - cached.timestamp
      if (age < 60000) {  // 1分钟内的缓存有效
        return cached.library
      }
    } catch {
      // 忽略缓存错误
    }
  }
  
  const allComponents = []
  
  // 1. 扫描 dsh-suite.json (plugin/skill 组件)
  const suiteFiles = findFiles(absRoot, 'dsh-suite.json', { exclude, maxDepth: 6 })
  for (const file of suiteFiles) {
    const components = extractPluginComponents(file, absRoot)
    allComponents.push(...components)
  }
  
  // 2. 扫描 capabilities (从 package.json.dsh.capabilities 入口)
  const packageFiles = findFiles(absRoot, 'package.json', { exclude, maxDepth: 6 })
  for (const file of packageFiles) {
    const dir = path.dirname(file)
    const components = extractCapabilityComponents(dir, absRoot)
    allComponents.push(...components)
  }
  
  // 去重（同一个 id 可能被多次扫描）
  const componentMap = new Map()
  for (const comp of allComponents) {
    const key = `${comp.kind}:${comp.id}`
    if (!componentMap.has(key)) {
      componentMap.set(key, comp)
    }
  }
  
  const library = {
    version: 1,
    workspace: absRoot,
    timestamp: Date.now(),
    components: Array.from(componentMap.values()).sort((a, b) => a.id.localeCompare(b.id))
  }
  
  // 写缓存
  if (cache) {
    try {
      fs.writeFileSync(cacheP, JSON.stringify({ timestamp: Date.now(), library }, null, 2))
    } catch {
      // 忽略写缓存错误
    }
  }
  
  return library
}

/**
 * 从指定的工作区列表扫描并合并
 */
export async function scanMultiple(workspaces, options = {}) {
  const allComponents = []
  
  for (const ws of workspaces) {
    const lib = await scan(ws, options)
    allComponents.push(...lib.components)
  }
  
  // 去重合并
  const componentMap = new Map()
  for (const comp of allComponents) {
    const key = `${comp.kind}:${comp.id}`
    if (!componentMap.has(key)) {
      componentMap.set(key, comp)
    }
  }
  
  return {
    version: 1,
    workspaces,
    timestamp: Date.now(),
    components: Array.from(componentMap.values()).sort((a, b) => a.id.localeCompare(b.id))
  }
}

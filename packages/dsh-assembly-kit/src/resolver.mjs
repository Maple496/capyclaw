/**
 * 依赖解析和冲突检测
 */
import { findById, findByIds } from './catalog.mjs'

/**
 * 展开 dependsOn 传递闭包
 */
function expandDependencies(componentIds, library) {
  const selected = new Set(componentIds)
  const queue = [...componentIds]
  const visited = new Set()
  
  while (queue.length > 0) {
    const id = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)
    
    const component = findById(id, library)
    if (!component) continue
    
    for (const dep of component.dependsOn || []) {
      if (!selected.has(dep)) {
        selected.add(dep)
        queue.push(dep)
      }
    }
  }
  
  return Array.from(selected)
}

/**
 * 检测工具名冲突
 */
function detectToolConflicts(components) {
  const conflicts = []
  const toolMap = new Map()
  
  for (const component of components) {
    for (const tool of component.provides?.tools || []) {
      // 通配符工具不做精确冲突检测，只记录
      if (tool.includes('*')) continue
      
      const existing = toolMap.get(tool)
      if (existing) {
        conflicts.push({
          type: 'tool',
          tool,
          components: [existing, component.id]
        })
      } else {
        toolMap.set(tool, component.id)
      }
    }
  }
  
  // 检测通配符工具重叠
  const wildcardOwners = components.filter(c => 
    (c.provides?.tools || []).some(t => t.includes('*'))
  )
  if (wildcardOwners.length > 1) {
    conflicts.push({
      type: 'wildcard-tools',
      components: wildcardOwners.map(c => c.id),
      message: '多个组件声明通配工具面，可能重叠'
    })
  }
  
  return conflicts
}

/**
 * 检测端口冲突
 */
function detectPortConflicts(components) {
  const conflicts = []
  const portMap = new Map()
  
  for (const component of components) {
    for (const port of component.provides?.ports || []) {
      const existing = portMap.get(port)
      if (existing) {
        conflicts.push({
          type: 'port',
          port,
          components: [existing, component.id]
        })
      } else {
        portMap.set(port, component.id)
      }
    }
  }
  
  return conflicts
}

/**
 * 检测服务命名空间冲突
 */
function detectServiceConflicts(components) {
  const conflicts = []
  const serviceMap = new Map()
  
  for (const component of components) {
    for (const service of component.provides?.services || []) {
      const existing = serviceMap.get(service)
      if (existing) {
        conflicts.push({
          type: 'service',
          service,
          components: [existing, component.id]
        })
      } else {
        serviceMap.set(service, component.id)
      }
    }
  }
  
  return conflicts
}

/**
 * 检测能力版本冲突
 */
function detectCapabilityConflicts(components) {
  const conflicts = []
  const capMap = new Map()
  
  for (const component of components) {
    for (const [cap, version] of Object.entries(component.provides?.capabilities || {})) {
      const existing = capMap.get(cap)
      if (existing) {
        // 简化版本比较：只比较 major
        const majorA = version.split('.')[0]
        const majorB = existing.version.split('.')[0]
        if (majorA !== majorB) {
          conflicts.push({
            type: 'capability-version',
            capability: cap,
            components: [
              { id: existing.component, version: existing.version },
              { id: component.id, version }
            ]
          })
        }
      } else {
        capMap.set(cap, { component: component.id, version })
      }
    }
  }
  
  return conflicts
}

/**
 * 验证 requires 能否满足
 */
function validateRequires(components) {
  const errors = []
  const warnings = []
  
  // 收集所有可用的端口/服务
  const availablePorts = new Set()
  const availableServices = new Set()
  const availableCapabilities = new Map()
  
  for (const component of components) {
    // 假设 plugin 组件提供的服务名与 id 相关
    if (component.kind === 'plugin') {
      // 从 provides.services 提取
      for (const service of component.provides?.services || []) {
        availableServices.add(service)
      }
    }
    
    // capability 的 requires 是端口名（如 'deck', 'status'）
    // 这些端口由 kernel 或其他 capability 的 provides 提供
    
    for (const [cap, version] of Object.entries(component.provides?.capabilities || {})) {
      availableCapabilities.set(cap, { component: component.id, version })
    }
  }
  
  // 检查每个组件的 requires
  for (const component of components) {
    for (const req of component.requires || []) {
      // 端口名通常是小写简短词（deck, status, assets）
      // 服务名通常是驼峰或带连字符（serviceHost, ppt-workbench）
      // 简单判断：如果不在 availableServices，则可能是端口（由内核提供或其他组件）
      if (!availableServices.has(req)) {
        warnings.push({
          type: 'missing-port',
          component: component.id,
          required: req,
          message: `需要端口/服务 "${req}"，可能由内核或外部提供`
        })
      }
    }
    
    // 检查 dependsOn 的组件是否在选中列表中
    for (const dep of component.dependsOn || []) {
      const depComponent = components.find(c => c.id === dep)
      if (!depComponent) {
        errors.push({
          type: 'missing-dependency',
          component: component.id,
          required: dep,
          message: `依赖组件 "${dep}" 未选中`
        })
      }
    }
  }
  
  return { errors, warnings }
}

/**
 * 解析产品清单
 */
export function resolve(productManifest, library, options = {}) {
  const { strict = false } = options
  
  if (!productManifest || !library) {
    throw new Error('resolve 需要 productManifest 和 library')
  }
  
  const select = productManifest.select || {}
  const exclude = new Set(productManifest.exclude || [])
  
  let selectedIds = []
  
  // 选择组件
  if (select.all) {
    selectedIds = library.components
      .filter(c => !exclude.has(c.id))
      .map(c => c.id)
  } else {
    selectedIds = [
      ...(select.capabilities || []),
      ...(select.packages || [])
    ].filter(id => !exclude.has(id))
  }
  
  // 展开依赖
  const expandedIds = expandDependencies(selectedIds, library)
  const components = findByIds(expandedIds, library)
  
  // 冲突检测
  const conflicts = [
    ...detectToolConflicts(components),
    ...detectPortConflicts(components),
    ...detectServiceConflicts(components),
    ...detectCapabilityConflicts(components)
  ]
  
  // 依赖验证
  const { errors, warnings } = validateRequires(components)
  
  const allErrors = [...errors]
  if (conflicts.length > 0) {
    allErrors.push(...conflicts.map(c => ({ ...c, severity: 'conflict' })))
  }
  
  const result = {
    ok: allErrors.length === 0,
    components,
    selected: selectedIds,
    expanded: expandedIds,
    conflicts,
    errors: allErrors,
    warnings
  }
  
  if (strict && !result.ok) {
    const msg = allErrors.map(e => 
      `${e.type}: ${e.message || JSON.stringify(e)}`
    ).join('\n')
    throw new Error(`依赖解析失败:\n${msg}`)
  }
  
  return result
}

/**
 * 按拓扑顺序排序组件（依赖的在前）
 */
export function topologicalSort(components) {
  const sorted = []
  const visited = new Set()
  const visiting = new Set()
  
  function visit(component) {
    if (visited.has(component.id)) return
    if (visiting.has(component.id)) {
      throw new Error(`检测到循环依赖: ${component.id}`)
    }
    
    visiting.add(component.id)
    
    for (const depId of component.dependsOn || []) {
      const dep = components.find(c => c.id === depId)
      if (dep) visit(dep)
    }
    
    visiting.delete(component.id)
    visited.add(component.id)
    sorted.push(component)
  }
  
  for (const component of components) {
    visit(component)
  }
  
  return sorted
}

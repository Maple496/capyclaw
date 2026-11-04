/**
 * 组件搜索和过滤
 */

/**
 * 模糊匹配
 */
function fuzzyMatch(text, query) {
  if (!text || !query) return false
  const t = String(text).toLowerCase()
  const q = String(query).toLowerCase()
  return t.includes(q)
}

/**
 * 精确匹配（支持通配符）
 */
function exactMatch(text, pattern) {
  if (!text || !pattern) return false
  const t = String(text).toLowerCase()
  const p = String(pattern).toLowerCase()
  
  if (p.includes('*')) {
    const regex = new RegExp('^' + p.replace(/\*/g, '.*') + '$')
    return regex.test(t)
  }
  
  return t === p
}

/**
 * 检查组件是否匹配查询
 */
function matchesQuery(component, query, options = {}) {
  const {
    fields = ['id', 'name', 'title', 'description', 'tags', 'keywords'],
    fuzzy = true
  } = options
  
  const matcher = fuzzy ? fuzzyMatch : exactMatch
  const q = String(query).toLowerCase()
  
  for (const field of fields) {
    const value = component[field]
    
    if (typeof value === 'string') {
      if (matcher(value, q)) return true
    } else if (Array.isArray(value)) {
      if (value.some(item => matcher(item, q))) return true
    }
  }
  
  return false
}

/**
 * 检查组件的 provides 是否匹配
 */
function matchesProvides(component, providesQuery) {
  const provides = component.provides || {}
  
  for (const [key, pattern] of Object.entries(providesQuery)) {
    const values = provides[key]
    if (!values) return false
    
    if (typeof pattern === 'string') {
      // 单个模式
      if (Array.isArray(values)) {
        if (!values.some(v => exactMatch(v, pattern))) return false
      } else if (typeof values === 'object') {
        if (!Object.keys(values).some(k => exactMatch(k, pattern))) return false
      }
    } else if (Array.isArray(pattern)) {
      // 多个模式，至少匹配一个
      const matched = pattern.some(p => {
        if (Array.isArray(values)) {
          return values.some(v => exactMatch(v, p))
        } else if (typeof values === 'object') {
          return Object.keys(values).some(k => exactMatch(k, p))
        }
        return false
      })
      if (!matched) return false
    }
  }
  
  return true
}

/**
 * 搜索组件
 */
export function search(query, library, options = {}) {
  const {
    kind = null,      // 过滤 kind: 'plugin' | 'capability' | 'skill' | 'library' | ['plugin', 'capability']
    provides = null,  // 过滤 provides: { tools: 'ppt_*', services: 'serviceHost' }
    tags = null,      // 过滤 tags: ['read'] 或 'read'
    fields = ['id', 'name', 'title', 'description', 'tags', 'keywords'],
    fuzzy = true,
    limit = 100
  } = options
  
  if (!library || !library.components) return []
  
  let results = library.components
  
  // 过滤 kind
  if (kind) {
    const kinds = Array.isArray(kind) ? kind : [kind]
    results = results.filter(c => kinds.includes(c.kind))
  }
  
  // 过滤 tags
  if (tags) {
    const tagList = Array.isArray(tags) ? tags : [tags]
    results = results.filter(c => {
      const componentTags = c.tags || []
      return tagList.some(tag => componentTags.includes(tag))
    })
  }
  
  // 过滤 provides
  if (provides) {
    results = results.filter(c => matchesProvides(c, provides))
  }
  
  // 文本查询
  if (query && query.trim()) {
    results = results.filter(c => matchesQuery(c, query, { fields, fuzzy }))
  }
  
  // 限制结果数量
  if (limit > 0) {
    results = results.slice(0, limit)
  }
  
  return results
}

/**
 * 按 id 查找组件
 */
export function findById(id, library) {
  if (!library || !library.components) return null
  return library.components.find(c => c.id === id) || null
}

/**
 * 按 ids 批量查找组件
 */
export function findByIds(ids, library) {
  if (!library || !library.components || !Array.isArray(ids)) return []
  const idSet = new Set(ids)
  return library.components.filter(c => idSet.has(c.id))
}

/**
 * 按 kind 过滤
 */
export function filterByKind(kind, library) {
  if (!library || !library.components) return []
  const kinds = Array.isArray(kind) ? kind : [kind]
  return library.components.filter(c => kinds.includes(c.kind))
}

/**
 * 列出所有可用的 tags
 */
export function listTags(library) {
  if (!library || !library.components) return []
  const tagSet = new Set()
  
  for (const component of library.components) {
    for (const tag of component.tags || []) {
      tagSet.add(tag)
    }
  }
  
  return Array.from(tagSet).sort()
}

/**
 * 列出所有可用的 tools
 */
export function listTools(library) {
  if (!library || !library.components) return []
  const toolSet = new Set()
  
  for (const component of library.components) {
    for (const tool of component.provides?.tools || []) {
      toolSet.add(tool)
    }
  }
  
  return Array.from(toolSet).sort()
}

/**
 * 列出所有可用的 services
 */
export function listServices(library) {
  if (!library || !library.components) return []
  const serviceSet = new Set()
  
  for (const component of library.components) {
    for (const service of component.provides?.services || []) {
      serviceSet.add(service)
    }
  }
  
  return Array.from(serviceSet).sort()
}

/**
 * 列出所有可用的 capabilities
 */
export function listCapabilities(library) {
  if (!library || !library.components) return []
  const capMap = new Map()
  
  for (const component of library.components) {
    for (const [cap, version] of Object.entries(component.provides?.capabilities || {})) {
      if (!capMap.has(cap)) {
        capMap.set(cap, { capability: cap, providers: [] })
      }
      capMap.get(cap).providers.push({ component: component.id, version })
    }
  }
  
  return Array.from(capMap.values())
}

/**
 * 统计信息
 */
export function stats(library) {
  if (!library || !library.components) {
    return { total: 0, byKind: {}, tools: 0, services: 0, capabilities: 0 }
  }
  
  const byKind = {}
  const toolSet = new Set()
  const serviceSet = new Set()
  const capSet = new Set()
  
  for (const component of library.components) {
    byKind[component.kind] = (byKind[component.kind] || 0) + 1
    
    for (const tool of component.provides?.tools || []) {
      toolSet.add(tool)
    }
    for (const service of component.provides?.services || []) {
      serviceSet.add(service)
    }
    for (const cap of Object.keys(component.provides?.capabilities || {})) {
      capSet.add(cap)
    }
  }
  
  return {
    total: library.components.length,
    byKind,
    tools: toolSet.size,
    services: serviceSet.size,
    capabilities: capSet.size
  }
}

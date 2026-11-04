/**
 * dsh-tool-host —— 工具面标准件。
 *
 * 把“能力声明 → 注册表 → 工具 schema/实现 → 契约报告 → MCP 协议壳”收成一套：
 *   defineTool / defineCapability / createRegistry / createMcpHandler /
 *   createCapabilityReport / buildInstructions
 *
 * 功能插件只写业务能力，不再复制 kernel/registry/dispatch/validate/contract。
 */
import { createMcpHandler as createKitMcpHandler } from './kit/service/mcp-http.mjs'
import { validateToolArguments } from './kit/tools/validate.mjs'
import { createServiceApi } from './kit/service/api.mjs'

const KINDS = new Set(['read', 'write', 'control'])

export function defineTool({
  name,
  description = '',
  inputSchema = { type: 'object', properties: {}, additionalProperties: false },
  kind = 'write',
  since = '1.0.0',
  handler,
} = {}) {
  if (!name || typeof name !== 'string') throw new Error('defineTool 需要 name')
  if (typeof handler !== 'function') throw new Error(`工具 ${name} 需要 handler`)
  if (!KINDS.has(kind)) throw new Error(`工具 ${name} 的 kind 非法: ${kind}`)
  return Object.freeze({ name, description, inputSchema, kind, since, handler })
}

export function defineCapability({
  id,
  title,
  description = '',
  tags = [],
  requires = [],
  dependsOn = [],
  provides = {},
  features = [],
  tools = [],
} = {}) {
  if (!id || typeof id !== 'string') throw new Error('defineCapability 需要 id')
  if (!Array.isArray(tools) || !tools.length) throw new Error(`能力 ${id} 至少需要一个工具`)
  return Object.freeze({
    id,
    title: title || id,
    description,
    tags: Object.freeze([...tags]),
    requires: Object.freeze([...requires]),
    dependsOn: Object.freeze([...dependsOn]),
    provides: Object.freeze({ ...provides }),
    features: Object.freeze([...features]),
    tools: Object.freeze([...tools]),
  })
}

function validateCapabilities(capabilities) {
  const ids = new Set()
  const toolNames = new Set()
  for (const cap of capabilities) {
    if (ids.has(cap.id)) throw new Error(`重复的 capability id: ${cap.id}`)
    ids.add(cap.id)
    for (const tool of cap.tools) {
      if (toolNames.has(tool.name)) throw new Error(`重复的工具名: ${tool.name}`)
      toolNames.add(tool.name)
    }
  }
  for (const cap of capabilities) {
    for (const dep of cap.dependsOn) {
      if (!ids.has(dep)) throw new Error(`能力 ${cap.id} 依赖不存在的能力: ${dep}`)
    }
  }
}

function selectCapabilities(capabilities, enabled) {
  if (!enabled || !enabled.length) return capabilities
  const byId = new Map(capabilities.map((cap) => [cap.id, cap]))
  for (const id of enabled) {
    if (!byId.has(id)) throw new Error(`enabled 里有未知能力: ${id}`)
  }
  const ids = new Set(enabled)
  let changed = true
  while (changed) {
    changed = false
    for (const cap of capabilities) {
      if (!ids.has(cap.id)) continue
      for (const dep of cap.dependsOn) {
        if (!ids.has(dep)) { ids.add(dep); changed = true }
      }
    }
  }
  return capabilities.filter((cap) => ids.has(cap.id))
}

/**
 * @param {Array} capabilities
 * @param {{ enabled?: string[], ports?: object, report?: Function, reserved?: string[] }} options
 */
export function createRegistry(capabilities, { enabled = null, ports = null, report = null, reserved = [] } = {}) {
  validateCapabilities(capabilities)
  const selected = selectCapabilities(capabilities, enabled)

  const kernelPorts = { ...(ports || {}) }
  const reservedNames = new Set([...(reserved || []), 'contract'])
  const providers = new Map()
  for (const cap of selected) {
    for (const [ns, api] of Object.entries(cap.provides || {})) {
      if (reservedNames.has(ns)) throw new Error(`能力 ${cap.id} 不能覆盖内核端口: ${ns}`)
      if (providers.has(ns)) throw new Error(`服务命名空间重复: ${ns}（${providers.get(ns).cap.id} / ${cap.id}）`)
      providers.set(ns, { cap, api })
    }
  }

  const available = new Set([...Object.keys(kernelPorts), ...reservedNames, ...providers.keys()])
  for (const cap of selected) {
    for (const req of cap.requires) {
      if (!available.has(req)) throw new Error(`能力 ${cap.id} 需要未提供的端口/服务: ${req}`)
    }
  }

  const ctx = { ...kernelPorts }
  for (const [ns, { api }] of providers) {
    ctx[ns] = {}
    for (const [method, fn] of Object.entries(api)) {
      if (typeof fn !== 'function') throw new Error(`服务 ${ns}.${method} 必须是函数`)
      ctx[ns][method] = (...args) => fn(ctx, ...args)
    }
  }

  const TOOLS = []
  const TOOL_IMPL = {}
  const TOOL_META = {}
  const FEATURES = []
  const CAPABILITIES = []

  for (const cap of selected) {
    for (const feature of cap.features) {
      if (!FEATURES.includes(feature)) FEATURES.push(feature)
    }
    CAPABILITIES.push({
      id: cap.id,
      title: cap.title,
      description: cap.description,
      tags: [...cap.tags],
      tools: cap.tools.map((tool) => tool.name),
    })
    for (const tool of cap.tools) {
      TOOLS.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
      TOOL_META[tool.name] = { kind: tool.kind, since: tool.since, capability: cap.id }
      TOOL_IMPL[tool.name] = (args) => tool.handler(args || {}, ctx)
    }
  }

  const reportFn = report || createCapabilityReport
  ctx.contract = {
    report: (editorUrl = '', runtime = {}) => reportFn({
      tools: TOOLS,
      toolMeta: TOOL_META,
      features: FEATURES,
      capabilities: CAPABILITIES,
      editorUrl,
      runtime,
    }),
  }

  return { TOOLS, TOOL_IMPL, TOOL_META, FEATURES, CAPABILITIES, ctx }
}

/** 与 MCP 工具面解耦：调用前统一校验。 */
export function createToolDispatcher({ tools, callTool }) {
  const toolMap = new Map((tools || []).map((tool) => [tool.name, tool]))
  return {
    listTools() {
      return { tools }
    },
    async callTool(name, args = {}) {
      const tool = toolMap.get(name)
      if (!tool) {
        return { content: [{ type: 'text', text: `未知工具: ${String(name)}` }], isError: true }
      }
      const check = validateToolArguments(tool, args)
      if (!check.ok) {
        return { content: [{ type: 'text', text: '参数不合法：' + check.errors.join('；') }], isError: true }
      }
      const out = await callTool(name, args)
      if (out && out.content) return out
      return { content: [{ type: 'text', text: out?.text || 'ok' }] }
    },
  }
}

/**
 * MCP Streamable HTTP 处理器。registry 可直接传 createRegistry 的返回值。
 * 兼容两种调用：
 *   { registry } 或 { tools, toolImpl }
 *   { tools, callTool }（旧 relay 形态）
 * @param {{ registry?: object, tools?: Array, toolImpl?: object, callTool?: Function, serverInfo?: object, instructions?: string }} options
 */
export function createMcpHandler({ registry, tools, toolImpl, callTool, serverInfo, instructions } = {}) {
  const list = tools || registry?.TOOLS || []
  const impl = toolImpl || registry?.TOOL_IMPL || null
  if (!Array.isArray(list) || !list.length) throw new Error('createMcpHandler: 没有工具可暴露')
  if (!impl && typeof callTool !== 'function') throw new Error('createMcpHandler: 需要 toolImpl 或 callTool')
  return createKitMcpHandler({
    tools: list,
    callTool: (name, args, context) => {
      if (typeof callTool === 'function' && !impl) return callTool(name, args, context)
      const fn = impl[name]
      if (!fn) throw new Error(`未知工具: ${name}`)
      return fn(args, context)
    },
    serverInfo: serverInfo || { name: 'dsh-tool-host', version: '0.1.0' },
    instructions,
  })
}

export function createCapabilityReport({
  tools = [],
  toolMeta = {},
  features = [],
  capabilities = [],
  contractVersion = '1.0.0',
  packageVersion = '0.0.0',
  editorUrl = '',
  runtime = {},
} = {}) {
  return {
    contractVersion,
    packageVersion,
    editorUrl,
    ...runtime,
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      kind: toolMeta[tool.name]?.kind ?? 'write',
      since: toolMeta[tool.name]?.since ?? '1.0.0',
      capability: toolMeta[tool.name]?.capability ?? '',
    })),
    features,
    capabilities: capabilities.map((cap) => ({
      id: cap.id,
      title: cap.title,
      description: cap.description || '',
      tags: cap.tags || [],
      tools: cap.tools || [],
    })),
  }
}

/**
 * 生成 MCP server instructions（≤32KB）。业务只提供数据，不再手写排版。
 */
export function buildInstructions({
  title = '',
  intro = '',
  startup = [],
  capabilities = [],
  tools = [],
  rules = [],
  output = [],
} = {}) {
  const rows = capabilities.length
    ? capabilities.map((cap) => `| ${cap.title} | ${cap.tools.map((name) => `\`${name}\``).join(', ')} | ${cap.description || ''} |`)
    : [{
      title: '工具',
      tools: tools.map((tool) => tool.name),
      description: '',
    }].map((cap) => `| ${cap.title} | ${cap.tools.map((name) => `\`${name}\``).join(', ')} | |`)

  const lines = []
  if (title) lines.push(`# ${title}`, '')
  if (intro) lines.push(intro, '')
  if (startup.length) {
    lines.push('## 启动检查')
    startup.forEach((line, index) => lines.push(`${index + 1}. ${line}`))
    lines.push('')
  }
  lines.push('## 能力面', '| 能力 | 工具 | 用途 |', '|---|---|---|', ...rows, '')
  if (rules.length) {
    lines.push('## 硬规则')
    rules.forEach((line) => lines.push(`- ${line}`))
    lines.push('')
  }
  if (output.length) {
    lines.push('## 输出')
    output.forEach((line) => lines.push(`- ${line}`))
  }
  return lines.join('\n')
}

/**
 * 把能力注册表直接注册到 DSH 的 ctx.tools（同进程原生工具面）。
 * 注册后不再需要单独的 loopback /mcp 端口和 @deepseek-ai/dsh-mcp-client row。
 * @param {object} ctx DSH cordis context
 * @param {object} registry createRegistry() 的返回值
 * @param {{ namespace?: string }} options
 * @returns {() => void} 反注册全部工具
 */
export function registerWithDsh(ctx, registry, { namespace = '' } = {}) {
  if (!ctx?.tools?.register) throw new Error('registerWithDsh: 当前 DSH 没有 ctx.tools.register')
  const disposers = []
  for (const tool of registry?.TOOLS || []) {
    const impl = registry.TOOL_IMPL?.[tool.name]
    if (typeof impl !== 'function') throw new Error(`registerWithDsh: 工具缺少实现 ${tool.name}`)
    const name = namespace ? `${namespace}_${tool.name}` : tool.name
    disposers.push(ctx.tools.register({
      name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => (value && Array.isArray(value.content)
          ? value.content
          : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]),
      },
      execute: (args) => impl(args),
    }))
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 忽略重复释放 */ }
    }
  }
}

export function createToolHost(config = {}) {
  return {
    api: createServiceApi('toolHost', '1.0.0', ['dsl', 'registry', 'validate', 'contract', 'mcp', 'instructions', 'native-tools']),
    version: '0.1.0',
    defineTool,
    defineCapability,
    createRegistry: (capabilities, options = {}) => createRegistry(capabilities, { ...config, ...options }),
    createMcpHandler,
    createToolDispatcher,
    createCapabilityReport,
    buildInstructions,
    registerWithDsh,
    validateToolArguments,
  }
}

export { validateToolArguments }

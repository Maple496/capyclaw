/**
 * 启动清单 DSL（v1）。
 *
 * 设计目标：一份可读的文本清单描述“启动哪个 dsh 模式、装哪些插件、跑哪些服务”。
 * DSL 只是**作者层**：解析成通用 AST 后，由 kind 对应的 handler 发射成
 * dsh-stack.json（现有 dshd 的契约）；执行仍交给 dshd，不在这里复制编排逻辑。
 *
 * 语法（行/块式，注释 # 或 //）：
 *
 *   stack "dev" {
 *     kind "profile"
 *     home "../.dshd/home"
 *     profile "web"
 *     workspace "../apps/harness/deepseek-harness/workspace"
 *     stateDir "../.dshd/state"
 *     ports { broker 13593 proxy 13594 upstream 13595 }
 *     plugins {
 *       bundle "@deepseek-ai/dsh-base"
 *       bundle "@deepseek-ai/dsh-web-app"
 *       plugin "dsh-launchpad" { path "../extensions/official/dsh-launchpad" }
 *       dependency "@capyclaw/plugin-kit" { path "../packages/@capyclaw/plugin-kit" }
 *       install true
 *     }
 *     service "launchpad" {
 *       path "../extensions/official/dsh-launchpad/server.mjs"
 *       args ["--roots", "${STACK_DIR}/.."]
 *       port 13596
 *       health "/healthz"
 *       keepAlive true
 *     }
 *   }
 *
 * 占位符：${STACK_DIR}=DSL 文件所在目录（发射时展开为绝对路径）；
 * ${home}/${profile}/${ports.*}/${PORT} 留给 dsh-stack-kit / broker。
 *
 * 扩展：KIND_HANDLERS 注册表；新增启动形态只需加一个 handler（v1 只有 profile）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

export class DslError extends Error {
  constructor(message, line = 0, code = 'DSL_ERROR') {
    super(line ? `第 ${line} 行: ${message}` : message)
    this.name = 'DslError'
    this.line = line
    this.code = code
  }
}

/** 词法：字符串、数字、裸词、括号、逗号、可选等号；# / // 行注释。 */
function tokenize(text) {
  const tokens = []
  let i = 0
  let line = 1
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '\n') { line += 1; i += 1; continue }
    if (/\s/.test(ch)) { i += 1; continue }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      let value = ''
      let closed = false
      i += 1
      while (i < n) {
        const c = text[i]
        if (c === '\\') {
          const next = text[i + 1]
          const escapes = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\' }
          value += escapes[next] ?? next ?? ''
          i += 2
          continue
        }
        if (c === quote) { closed = true; i += 1; break }
        if (c === '\n') line += 1
        value += c
        i += 1
      }
      if (!closed) throw new DslError('字符串未闭合', startLine)
      tokens.push({ type: 'string', value, line: startLine })
      continue
    }
    if ('{}[],='.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line })
      i += 1
      continue
    }
    const start = i
    while (i < n) {
      const c = text[i]
      if (/\s/.test(c) || '{}[],='.includes(c) || c === '#') break
      if (c === '/' && text[i + 1] === '/') break
      i += 1
    }
    const word = text.slice(start, i)
    if (!word) { i += 1; continue }
    if (/^-?\d+(?:\.\d+)?$/.test(word)) tokens.push({ type: 'number', value: Number(word), line })
    else tokens.push({ type: 'word', value: word, line })
  }
  tokens.push({ type: 'eof', value: '', line })
  return tokens
}

/**
 * 解析 DSL → 通用 AST：
 *   { type:'document', name, entries:[{key,label?,value?,block?,line}] }
 * 不校验具体字段；具体形态由 handler 解释。
 */
export function parseDsl(text, file = '') {
  const tokens = tokenize(text)
  let pos = 0
  const peek = () => tokens[pos]
  const advance = () => tokens[pos++]
  const isPunct = (value) => peek().type === 'punct' && peek().value === value
  const expectPunct = (value) => {
    if (!isPunct(value)) throw new DslError(`期望 "${value}"，得到 ${peek().value || peek().type}`, peek().line)
    return advance()
  }
  const skipEquals = () => { if (isPunct('=')) advance() }

  function parseValue() {
    const token = peek()
    if (isPunct('[')) {
      advance()
      const values = []
      while (!isPunct(']')) {
        if (peek().type === 'eof') throw new DslError('数组未闭合', token.line)
        if (isPunct(',')) { advance(); continue }
        values.push(parseValue())
        if (isPunct(',')) advance()
      }
      expectPunct(']')
      return values
    }
    if (token.type === 'string') { advance(); return token.value }
    if (token.type === 'number') { advance(); return token.value }
    if (token.type === 'word') {
      advance()
      if (token.value === 'true') return true
      if (token.value === 'false') return false
      if (token.value === 'null') return null
      return token.value
    }
    throw new DslError(`期望值，得到 ${token.value || token.type}`, token.line)
  }

  /** 读取块内容（调用方已消费 `{`，本函数停在 `}` 前）。 */
  function parseEntries() {
    const entries = []
    while (true) {
      const token = peek()
      if (token.type === 'eof') throw new DslError('缺少 "}"', token.line)
      if (isPunct('}')) return entries
      if (isPunct(',')) { advance(); continue }
      if (token.type !== 'word' && token.type !== 'string') {
        throw new DslError(`期望键名，得到 ${token.value || token.type}`, token.line)
      }
      const key = String(advance().value)
      skipEquals()
      // key "label" { ... }  vs  key "value"
      if (peek().type === 'string') {
        const lookahead = tokens[pos + 1]
        if (lookahead && lookahead.type === 'punct' && lookahead.value === '{') {
          const label = String(advance().value)
          skipEquals()
          expectPunct('{')
          const block = parseEntries()
          expectPunct('}')
          entries.push({ key, label, block, line: token.line })
          continue
        }
      }
      if (isPunct('{')) {
        advance()
        const block = parseEntries()
        expectPunct('}')
        entries.push({ key, block, line: token.line })
        continue
      }
      const value = parseValue()
      entries.push({ key, value, line: token.line })
    }
  }

  const first = peek()
  if (first.type !== 'word' || !['stack', 'launchpad'].includes(first.value)) {
    throw new DslError('文件必须以 stack "name" { ... } 开始', first.line)
  }
  advance()
  let name = ''
  if (peek().type === 'string') name = String(advance().value)
  skipEquals()
  expectPunct('{')
  const entries = parseEntries()
  expectPunct('}')
  if (peek().type !== 'eof') throw new DslError('顶层只能有一个 stack 块', peek().line)
  return { type: 'document', kind: 'stack', name, entries, file, line: 1 }
}

function findEntry(entries, key) {
  return (entries || []).find((entry) => entry.key === key)
}

function findAll(entries, key) {
  return (entries || []).filter((entry) => entry.key === key)
}

function valueOf(entries, key, fallback) {
  const entry = findEntry(entries, key)
  return entry && entry.value !== undefined ? entry.value : fallback
}

function blockOf(entries, key) {
  const entry = findEntry(entries, key)
  return entry?.block
}

function resolveDir(base, value) {
  if (typeof value !== 'string' || !value) return value
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value)
}

/** DSL 层只展开 ${STACK_DIR}（= DSL 目录）；其余占位符交给 dsh-stack-kit/broker。 */
function expandDsl(value, base) {
  if (typeof value !== 'string') return value
  let out = value
  // 路径型前缀用 path.join 拼接，避免 C:\repo/launchpads/.. 混合分隔符。
  for (const sep of ['/', '\\']) {
    const prefix = `\${STACK_DIR}${sep}`
    if (out.startsWith(prefix)) {
      out = path.join(base, out.slice(prefix.length))
      break
    }
  }
  return out.replaceAll('${STACK_DIR}', base)
}

function arrayOf(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function stringArray(value) {
  return arrayOf(value).map((item) => String(item))
}

function portIssues(value, field, errors) {
  if (value === 'auto') return
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) return
  errors.push(`${field} 必须是 1-65535 的整数或 "auto": ${JSON.stringify(value)}`)
}

function pluginEntry(entry, dslDir) {
  const name = entry.label || (entry.block ? valueOf(entry.block, 'name') : undefined) || entry.value
  if (!name) throw new DslError('plugin/bundle 缺少名称', entry.line)
  if (!entry.block) return String(name)
  const pluginPath = valueOf(entry.block, 'path')
  const version = valueOf(entry.block, 'version')
  if (pluginPath && version) throw new DslError(`plugin "${name}" 不能同时有 path 和 version`, entry.line)
  if (pluginPath) return { name: String(name), path: resolveDir(dslDir, String(pluginPath)) }
  if (version) return { name: String(name), version: String(version) }
  return String(name)
}

/**
 * `config "<bundle>" { ... }` → { name, row?, config }
 *
 * 块内除 `row` 外的键都当作配置字段；嵌套块递归成对象。
 * 例：
 *   config "@capyclaw/launchpad" {
 *     port 39700
 *     ui { open true }
 *   }
 */
function configEntry(entry) {
  const name = entry.label || (entry.block ? valueOf(entry.block, 'name') : undefined) || entry.value
  if (!name) throw new DslError('config 缺少 bundle 名称', entry.line)
  const block = entry.block || []
  const row = valueOf(block, 'row')
  const out = { name: String(name) }
  if (row !== undefined) out.row = String(row)
  const config = entriesToObject(block.filter((item) => item.key !== 'row' && item.key !== 'name'))
  if (Object.keys(config).length) out.config = config
  return out
}

function dependencyEntry(entry, dslDir) {
  const name = entry.label || valueOf(entry.block || [], 'name') || entry.value
  if (!name) throw new DslError('dependency/override 缺少名称', entry.line)
  if (entry.block) {
    const depPath = valueOf(entry.block, 'path')
    const version = valueOf(entry.block, 'version')
    if (depPath) return [String(name), resolveDir(dslDir, String(depPath))]
    if (version) return [String(name), String(version)]
  }
  if (entry.value !== undefined) {
    const raw = String(entry.value)
    return [String(name), raw]
  }
  throw new DslError(`dependency "${name}" 需要 path/version`, entry.line)
}

function compileProfile(doc, dslDir) {
  const entries = doc.entries || []
  const warnings = []
  const errors = []

  const name = doc.name || valueOf(entries, 'name')
  if (!name) throw new DslError('stack 缺少名称（stack "name" 或 name "..."）', 1)
  const home = valueOf(entries, 'home')
  if (!home) throw new DslError('home 必填（DSH_HOME）', findEntry(entries, 'home')?.line || 1)
  const profile = String(valueOf(entries, 'profile', 'web'))

  const stack = {
    name: String(name),
    home: resolveDir(dslDir, String(home)),
    profile,
    workspace: resolveDir(dslDir, String(valueOf(entries, 'workspace', './workspace'))),
    stateDir: resolveDir(dslDir, String(valueOf(entries, 'stateDir', './.dshd/state'))),
  }
  const harnessDir = valueOf(entries, 'harnessDir')
  if (harnessDir) stack.harnessDir = resolveDir(dslDir, String(harnessDir))
  const brokerDir = valueOf(entries, 'brokerDir')
  if (brokerDir) stack.brokerDir = resolveDir(dslDir, String(brokerDir))
  if (valueOf(entries, 'open') !== undefined) stack.open = !!valueOf(entries, 'open')

  const ports = {}
  const portsBlock = blockOf(entries, 'ports')
  if (portsBlock) {
    for (const entry of portsBlock) {
      const target = ['broker', 'proxy', 'upstream'].includes(entry.key) ? ports : (ports.services ||= {})
      target[entry.key] = entry.value
      portIssues(entry.value, `ports.${entry.key}`, errors)
    }
  }
  if (Object.keys(ports).length) stack.ports = ports

  const pluginsBlock = blockOf(entries, 'plugins') || []
  const bundles = []
  const dependencies = {}
  const overrides = {}
  const configs = []
  let install
  for (const entry of pluginsBlock) {
    if (entry.key === 'bundle') {
      bundles.push(pluginEntry(entry, dslDir))
    } else if (entry.key === 'plugin') {
      bundles.push(pluginEntry(entry, dslDir))
    } else if (entry.key === 'config') {
      configs.push(configEntry(entry))
    } else if (entry.key === 'dependency') {
      const [depName, spec] = dependencyEntry(entry, dslDir)
      dependencies[depName] = spec
    } else if (entry.key === 'override') {
      const [depName, spec] = dependencyEntry(entry, dslDir)
      overrides[depName] = spec
    } else if (entry.key === 'install') {
      install = !!entry.value
    } else {
      warnings.push(`plugins 内未知键: ${entry.key}`)
    }
  }
  if (Object.keys(bundles).length || Object.keys(dependencies).length || Object.keys(overrides).length || configs.length) {
    stack.plugins = {
      bundles,
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(configs.length ? { configs } : {}),
    }
    if (install !== undefined) stack.plugins.install = install
  }

  const services = []
  const ids = new Set()
  for (const entry of findAll(entries, 'service')) {
    const block = entry.block
    if (!block) throw new DslError(`service "${entry.label || '?'}" 需要 { ... } 块`, entry.line)
    const id = String(entry.label || valueOf(block, 'id') || '')
    if (!id) throw new DslError('service 缺少 id', entry.line)
    if (ids.has(id)) throw new DslError(`service id 重复: ${id}`, entry.line)
    ids.add(id)

    const service = { id }
    const servicePath = valueOf(block, 'path')
    const cmd = valueOf(block, 'cmd')
    if (servicePath && cmd) throw new DslError(`service "${id}" 不能同时有 path 和 cmd`, entry.line)
    if (servicePath) service.path = resolveDir(dslDir, String(servicePath))
    else if (cmd) service.cmd = stringArray(cmd)
    else throw new DslError(`service "${id}" 需要 path 或 cmd`, entry.line)

    const args = valueOf(block, 'args')
    if (args !== undefined) service.args = stringArray(args).map((item) => expandDsl(item, dslDir))

    const servicePorts = {}
    const port = valueOf(block, 'port')
    if (port !== undefined) servicePorts.main = port
    const servicePortsBlock = blockOf(block, 'ports')
    if (servicePortsBlock) for (const portEntry of servicePortsBlock) servicePorts[portEntry.key] = portEntry.value
    for (const [portName, value] of Object.entries(servicePorts)) portIssues(value, `service ${id}.ports.${portName}`, errors)
    if (Object.keys(servicePorts).length) service.ports = servicePorts

    const url = valueOf(block, 'url')
    if (url !== undefined) service.url = expandDsl(String(url), dslDir)
    const health = valueOf(block, 'health') ?? valueOf(block, 'healthPath')
    if (health !== undefined) service.healthPath = String(health)
    const keepAlive = valueOf(block, 'keepAlive')
    if (keepAlive !== undefined) service.keepAlive = !!keepAlive
    const requires = valueOf(block, 'requires')
    if (requires !== undefined) service.requires = stringArray(requires)
    const serviceEnv = blockOf(block, 'env')
    if (serviceEnv) {
      service.env = Object.fromEntries(serviceEnv.map((envEntry) => [
        envEntry.key,
        expandDsl(String(envEntry.value ?? ''), dslDir),
      ]))
    }
    const cwd = valueOf(block, 'cwd')
    if (cwd !== undefined) service.cwd = resolveDir(dslDir, expandDsl(String(cwd), dslDir))
    const logFile = valueOf(block, 'logFile')
    if (logFile !== undefined) service.logFile = resolveDir(dslDir, expandDsl(String(logFile), dslDir))
    services.push(service)
  }
  if (services.length) stack.services = services

  const envBlock = blockOf(entries, 'env')
  if (envBlock) {
    stack.env = Object.fromEntries(envBlock.map((entry) => [entry.key, expandDsl(String(entry.value ?? ''), dslDir)]))
  }

  if (!stack.plugins) warnings.push('没有 plugins 段：将使用 profile 已有 bundles（如果存在）')
  if (!stack.services) warnings.push('没有 services 段：只启动 dsh，不启动独立服务')
  if (errors.length) throw new DslError(errors.join('；'), findEntry(entries, 'ports')?.line || 1, 'INVALID_PORT')
  return { stack, warnings }
}

/** 把嵌套 block 递归转成普通对象（requires/scope/model 等覆盖项）。 */
function entriesToObject(entries) {
  const out = {}
  for (const entry of entries || []) {
    out[entry.key] = entry.block ? entriesToObject(entry.block) : entry.value
  }
  return out
}

/** domain 型：一份 dsh-domain.json + runtime 覆盖项；执行交给 dshd（kind=domain）。 */
function compileDomain(doc, dslDir) {
  const entries = doc.entries || []
  const warnings = []
  const errors = []

  const name = doc.name || valueOf(entries, 'name')
  if (!name) throw new DslError('stack 缺少名称（stack "name" 或 name "..."）', 1)
  const domainEntries = blockOf(entries, 'domain')
  if (!domainEntries) throw new DslError('domain 型需要 domain { source "..." } 块', findEntry(entries, 'domain')?.line || 1)
  const source = valueOf(domainEntries, 'source')
  if (!source) throw new DslError('domain.source 必填', findEntry(domainEntries, 'source')?.line || 1)
  const sourcePath = resolveDir(dslDir, String(source))
  if (!existsSync(sourcePath)) throw new DslError(`domain.source 不存在: ${sourcePath}`, findEntry(domainEntries, 'source')?.line || 1)
  if (!existsSync(path.join(sourcePath, 'dsh-domain.json')) && !existsSync(path.join(sourcePath, 'domain.json'))) {
    throw new DslError(`domain.source 下没有 dsh-domain.json / domain.json: ${sourcePath}`, findEntry(domainEntries, 'source')?.line || 1)
  }

  const stack = {
    kind: 'domain',
    name: String(name),
    stateDir: resolveDir(dslDir, String(valueOf(entries, 'stateDir', './.dshd/state'))),
    domain: { source: sourcePath },
  }
  const profile = valueOf(domainEntries, 'profile') ?? valueOf(entries, 'profile')
  if (profile !== undefined) stack.profile = String(profile)
  const runtimeId = valueOf(domainEntries, 'runtimeId')
  if (runtimeId !== undefined) stack.domain.runtimeId = String(runtimeId)
  const storeRoot = valueOf(domainEntries, 'storeRoot')
  if (storeRoot !== undefined) stack.domain.storeRoot = resolveDir(dslDir, String(storeRoot))
  const domainName = valueOf(domainEntries, 'name')
  if (domainName !== undefined) stack.domain.name = String(domainName)
  const recreate = valueOf(domainEntries, 'recreate')
  if (recreate !== undefined) stack.domain.recreate = !!recreate
  const modelBlock = blockOf(domainEntries, 'model')
  const model = valueOf(domainEntries, 'model')
  if (modelBlock) stack.domain.model = entriesToObject(modelBlock)
  else if (model !== undefined) stack.domain.model = model
  const wcBlock = blockOf(domainEntries, 'workspaceController')
  const wc = valueOf(domainEntries, 'workspaceController')
  if (wcBlock) stack.domain.workspaceController = entriesToObject(wcBlock)
  else if (wc !== undefined) stack.domain.workspaceController = wc
  for (const key of ['requires', 'scope']) {
    const block = blockOf(domainEntries, key)
    if (block) stack.domain[key] = entriesToObject(block)
  }
  const domainEnv = blockOf(domainEntries, 'env')
  if (domainEnv) {
    stack.domain.env = Object.fromEntries(domainEnv.map((entry) => [entry.key, expandDsl(String(entry.value ?? ''), dslDir)]))
  }

  const knownDomainKeys = new Set(['source', 'profile', 'runtimeId', 'storeRoot', 'name', 'recreate', 'model', 'workspaceController', 'requires', 'scope', 'env'])
  for (const entry of domainEntries) {
    if (!knownDomainKeys.has(entry.key)) warnings.push(`domain 内未知键: ${entry.key}`)
  }

  const ports = {}
  const portsBlock = blockOf(entries, 'ports')
  if (portsBlock) {
    for (const entry of portsBlock) {
      const target = ['broker', 'proxy', 'upstream', 'content'].includes(entry.key) ? ports : (ports.services ||= {})
      target[entry.key] = entry.value
      portIssues(entry.value, `ports.${entry.key}`, errors)
    }
  }
  if (Object.keys(ports).length) stack.ports = ports
  if (blockOf(entries, 'plugins')) warnings.push('domain 型忽略 plugins 段（插件由 domain/suite 决定）')
  if (blockOf(entries, 'services')) warnings.push('domain 型忽略 services 段（服务由 suite services.json 决定）')

  const harnessDir = valueOf(entries, 'harnessDir')
  if (harnessDir) stack.harnessDir = resolveDir(dslDir, String(harnessDir))
  const brokerDir = valueOf(entries, 'brokerDir')
  if (brokerDir) stack.brokerDir = resolveDir(dslDir, String(brokerDir))
  if (valueOf(entries, 'open') !== undefined) stack.open = !!valueOf(entries, 'open')
  const envBlock = blockOf(entries, 'env')
  if (envBlock) {
    stack.env = Object.fromEntries(envBlock.map((entry) => [entry.key, expandDsl(String(entry.value ?? ''), dslDir)]))
  }

  if (errors.length) throw new DslError(errors.join('；'), findEntry(entries, 'ports')?.line || 1, 'INVALID_PORT')
  return { stack, warnings }
}

/** kind → handler 注册表；后续新增启动形态在这里加。 */
export const KIND_HANDLERS = {
  profile: compileProfile,
  domain: compileDomain,
}

/**
 * 把 DSL 发射成 dsh-stack.json（不含 $schema；内部生成物）。
 * @returns {{ stack: object, warnings: string[], kind: string }}
 */
export function dslToStack(doc, file = doc.file || 'launchpad.stack') {
  const dslDir = path.dirname(path.resolve(file))
  const entries = doc.entries || []
  const kind = String(valueOf(entries, 'kind', 'profile'))
  const handler = KIND_HANDLERS[kind]
  if (!handler) throw new DslError(`不支持的 kind "${kind}"；可用: ${Object.keys(KIND_HANDLERS).join(', ')}`, findEntry(entries, 'kind')?.line || 1, 'UNSUPPORTED_KIND')
  const { stack, warnings } = handler(doc, dslDir)
  return { stack, warnings, kind }
}

/** 解析 + 发射 + 基础校验；返回结构化结果，不抛异常。 */
export function validateDsl(text, file = 'launchpad.stack') {
  try {
    const doc = parseDsl(text, file)
    const { stack, warnings, kind } = dslToStack(doc, file)
    return { ok: true, errors: [], warnings, stack, doc, kind }
  } catch (error) {
    return {
      ok: false,
      errors: [{ message: error.message, line: error.line || 0, code: error.code || 'DSL_ERROR' }],
      warnings: [],
      stack: null,
      doc: null,
      kind: '',
    }
  }
}

/* ------------------------------------------------------------------ */
/* 结构化改写 plugins 块（插件管理面板用）                              */
/* ------------------------------------------------------------------ */

function isPathLike(value) {
  return typeof value === 'string'
    && (value.startsWith('/') || value.startsWith('\\') || value.startsWith('.')
      || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('link:') || value.startsWith('file:'))
}

function quote(value) {
  return JSON.stringify(String(value))
}

function scanFindTopLevelBlock(text, key) {
  let i = 0
  let depth = 0
  let line = 1
  let quoteChar = ''
  let lineComment = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\n') { line += 1; lineComment = false; i += 1; continue }
    if (lineComment) { i += 1; continue }
    if (quoteChar) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quoteChar) quoteChar = ''
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') { lineComment = true; i += 2; continue }
    if (ch === '#') { lineComment = true; i += 1; continue }
    if (ch === '"' || ch === "'") { quoteChar = ch; i += 1; continue }
    if (ch === '{') { depth += 1; i += 1; continue }
    if (ch === '}') { depth -= 1; i += 1; continue }
    if (depth === 1 && /[A-Za-z_]/.test(ch)) {
      const start = i
      while (i < text.length && /[A-Za-z0-9_.-]/.test(text[i])) i += 1
      const word = text.slice(start, i)
      if (word === key) {
        let j = i
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] === '{') {
          const end = scanMatchingBrace(text, j)
          if (end !== -1) return { start, open: j, end, line }
        }
      }
      continue
    }
    i += 1
  }
  return null
}

function scanMatchingBrace(text, openIndex) {
  let depth = 0
  let quoteChar = ''
  let lineComment = false
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') { lineComment = false; continue }
    if (lineComment) continue
    if (quoteChar) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quoteChar) quoteChar = ''
      continue
    }
    if (ch === '/' && text[i + 1] === '/') { lineComment = true; i += 1; continue }
    if (ch === '#') { lineComment = true; continue }
    if (ch === '"' || ch === "'") { quoteChar = ch; continue }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function scanStackClose(text) {
  let depth = 0
  let quoteChar = ''
  let lineComment = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') { lineComment = false; continue }
    if (lineComment) continue
    if (quoteChar) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quoteChar) quoteChar = ''
      continue
    }
    if (ch === '/' && text[i + 1] === '/') { lineComment = true; i += 1; continue }
    if (ch === '#') { lineComment = true; continue }
    if (ch === '"' || ch === "'") { quoteChar = ch; continue }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 把结构化 plugin spec 序列化成 DSL 的 plugins 块。 */
export function serializePluginsBlock(spec = {}) {
  const lines = ['plugins {']
  for (const raw of spec.bundles || []) {
    if (typeof raw === 'string') {
      lines.push(`  bundle ${quote(raw)}`)
      continue
    }
    if (!raw || typeof raw.name !== 'string') continue
    lines.push(`  plugin ${quote(raw.name)} {`)
    if (raw.path) lines.push(`    path ${quote(raw.path)}`)
    else if (raw.version) lines.push(`    version ${quote(raw.version)}`)
    lines.push('  }')
  }
  for (const [name, value] of Object.entries(spec.dependencies || {})) {
    lines.push(`  dependency ${quote(name)} {`)
    if (isPathLike(value)) lines.push(`    path ${quote(value)}`)
    else lines.push(`    version ${quote(value)}`)
    lines.push('  }')
  }
  for (const [name, value] of Object.entries(spec.overrides || {})) {
    lines.push(`  override ${quote(name)} {`)
    if (isPathLike(value)) lines.push(`    path ${quote(value)}`)
    else lines.push(`    version ${quote(value)}`)
    lines.push('  }')
  }
  if (spec.install !== undefined) lines.push(`  install ${spec.install ? 'true' : 'false'}`)
  lines.push('}')
  return lines.join('\n')
}

/**
 * 把 DSL 里 top-level plugins 块替换成 spec；保留块外内容/注释。
 * 块内注释会被重写（插件面板的应用动作）。
 */
export function replacePluginsBlock(text, spec = {}) {
  const block = serializePluginsBlock(spec)
  const span = scanFindTopLevelBlock(text, 'plugins')
  if (span) return `${text.slice(0, span.start)}${block}${text.slice(span.end + 1)}`
  const close = scanStackClose(text)
  if (close === -1) throw new DslError('找不到 stack 的结束 "}"，无法写入 plugins 块', 1)
  return `${text.slice(0, close)}\n\n  ${block.split('\n').join('\n  ')}\n${text.slice(close)}`
}

/** 生成物里再确认一次服务路径存在（plan 阶段 dshd 也会查，这里给编辑器早反馈）。 */
export function lintStackPaths(stack) {
  const warnings = []
  for (const bundle of stack.plugins?.bundles || []) {
    if (bundle && typeof bundle === 'object' && bundle.path && !existsSync(bundle.path)) {
      warnings.push(`插件路径不存在: ${bundle.path}`)
    }
  }
  for (const service of stack.services || []) {
    if (service.path && !existsSync(service.path)) warnings.push(`服务路径不存在: ${service.path}`)
  }
  if (stack.domain?.source && !existsSync(stack.domain.source)) {
    warnings.push(`domain.source 不存在: ${stack.domain.source}`)
  }
  return warnings
}

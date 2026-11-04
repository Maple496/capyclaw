/**
 * 能力注册表（capability registry）：「要求 → 激活规格」的解析表。
 *
 * 这是 launch-engine 的数据面：planner / executor 只认这里的归一化结构，
 * 不直接碰原始 JSON。三种来源（与 plugin-sync 的清单源同构）：
 *
 *   inline  config.capabilities 直接给对象（默认；允许空表——插件能起，
 *           注册表随后由 stack.plugins.configs 或 local 文件注入）
 *   local   读本地 JSON 文件（registryPath）
 *   profile 读 <DSH_HOME>/profiles/<DSH_PROFILE>/launch-engine.registry.json
 *           （suite-kit installSuites/installDomain 从 dsh-suite.json 组合结果生成）
 *   http    预留接口，显式 NOT_IMPLEMENTED（契约见 createHttpRegistry）
 *
 * 归一化后的能力结构：
 *   {
 *     name: string,
 *     title: string,                // 缺省 = name
 *     requires: string[],           // 依赖的其他 capability（先激活）
 *     bundles: [{ name, enabled }], // bundle 级开关（转发 pluginManager）
 *     entries: [{ entryId, enabled }], // 行级开关（entryId 通常 include:<rowId>）
 *     services: [{ id, ...spec }],  // 服务进程（转发 serviceBroker.start）
 *   }
 *
 * services 的其余字段（cmd/env/ports/url…）原样透传给 broker，由 broker 侧
 * 校验——这里只强制 id 非空，不复制一份校验职责。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export class RegistryError extends Error {
  constructor(message, code = 'REGISTRY_ERROR', detail) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
    if (detail) this.detail = detail
  }
}

const trimName = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RegistryError(`${label} 必须是非空字符串`, 'INVALID_REGISTRY')
  }
  return value.trim()
}

const normalizeSwitch = (item, key, label) => {
  if (!item || typeof item !== 'object') {
    throw new RegistryError(`${label} 的每一项必须是对象`, 'INVALID_REGISTRY')
  }
  return { [key]: trimName(item[key], `${label}.${key}`), enabled: item.enabled !== false }
}

/** 把原始 JSON 归一化 + 校验；错误一律 RegistryError（带 code）。 */
export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistryError('注册表必须是对象', 'INVALID_REGISTRY')
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new RegistryError(`不支持的注册表版本: ${raw.version}`, 'INVALID_REGISTRY')
  }
  const source = raw.capabilities !== undefined ? raw.capabilities : raw
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new RegistryError('注册表缺少 capabilities 对象', 'INVALID_REGISTRY')
  }

  const capabilities = {}
  for (const [rawName, spec] of Object.entries(source)) {
    const name = trimName(rawName, 'capability 名')
    if (capabilities[name]) throw new RegistryError(`capability 重复定义: ${name}`, 'INVALID_REGISTRY')
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new RegistryError(`capability ${name} 必须是对象`, 'INVALID_REGISTRY')
    }

    const requires = []
    for (const dep of spec.requires || []) {
      const depName = trimName(dep, `capability ${name}.requires 的项`)
      if (depName === name) throw new RegistryError(`capability ${name} 不能依赖自己`, 'INVALID_REGISTRY')
      if (!requires.includes(depName)) requires.push(depName)
    }

    const bundles = (spec.bundles || []).map((item) => normalizeSwitch(item, 'name', `capability ${name}.bundles`))
    const entries = (spec.entries || []).map((item) => normalizeSwitch(item, 'entryId', `capability ${name}.entries`))
    const services = (spec.services || []).map((item) => {
      if (!item || typeof item !== 'object') {
        throw new RegistryError(`capability ${name}.services 的每一项必须是对象`, 'INVALID_REGISTRY')
      }
      return { ...item, id: trimName(item.id, `capability ${name}.services.id`) }
    })

    capabilities[name] = {
      name,
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : name,
      requires,
      bundles,
      entries,
      services,
    }
  }
  return { version: 1, capabilities }
}

/** inline 源：直接吃 config 注入的对象。 */
export function createInlineRegistry({ capabilities } = {}) {
  const data = capabilities === undefined ? {} : capabilities
  return {
    id: 'inline',
    async describe() { return normalizeRegistry({ capabilities: data }) },
  }
}

/** local 源：读本地 JSON 文件（每次 describe 重读，改文件即生效）。 */
export function createLocalRegistry({ file, cwd = process.cwd() } = {}) {
  if (!file) throw new RegistryError('local 注册表缺少 file', 'INVALID_REGISTRY')
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file)
  return {
    id: 'local',
    file: abs,
    async describe() {
      if (!existsSync(abs)) throw new RegistryError(`注册表文件不存在: ${abs}`, 'REGISTRY_NOT_FOUND')
      let raw
      try {
        raw = JSON.parse(await readFile(abs, 'utf8'))
      } catch (error) {
        throw new RegistryError(`注册表解析失败 (${abs}): ${error.message}`, 'INVALID_REGISTRY')
      }
      return normalizeRegistry(raw)
    },
  }
}

/**
 * profile 源：读 suite-kit 安装期生成的
 *   <DSH_HOME>/profiles/<DSH_PROFILE>/launch-engine.registry.json
 *
 * 注册表的唯一事实来源是 dsh-suite.json——installSuites / installDomain
 * 把组合结果编译成该文件，本源只是它的运行期视图，不再手写注册表。
 * 文件缺席时在 describe 诚实报错（stack 型 profile 没有这份文件，
 * 应显式换 inline/local 源）。
 */
export function createProfileRegistry({ home, profile, file } = {}) {
  const resolveFile = () => {
    if (file) return path.isAbsolute(file) ? file : path.resolve(file)
    const homeDir = home || process.env.DSH_HOME
    const profileName = profile || process.env.DSH_PROFILE
    if (!homeDir || !profileName) {
      throw new RegistryError(
        'profile 注册表源需要 DSH_HOME 与 DSH_PROFILE（dsh 进程内自动提供）',
        'INVALID_REGISTRY',
      )
    }
    return path.join(path.resolve(homeDir), 'profiles', profileName, 'launch-engine.registry.json')
  }
  return {
    id: 'profile',
    get file() { return resolveFile() },
    async describe() {
      const abs = resolveFile()
      if (!existsSync(abs)) {
        throw new RegistryError(
          `profile 注册表不存在: ${abs}（由 @capyclaw/suite-kit installSuites/installDomain 生成；stack 型 profile 请改用 inline/local 源）`,
          'REGISTRY_NOT_FOUND',
        )
      }
      let raw
      try {
        raw = JSON.parse(await readFile(abs, 'utf8'))
      } catch (error) {
        throw new RegistryError(`注册表解析失败 (${abs}): ${error.message}`, 'INVALID_REGISTRY')
      }
      return normalizeRegistry(raw)
    },
  }
}

/**
 * HTTP 注册表源（预留）。
 *
 * 契约（实现时按此对接）：
 *   GET <url>  → 200 + application/json，body 即注册表结构（capabilities 对象）
 *   需要鉴权时用 Authorization: Bearer <token>（token 从 env 读，不落配置）
 *   解析后必须过 normalizeRegistry 校验
 */
export function createHttpRegistry({ url, tokenEnv = 'DSH_LE_TOKEN' } = {}) {
  if (!url) throw new RegistryError('http 注册表缺少 url', 'INVALID_REGISTRY')
  return {
    id: 'http',
    url,
    async describe() {
      const error = new Error(
        `http 注册表源尚未实现（${url}）。契约：GET 返回注册表 JSON，见 lib/registry.mjs 注释。`
        + ` 鉴权使用环境变量 ${tokenEnv}。`,
      )
      error.code = 'NOT_IMPLEMENTED'
      throw error
    },
  }
}

export function createRegistry({ kind = 'inline', file, url, capabilities, cwd } = {}) {
  if (kind === 'inline') return createInlineRegistry({ capabilities })
  if (kind === 'local') return createLocalRegistry({ file, cwd })
  if (kind === 'profile') return createProfileRegistry({ file })
  if (kind === 'http') return createHttpRegistry({ url })
  throw new RegistryError(`未知的注册表源类型: ${kind}（可用 inline | local | profile | http）`, 'INVALID_REGISTRY')
}

/** 查单个 capability；未知时列出可用项（不静默）。 */
export function lookupCapability(registry, name) {
  const spec = registry.capabilities[trimName(name, 'capability 名')]
  if (!spec) {
    const available = Object.keys(registry.capabilities)
    throw new RegistryError(
      `未注册的 capability: ${name}（可用: ${available.length ? available.join(', ') : '（注册表为空）'}）`,
      'UNKNOWN_CAPABILITY',
      { available },
    )
  }
  return spec
}

/**
 * 依赖闭包：按「依赖在前」返回有序 capability 名列表。
 *
 * - 后序 DFS：requires 全部就位后才排自己
 * - 环：带路径报错（a → b → a）
 * - 未知依赖：RegistryError
 * - 去重：每个 capability 只出现一次（首个出现位置 = 最深依赖处）
 */
export function resolveClosure(registry, name) {
  lookupCapability(registry, name)
  const order = []
  const visited = new Set()
  const visit = (current, stack) => {
    if (visited.has(current)) return
    if (stack.includes(current)) {
      throw new RegistryError(
        `capability 依赖成环: ${[...stack, current].join(' → ')}`,
        'CAPABILITY_CYCLE',
      )
    }
    const spec = lookupCapability(registry, current)
    for (const dep of spec.requires) visit(dep, [...stack, current])
    visited.add(current)
    order.push(current)
  }
  visit(name, [])
  return order
}

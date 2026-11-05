/**
 * 从 suite 组合结果编译 launch-engine 的 capability 注册表。
 *
 * 「实现一个功能要注册哪些组件」的唯一事实来源是 dsh-suite.json；
 * 这里把它编译成运行期激活面（@capyclaw/launch-engine）直接消费的注册表，
 * 不再手写第二种「要求 → 组件」映射。映射规则：
 *
 *   - 每个包 = 一个激活 capability（name = 包名），条件是它有 row、拥有服务进程、
 *     或是组合内其他包 required capability 的提供方（纯 support 依赖不单独成能力）
 *       entries = 该包的 rows（entryId = include:<rowId>）
 *       requires = 包 requires.capabilities 解析到的提供方包（组合内）
 *       services = 套件 services.json 里 cmd 指向该包 node_modules/<pkg>/ 的条目
 *   - 每个套件 = 一个聚合 capability（name = 套件名；bundle 级开关）
 *       bundles = [{ name: 套件名 }]（installSuites 把套件名写进 dsh.profile.bundles）
 *       requires = 该套件下所有已注册的包 capability
 *       entries/services = 无法归属到具体包的行与服务
 *
 * services 编译时展开 ${PACKAGE_DIR}（注册表落在 profile 目录，不能依赖
 * broker 清单装载期的展开基准），剥掉 portFrom/dirFrom（那是 runtime
 * 物化期的分配提示，不是激活语义）；${PORT} 原样留给 broker 仲裁。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ACTIVATION_REGISTRY_FILENAME = 'launch-engine.registry.json'
const ENTRY_PREFIX = 'include:'

function readSuiteServices(suiteDir) {
  const file = path.join(suiteDir, 'services.json')
  if (!fs.existsSync(file)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw?.services) ? raw.services : []
  } catch {
    return []
  }
}

function serviceOwnerPackage(service, packageNames) {
  const cmd = Array.isArray(service?.cmd) ? service.cmd.join(' ') : ''
  for (const name of packageNames) {
    const needle = `node_modules/${name}/`
    if (cmd.includes(needle)) return name
  }
  return null
}

/** 展开 services.json 的 ${PACKAGE_DIR}。两种规格：
 *  - 新代：cmd 形如 ${PACKAGE_DIR}/node_modules/<pkg>/…——${PACKAGE_DIR} 指
 *    持有 node_modules 的套件根（services.json 所在目录），不是 owner 包自身目录；
 *  - 旧代：cmd 形如 ${PACKAGE_DIR}/server/relay.mjs——${PACKAGE_DIR} 指 owner 包目录。 */
function toActivationService(service, { packageDir, suiteDir }) {
  const joined = (service.cmd || []).join(' ')
  const base = joined.includes('node_modules/') ? suiteDir : packageDir
  const cmd = (service.cmd || []).map((part) => String(part).replaceAll('${PACKAGE_DIR}', base))
  const next = { ...service, cmd }
  delete next.portFrom
  delete next.dirFrom
  return next
}

function packageDirOf(pkg) {
  if (!pkg?.dir || !pkg?.entry?.path) return null
  return path.resolve(pkg.dir, pkg.entry.path).replace(/\\/g, '/')
}

/**
 * @param {{suites: {dir:string, manifest:object}[], composed: object, requiredCapabilities?: string[]}} input
 *   suites   已加载（components 已展开）的套件；composed = composeSuites 输出
 *   requiredCapabilities  额外的能力名（如 domain runtime.requires.capabilities），
 *                         其提供方也应进入注册表
 * @returns {{registry: {version:1, capabilities:object}, warnings: string[]}}
 */
export function buildActivationRegistry({ suites, composed, requiredCapabilities = [] }) {
  const warnings = []
  const capabilities = {}
  const packages = composed?.packages || []
  const packageNames = packages.map((pkg) => pkg.name)
  const capProvider = new Map((composed?.capabilities || []).map((item) => [item.capability, item.package]))

  /* 组合内被别人 required 的能力的提供方：即使没有 row（纯服务进程形态，
   * 如 capyclaw-ppt-workbench）也必须成为 capability，否则依赖图断链。 */
  const demandedProviders = new Set()
  for (const pkg of packages) {
    for (const capability of Object.keys(pkg.entry.requires?.capabilities || {})) {
      const provider = capProvider.get(capability)
      if (provider) demandedProviders.add(provider)
    }
  }
  for (const capability of requiredCapabilities) {
    const provider = capProvider.get(String(capability).split('@')[0])
    if (provider) demandedProviders.add(provider)
  }

  const rowsByPackage = new Map()
  const orphanRowsBySuite = new Map()
  for (const row of composed?.rows || []) {
    if (row.disabled) continue
    if (packageNames.includes(row.name)) {
      rowsByPackage.set(row.name, [...(rowsByPackage.get(row.name) || []), row])
    } else {
      const suite = row._suite || ''
      orphanRowsBySuite.set(suite, [...(orphanRowsBySuite.get(suite) || []), row])
    }
  }

  const packageServices = new Map()
  for (const suite of suites || []) {
    for (const service of readSuiteServices(suite.dir)) {
      const owner = serviceOwnerPackage(service, packageNames)
      if (owner) packageServices.set(owner, [...(packageServices.get(owner) || []), { service, suiteDir: (suite.dir || '').replace(/\\/g, '/') }])
    }
  }

  for (const pkg of packages) {
    const rows = rowsByPackage.get(pkg.name) || []
    const services = packageServices.get(pkg.name) || []
    if (!rows.length && !services.length && !demandedProviders.has(pkg.name)) continue
    const requires = []
    for (const capability of Object.keys(pkg.entry.requires?.capabilities || {})) {
      const provider = capProvider.get(capability)
      if (!provider || provider === pkg.name || requires.includes(provider)) continue
      if (!packageNames.includes(provider)) continue
      requires.push(provider)
    }
    capabilities[pkg.name] = {
      name: pkg.name,
      title: pkg.name,
      requires,
      bundles: [],
      entries: rows.map((row) => ({ entryId: ENTRY_PREFIX + row.id, enabled: true })),
      services: services.map(({ service, suiteDir }) => toActivationService(service, {
        packageDir: packageDirOf(pkg) || suiteDir,
        suiteDir,
      })),
    }
  }

  for (const suite of suites || []) {
    const name = suite.manifest.name
    const dir = (suite.dir || '').replace(/\\/g, '/')
    if (capabilities[name]) {
      warnings.push(`capability 名冲突: 套件 ${name} 与已有包能力重名，聚合能力改用 suite:<name>`)
    }
    const aggregateName = capabilities[name] ? `suite:${name}` : name
    const unmatched = []

    for (const service of readSuiteServices(suite.dir)) {
      const owner = serviceOwnerPackage(service, packageNames)
      /* 已在包能力里挂载的服务不重复；只有无主或主人未成能力的才归套件聚合。 */
      if (owner && capabilities[owner]) continue
      unmatched.push(toActivationService(service, { packageDir: dir, suiteDir: dir }))
    }

    const requires = []
    for (const pkg of packages) {
      if (pkg.suite !== name) continue
      if (capabilities[pkg.name] && !requires.includes(pkg.name)) requires.push(pkg.name)
    }
    const orphanRows = orphanRowsBySuite.get(name) || []
    if (orphanRows.length) {
      warnings.push(`${name}: 行 [${orphanRows.map((row) => row.id).join(', ')}] 引用的包不在组合里（外部已安装），归入套件聚合能力`)
    }

    capabilities[aggregateName] = {
      name: aggregateName,
      title: suite.manifest.title || name,
      requires,
      bundles: [{ name, enabled: true }],
      entries: orphanRows.map((row) => ({ entryId: ENTRY_PREFIX + row.id, enabled: true })),
      services: unmatched,
    }
  }

  return { registry: { version: 1, capabilities }, warnings }
}

/** 安装期落盘：<profile>/launch-engine.registry.json。 */
export function writeActivationRegistry(profileDir, { suites, composed }) {
  const { registry, warnings } = buildActivationRegistry({ suites, composed })
  const file = path.join(profileDir, ACTIVATION_REGISTRY_FILENAME)
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n')
  return { file, registry, warnings, capabilities: Object.keys(registry.capabilities) }
}

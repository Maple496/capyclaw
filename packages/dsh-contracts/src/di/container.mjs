/**
 * 轻量级依赖注入容器
 *
 * @deprecated 本模块在仓库内无任何调用方（2026-11-04 全仓 grep 确认），
 *   且与 DSH 既有的 Cordis 插件体系存在概念重叠，建议新代码不要使用。
 *
 * 注意：废弃理由**不是性能**。实测（tests/performance/real-benchmark.mjs）：
 *   - DIContainer.resolve() ≈ 100.9M ops/s（9.9 ns/op）
 *   - Cordis ctx 服务访问   ≈ 146K ops/s（6.9 µs/op，Proxy + 反射开销）
 *   DIContainer 在纯访问路径上快约 693 倍。
 *
 * 选择 Cordis 的真实理由是**结构性能力**，不是速度：
 * - 事件系统（ctx.on / ctx.emit）
 * - 插件生命周期（Fiber 的 dispose、依赖注入声明 ctx.inject）
 * - 热重载（HMR）
 * - 隔离作用域（isolate）与依赖拓扑
 * - DSH 生态一致（仓库内 50 个 cordis.patch.yml）
 *
 * 若用 Cordis 且在意热路径性能：在插件 apply() 里把服务取到局部变量，
 * 不要在循环里反复读 ctx.xxx。
 *
 * 迁移说明见同目录 MIGRATION_TO_CORDIS.md
 *
 * @see https://github.com/cordiverse/cordis
 */

export class DIContainer {
  constructor() {
    this.services = new Map()
    this.singletons = new Map()
  }

  /**
   * 注册服务（每次创建新实例）
   * @param {string} name - 服务名称
   * @param {Function} factory - 工厂函数
   */
  register(name, factory) {
    if (typeof factory !== 'function') {
      throw new Error(`Factory for service '${name}' must be a function`)
    }
    this.services.set(name, { factory, singleton: false })
    return this
  }

  /**
   * 注册单例服务（只创建一次）
   * @param {string} name - 服务名称
   * @param {Function} factory - 工厂函数
   */
  registerSingleton(name, factory) {
    if (typeof factory !== 'function') {
      throw new Error(`Factory for service '${name}' must be a function`)
    }
    this.services.set(name, { factory, singleton: true })
    return this
  }

  /**
   * 注册实例（直接注册已创建的实例）
   * @param {string} name - 服务名称
   * @param {any} instance - 服务实例
   */
  registerInstance(name, instance) {
    this.singletons.set(name, instance)
    return this
  }

  /**
   * 解析服务
   * @param {string} name - 服务名称
   * @returns {any} 服务实例
   */
  resolve(name) {
    // 检查是否有已创建的单例
    if (this.singletons.has(name)) {
      return this.singletons.get(name)
    }

    // 检查是否注册了该服务
    const service = this.services.get(name)
    if (!service) {
      throw new Error(`Service '${name}' not registered`)
    }

    // 创建实例
    const instance = service.factory(this)

    // 如果是单例，缓存实例
    if (service.singleton) {
      this.singletons.set(name, instance)
    }

    return instance
  }

  /**
   * 检查服务是否已注册
   * @param {string} name - 服务名称
   * @returns {boolean}
   */
  has(name) {
    return this.services.has(name) || this.singletons.has(name)
  }

  /**
   * 清除所有注册
   */
  clear() {
    this.services.clear()
    this.singletons.clear()
  }

  /**
   * 创建子容器
   * @returns {DIContainer}
   */
  createChild() {
    const child = new DIContainer()
    // 子容器继承父容器的注册（但不继承单例实例）
    for (const [name, service] of this.services.entries()) {
      child.services.set(name, service)
    }
    return child
  }
}

/**
 * 全局默认容器
 */
export const container = new DIContainer()

/**
 * 装饰器风格的注入辅助函数
 * 
 * @example
 * const loader = inject('IPluginLoader')
 */
export function inject(serviceName) {
  return container.resolve(serviceName)
}

/**
 * 批量注册服务
 * 
 * @param {Object} services - 服务映射对象
 * @example
 * registerServices({
 *   'IPluginLoader': () => new PluginLoaderImpl(),
 *   'IServiceBroker': (c) => new ServiceBrokerImpl(c.resolve('config'))
 * })
 */
export function registerServices(services) {
  for (const [name, factory] of Object.entries(services)) {
    container.register(name, factory)
  }
}

/**
 * 批量注册单例服务
 */
export function registerSingletons(services) {
  for (const [name, factory] of Object.entries(services)) {
    container.registerSingleton(name, factory)
  }
}

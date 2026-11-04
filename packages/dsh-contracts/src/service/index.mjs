/**
 * 服务相关接口定义
 */

/**
 * 服务代理接口
 * 
 * 负责服务的注册、发现和路由
 */
export class IServiceBroker {
  /**
   * 注册服务
   * @param {Service} service - 服务实例
   * @returns {Promise<void>}
   */
  async register(service) {
    throw new Error('IServiceBroker.register() must be implemented')
  }

  /**
   * 解析服务
   * @param {string} serviceName - 服务名称
   * @returns {Promise<Service>} 服务实例
   */
  async resolve(serviceName) {
    throw new Error('IServiceBroker.resolve() must be implemented')
  }

  /**
   * 注销服务
   * @param {string} serviceName - 服务名称
   * @returns {Promise<void>}
   */
  async unregister(serviceName) {
    throw new Error('IServiceBroker.unregister() must be implemented')
  }
}

/**
 * 服务宿主接口
 */
export class IServiceHost {
  /**
   * 启动服务
   * @param {ServiceConfig} config - 服务配置
   * @returns {Promise<void>}
   */
  async start(config) {
    throw new Error('IServiceHost.start() must be implemented')
  }

  /**
   * 停止服务
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('IServiceHost.stop() must be implemented')
  }

  /**
   * 健康检查
   * @returns {Promise<HealthStatus>}
   */
  async health() {
    throw new Error('IServiceHost.health() must be implemented')
  }
}

export const ServiceInterfaces = {
  IServiceBroker,
  IServiceHost,
}

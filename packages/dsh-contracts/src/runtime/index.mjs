/**
 * 运行时相关接口定义
 */

/**
 * 运行时控制接口
 */
export class IRuntimeControl {
  /**
   * 启动运行时
   * @param {RuntimeConfig} config - 运行时配置
   * @returns {Promise<void>}
   */
  async start(config) {
    throw new Error('IRuntimeControl.start() must be implemented')
  }

  /**
   * 停止运行时
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('IRuntimeControl.stop() must be implemented')
  }

  /**
   * 重启运行时
   * @returns {Promise<void>}
   */
  async restart() {
    throw new Error('IRuntimeControl.restart() must be implemented')
  }

  /**
   * 获取运行状态
   * @returns {RuntimeStatus}
   */
  getStatus() {
    throw new Error('IRuntimeControl.getStatus() must be implemented')
  }
}

/**
 * 生命周期接口
 */
export class ILifecycle {
  /**
   * 初始化
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('ILifecycle.initialize() must be implemented')
  }

  /**
   * 清理资源
   * @returns {Promise<void>}
   */
  async dispose() {
    throw new Error('ILifecycle.dispose() must be implemented')
  }
}

export const RuntimeInterfaces = {
  IRuntimeControl,
  ILifecycle,
}

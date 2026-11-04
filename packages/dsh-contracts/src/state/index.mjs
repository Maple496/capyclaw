/**
 * 状态管理相关接口定义
 */

/**
 * 状态后端接口
 * 
 * 负责持久化和读取应用状态
 */
export class IStateBackend {
  /**
   * 读取状态
   * @returns {object} 当前状态
   */
  readState() {
    throw new Error('IStateBackend.readState() must be implemented')
  }

  /**
   * 写入状态
   * @param {object} state - 新状态
   * @returns {void}
   */
  writeState(state) {
    throw new Error('IStateBackend.writeState() must be implemented')
  }

  /**
   * 清空状态
   * @returns {void}
   */
  clearState() {
    throw new Error('IStateBackend.clearState() must be implemented')
  }
}

/**
 * 状态服务接口
 */
export class IStateService {
  /**
   * 获取状态
   * @param {string} key - 状态键
   * @returns {Promise<any>}
   */
  async get(key) {
    throw new Error('IStateService.get() must be implemented')
  }

  /**
   * 设置状态
   * @param {string} key - 状态键
   * @param {any} value - 状态值
   * @returns {Promise<void>}
   */
  async set(key, value) {
    throw new Error('IStateService.set() must be implemented')
  }

  /**
   * 删除状态
   * @param {string} key - 状态键
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error('IStateService.delete() must be implemented')
  }
}

export const StateInterfaces = {
  IStateBackend,
  IStateService,
}

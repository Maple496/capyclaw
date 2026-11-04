/**
 * 编辑器相关接口定义
 */

/**
 * 编辑器宿主接口
 * 
 * 负责编辑器的托管和租约管理
 */
export class IEditorHost {
  /**
   * 创建编辑器会话
   * @param {string} editorId - 编辑器ID
   * @param {object} config - 编辑器配置
   * @returns {Promise<{sessionId: string, url: string}>}
   */
  async createSession(editorId, config) {
    throw new Error('IEditorHost.createSession() must be implemented')
  }

  /**
   * 关闭编辑器会话
   * @param {string} sessionId - 会话ID
   * @returns {Promise<void>}
   */
  async closeSession(sessionId) {
    throw new Error('IEditorHost.closeSession() must be implemented')
  }

  /**
   * 获取会话状态
   * @param {string} sessionId - 会话ID
   * @returns {Promise<SessionStatus>}
   */
  async getSessionStatus(sessionId) {
    throw new Error('IEditorHost.getSessionStatus() must be implemented')
  }

  /**
   * 心跳检测
   * @param {string} sessionId - 会话ID
   * @returns {Promise<void>}
   */
  async heartbeat(sessionId) {
    throw new Error('IEditorHost.heartbeat() must be implemented')
  }
}

/**
 * 编辑器传输接口
 */
export class IEditorTransport {
  /**
   * 发送消息到编辑器
   * @param {string} sessionId - 会话ID
   * @param {object} message - 消息内容
   * @returns {Promise<void>}
   */
  async send(sessionId, message) {
    throw new Error('IEditorTransport.send() must be implemented')
  }

  /**
   * 接收来自编辑器的消息
   * @param {string} sessionId - 会话ID
   * @returns {Promise<object>}
   */
  async receive(sessionId) {
    throw new Error('IEditorTransport.receive() must be implemented')
  }
}

/**
 * 租约管理接口
 */
export class ILeaseManager {
  /**
   * 申请租约
   * @param {string} resourceId - 资源ID
   * @param {object} options - 租约选项
   * @returns {Promise<{leaseId: string, expiresAt: number}>}
   */
  async acquire(resourceId, options) {
    throw new Error('ILeaseManager.acquire() must be implemented')
  }

  /**
   * 续租
   * @param {string} leaseId - 租约ID
   * @returns {Promise<{expiresAt: number}>}
   */
  async renew(leaseId) {
    throw new Error('ILeaseManager.renew() must be implemented')
  }

  /**
   * 释放租约
   * @param {string} leaseId - 租约ID
   * @returns {Promise<void>}
   */
  async release(leaseId) {
    throw new Error('ILeaseManager.release() must be implemented')
  }
}

export const EditorInterfaces = {
  IEditorHost,
  IEditorTransport,
  ILeaseManager,
}

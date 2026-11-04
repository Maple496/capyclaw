/**
 * 工作区相关接口定义
 */

/**
 * 工作区管理器接口
 */
export class IWorkspaceManager {
  /**
   * 创建工作区
   * @param {string} path - 工作区路径
   * @param {WorkspaceConfig} config - 工作区配置
   * @returns {Promise<Workspace>}
   */
  async create(path, config) {
    throw new Error('IWorkspaceManager.create() must be implemented')
  }

  /**
   * 打开工作区
   * @param {string} path - 工作区路径
   * @returns {Promise<Workspace>}
   */
  async open(path) {
    throw new Error('IWorkspaceManager.open() must be implemented')
  }

  /**
   * 关闭工作区
   * @param {string} workspaceId - 工作区ID
   * @returns {Promise<void>}
   */
  async close(workspaceId) {
    throw new Error('IWorkspaceManager.close() must be implemented')
  }
}

/**
 * 工作区客户端接口
 */
export class IWorkspaceClient {
  /**
   * 读取文件
   * @param {string} path - 文件路径
   * @returns {Promise<string>}
   */
  async readFile(path) {
    throw new Error('IWorkspaceClient.readFile() must be implemented')
  }

  /**
   * 写入文件
   * @param {string} path - 文件路径
   * @param {string} content - 文件内容
   * @returns {Promise<void>}
   */
  async writeFile(path, content) {
    throw new Error('IWorkspaceClient.writeFile() must be implemented')
  }
}

export const WorkspaceInterfaces = {
  IWorkspaceManager,
  IWorkspaceClient,
}

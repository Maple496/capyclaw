/**
 * 资产管理相关接口定义
 */

/**
 * 资产存储接口
 * 
 * 负责资产的存储和检索
 */
export class IAssetStore {
  /**
   * 存储资产
   * @param {Buffer} content - 资产内容
   * @param {string} contentType - 内容类型
   * @returns {Promise<string>} 资产ID (通常是 hash)
   */
  async store(content, contentType) {
    throw new Error('IAssetStore.store() must be implemented')
  }

  /**
   * 检索资产
   * @param {string} assetId - 资产ID
   * @returns {Promise<{content: Buffer, contentType: string}>}
   */
  async retrieve(assetId) {
    throw new Error('IAssetStore.retrieve() must be implemented')
  }

  /**
   * 删除资产
   * @param {string} assetId - 资产ID
   * @returns {Promise<void>}
   */
  async delete(assetId) {
    throw new Error('IAssetStore.delete() must be implemented')
  }

  /**
   * 检查资产是否存在
   * @param {string} assetId - 资产ID
   * @returns {Promise<boolean>}
   */
  async exists(assetId) {
    throw new Error('IAssetStore.exists() must be implemented')
  }
}

/**
 * 资产服务接口
 */
export class IAssetService {
  /**
   * 上传资产
   * @param {Buffer|string} data - 资产数据
   * @param {object} options - 上传选项
   * @returns {Promise<{id: string, url: string}>}
   */
  async upload(data, options) {
    throw new Error('IAssetService.upload() must be implemented')
  }

  /**
   * 获取资产URL
   * @param {string} assetId - 资产ID
   * @returns {string} 资产访问URL
   */
  getUrl(assetId) {
    throw new Error('IAssetService.getUrl() must be implemented')
  }
}

export const AssetInterfaces = {
  IAssetStore,
  IAssetService,
}

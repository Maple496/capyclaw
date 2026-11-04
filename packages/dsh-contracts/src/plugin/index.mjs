/**
 * 插件相关接口定义
 */

/**
 * 插件加载器接口
 * 
 * 负责加载、验证和管理插件
 */
export class IPluginLoader {
  /**
   * 加载插件
   * @param {string} path - 插件路径
   * @returns {Promise<Plugin>} 插件实例
   */
  async load(path) {
    throw new Error('IPluginLoader.load() must be implemented')
  }

  /**
   * 验证插件清单
   * @param {object} manifest - 插件清单
   * @returns {ValidationResult} 验证结果
   */
  validate(manifest) {
    throw new Error('IPluginLoader.validate() must be implemented')
  }

  /**
   * 卸载插件
   * @param {string} pluginId - 插件ID
   * @returns {Promise<void>}
   */
  async unload(pluginId) {
    throw new Error('IPluginLoader.unload() must be implemented')
  }
}

/**
 * 插件验证器接口
 */
export class IPluginValidator {
  /**
   * 验证插件结构
   * @param {string} pluginDir - 插件目录
   * @returns {ValidationResult}
   */
  validateStructure(pluginDir) {
    throw new Error('IPluginValidator.validateStructure() must be implemented')
  }

  /**
   * 验证插件依赖
   * @param {object} manifest - 插件清单
   * @returns {ValidationResult}
   */
  validateDependencies(manifest) {
    throw new Error('IPluginValidator.validateDependencies() must be implemented')
  }
}

/**
 * 导出插件接口
 */
export const PluginInterfaces = {
  IPluginLoader,
  IPluginValidator,
}

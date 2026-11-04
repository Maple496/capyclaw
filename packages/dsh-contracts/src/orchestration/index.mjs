/**
 * Suite 和 Stack 编排相关接口定义
 */

/**
 * Suite 加载器接口
 */
export class ISuiteLoader {
  /**
   * 加载 Suite 清单
   * @param {string} suitePath - Suite 路径
   * @returns {object} Suite 清单和元数据
   */
  loadSuiteManifest(suitePath) {
    throw new Error('ISuiteLoader.loadSuiteManifest() must be implemented')
  }

  /**
   * 验证 Suite 清单
   * @param {object} manifest - Suite 清单
   * @param {object} options - 验证选项
   * @returns {ValidationResult}
   */
  validateSuiteManifest(manifest, options) {
    throw new Error('ISuiteLoader.validateSuiteManifest() must be implemented')
  }

  /**
   * 组合多个 Suites
   * @param {Array} suites - Suite 列表
   * @returns {object} 组合结果
   */
  composeSuites(suites) {
    throw new Error('ISuiteLoader.composeSuites() must be implemented')
  }
}

/**
 * Stack 编译器接口
 */
export class IStackCompiler {
  /**
   * 编译 Stack DSL
   * @param {string} dsl - Stack DSL 文本
   * @param {string} sourcePath - 源文件路径
   * @returns {object} 编译结果
   */
  compile(dsl, sourcePath) {
    throw new Error('IStackCompiler.compile() must be implemented')
  }

  /**
   * 验证编译结果
   * @param {object} compiled - 编译后的 Stack
   * @returns {ValidationResult}
   */
  validate(compiled) {
    throw new Error('IStackCompiler.validate() must be implemented')
  }
}

/**
 * Domain 管理器接口
 */
export class IDomainManager {
  /**
   * 加载 Domain 清单
   * @param {string} domainPath - Domain 路径
   * @returns {object} Domain 清单
   */
  loadDomainManifest(domainPath) {
    throw new Error('IDomainManager.loadDomainManifest() must be implemented')
  }

  /**
   * 验证 Domain 清单
   * @param {object} manifest - Domain 清单
   * @returns {ValidationResult}
   */
  validateDomainManifest(manifest) {
    throw new Error('IDomainManager.validateDomainManifest() must be implemented')
  }

  /**
   * 部署 Domain
   * @param {string} domainPath - Domain 路径
   * @param {string} targetPath - 目标路径
   * @returns {Promise<void>}
   */
  async deployDomain(domainPath, targetPath) {
    throw new Error('IDomainManager.deployDomain() must be implemented')
  }
}

export const OrchestrationInterfaces = {
  ISuiteLoader,
  IStackCompiler,
  IDomainManager,
}

/**
 * 数据契约 - Schema 引用
 * 
 * 导出所有数据契约的引用路径
 */

export const Schemas = {
  // Stack 契约
  stack: '../../../dsh-stack-kit/stack.schema.json',
  
  // Suite 契约
  suite: '../../../dsh-suite-kit/suite.schema.json',
  domain: '../../../dsh-suite-kit/domain.schema.json',
  deployment: '../../../dsh-suite-kit/deployment.schema.json',
  
  // Product 契约
  product: '../../../dsh-assembly-kit/product.schema.json',
  component: '../../../dsh-assembly-kit/component.schema.json',
}

/**
 * 获取 schema 的绝对路径
 * @param {string} schemaName - schema 名称
 * @returns {string} schema 文件的绝对路径
 */
export function getSchemaPath(schemaName) {
  const relativePath = Schemas[schemaName]
  if (!relativePath) {
    throw new Error(`Unknown schema: ${schemaName}`)
  }
  return new URL(relativePath, import.meta.url).pathname
}

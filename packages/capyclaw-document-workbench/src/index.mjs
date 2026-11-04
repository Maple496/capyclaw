/**
 * 通用文档工作台框架（Node 侧）。
 *
 * 浏览器侧请从 `@capyclaw/document-workbench/client` 与
 * `@capyclaw/document-workbench/screenshot` 导入，避免把 node: 依赖带进前端包。
 */
export * from './session/index.mjs'
export * from './ops/index.mjs'
export * from './bridge/index.mjs'

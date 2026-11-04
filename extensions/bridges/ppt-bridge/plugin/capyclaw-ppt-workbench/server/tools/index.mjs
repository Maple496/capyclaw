/** 工具面组合根：能力声明 → 注册表 → 对外导出的唯一入口。 */
import { CAPABILITIES } from './capabilities/index.mjs'
import { createRegistry } from './kernel/registry.mjs'

export { CAPABILITIES, createRegistry }

export const registry = createRegistry(CAPABILITIES)
export const {
  TOOLS,
  TOOL_IMPL,
  TOOL_META,
  FEATURES,
  CAPABILITIES: CAPABILITY_LIST,
} = registry

/**
 * 工具组装：能力 → registry → TOOLS/TOOL_IMPL/契约。
 * relay 与测试都从这里拿工具面。
 */
import { createRegistry } from './kernel/registry.mjs'
import { CAPABILITIES } from './capabilities/index.mjs'

export { createRegistry } from './kernel/registry.mjs'
export { CAPABILITIES } from './capabilities/index.mjs'

export const registry = createRegistry(CAPABILITIES)
export const { TOOLS, TOOL_IMPL, TOOL_META, FEATURES } = registry

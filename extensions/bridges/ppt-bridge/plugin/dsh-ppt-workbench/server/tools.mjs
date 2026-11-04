/** 兼容入口：保持 relay / stdio / tests 的旧 import 路径不变。 */
export {
  TOOLS,
  TOOL_IMPL,
  TOOL_META,
  FEATURES,
  CAPABILITY_LIST,
  CAPABILITIES,
  createRegistry,
  registry,
} from './tools/index.mjs'

/* 旧 tools.mjs 直接 re-export 的工具辅助；能力模块内部不再走这里。 */
export {
  expandRecolorOps,
  resolveColor,
  simpleSlide,
} from './tools/domains/index.mjs'

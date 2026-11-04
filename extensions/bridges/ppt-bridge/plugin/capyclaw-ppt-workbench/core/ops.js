/**
 * 兼容 facade：op 分发已按域拆到 core/ops/*。
 * 外部（editor / keystudio / relay / tests）继续 import { applyOp }。
 */
export {
  applyOp,
  createOpDispatcher,
  OP_DEFINITIONS,
  OP_MODULES,
  OP_NAMES,
  VIEW_OP_NAMES,
} from './ops/index.js'

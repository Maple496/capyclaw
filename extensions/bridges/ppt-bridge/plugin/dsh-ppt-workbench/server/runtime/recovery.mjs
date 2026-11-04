/** 崩溃恢复：通用 replay 由 DocumentSession.recover 提供，本文件只注入 PPT 的 VIEW_OPS。 */
import { VIEW_OPS } from '../constants.mjs'

export async function replayPending({ store, jsonP, applyOp }) {
  return store.recover({
    apply: (cmd) => applyOp(jsonP, cmd),
    isViewOp: (cmd) => VIEW_OPS.has(cmd.op),
  })
}

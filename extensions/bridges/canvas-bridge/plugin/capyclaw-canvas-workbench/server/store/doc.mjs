/** Canvas 会话信封：标准状态来自 @capyclaw/document-workbench，加 doc 字段投影。 */
import {
  applyAck as baseAck,
  applyPush as basePush,
  applyServer as baseServer,
  applyShotRequest as baseShotRequest,
  applyShotResult as baseShotResult,
  applyState as baseState,
  applyUi as baseUi,
  createSessionState,
} from '@capyclaw/document-workbench/session'
import { isEmptyDoc } from '../../core/blocks.js'

export { isEmptyDoc }

/** 会话初始态：文档值只会在编辑器首次 /state 推送后出现在 doc 键下。 */
export const EMPTY_DOC = () => createSessionState({})

export function applyPush(doc, cmds, title, now) {
  return basePush(doc, cmds, title, now)
}

export function applyServer(doc, seq, applied, error, now) {
  return baseServer(doc, seq, applied, error, { now, stateCompact: true })
}

export function applyAck(doc, seq, applied, error, now) {
  return baseAck(doc, seq, applied, error, now)
}

export function applyState(doc, value, seq, now) {
  return baseState(doc, value, seq, { now, documentKey: 'doc' })
}

export function applyUi(doc, cmds, now) {
  return baseUi(doc, cmds, now)
}

export function applyShotRequest(doc, now) {
  return baseShotRequest(doc, now)
}

export function applyShotResult(doc, req, data, now) {
  return baseShotResult(doc, req, data, now)
}

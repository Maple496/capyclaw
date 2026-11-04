/** PPT 兼容层：标准会话信封 + PPT 的 deck 初始文档与标题同步。 */
import {
  applyAck as baseAck,
  applyPush as basePush,
  applyServer as baseServer,
  applyShotRequest as baseShotRequest,
  applyShotResult as baseShotResult,
  applyState as baseState,
  applyUi as baseUi,
  createSessionState,
  pendingOf,
} from '@capyclaw/document-workbench/session'

export const EMPTY_DECK = () => ({ title: '', slides: [] })

export const EMPTY_DOC = () => createSessionState({ title: '' })

export function applyPush(doc, cmds, title, now) {
  return basePush(doc, cmds, title, now)
}

export function applyServer(doc, seq, applied, error, now) {
  return baseServer(doc, seq, applied, error, {
    now,
    stateCompact: true,
    onApplied: (next) => {
      if (next.title && next.deck) next.deck.title = next.title
    },
  })
}

export function applyAck(doc, seq, applied, error, now) {
  return baseAck(doc, seq, applied, error, now)
}

export function applyState(doc, deck, seq, now) {
  return baseState(doc, deck, seq, { now, documentKey: 'deck' })
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

export { pendingOf }

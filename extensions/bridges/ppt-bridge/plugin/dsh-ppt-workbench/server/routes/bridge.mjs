/**
 * PPT 桥端点：协议与路由由 dsh-document-workbench 提供，本文件只注入
 * PPT 的 deck 投影、VIEW_OPS 与 applyOp。
 */
import { createDocumentBridge } from 'dsh-document-workbench/bridge'
import { BASE_PATH, VIEW_OPS } from '../constants.mjs'
import { getTuning } from '../tuning.mjs'
import {
  sanitizeAck, sanitizeClaim, sanitizePush, sanitizeShotResult, sanitizeState,
} from '../store.mjs'

export function createBridgeRoutes({ store, jsonP, applyOp }) {
  const tuning = getTuning()
  return createDocumentBridge({
    session: store,
    basePath: BASE_PATH,
    bridgeName: 'ppt-bridge',
    documentKey: 'deck',
    documentPath: '/deck',
    authority: 'server',
    apply: (cmd) => applyOp(jsonP, cmd),
    isViewOp: (cmd) => VIEW_OPS.has(cmd.op),
    sanitizers: {
      sanitizeAck,
      sanitizeClaim,
      sanitizePush,
      sanitizeShotResult,
      sanitizeState,
    },
    bodyLimitBytes: Number(tuning.bodyLimitBytes) || 10 * 1024 * 1024,
    watch: {
      pollMs: tuning.watchPollMs,
      timeoutSec: tuning.watchTimeoutSec,
      maxTimeoutSec: tuning.watchTimeoutMaxSec,
    },
    projectStatus: (doc) => ({
      bridge: 'ppt-workbench',
      has_deck: !!(doc.deck && Array.isArray(doc.deck.slides) && doc.deck.slides.length),
      slides: doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0,
    }),
    projectDocument: (doc) => ({
      deck: doc.deck || {},
      state_seq: doc.state_seq | 0,
      applied_seq: doc.applied_seq | 0,
    }),
  }).routes
}

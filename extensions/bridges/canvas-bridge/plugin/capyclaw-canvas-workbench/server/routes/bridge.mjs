/**
 * Canvas 桥端点：协议与路由由 @capyclaw/document-workbench 提供，本文件只注入
 * Canvas 的 doc 投影与编辑器权威模式（服务端只排队，编辑器应用后 ack）。
 */
import { createDocumentBridge } from '@capyclaw/document-workbench/bridge'
import { BASE_PATH } from '../constants.mjs'
import { getTuning } from '../tuning.mjs'
import {
  sanitizeAck, sanitizeClaim, sanitizePush, sanitizeShotResult, sanitizeState,
} from '../store.mjs'
import { wordCountOf } from '../../core/doc.js'

export function createBridgeRoutes({ store }) {
  const tuning = getTuning()
  return createDocumentBridge({
    session: store,
    basePath: BASE_PATH,
    bridgeName: 'canvas-bridge',
    documentKey: 'doc',
    documentPath: '/doc',
    authority: 'editor',
    isViewOp: () => false,
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
      bridge: 'canvas-workbench',
      has_doc: !!(doc.doc && Array.isArray(doc.doc.main) && doc.doc.main.length),
      words: wordCountOf(doc.doc),
    }),
    projectDocument: (doc) => ({
      doc: doc.doc || { header: [], main: [], footer: [] },
      state_seq: doc.state_seq | 0,
      applied_seq: doc.applied_seq | 0,
    }),
  }).routes
}

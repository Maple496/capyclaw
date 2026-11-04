/** 桥协议白名单：通用信封来自 @capyclaw/document-workbench，Canvas 只声明 doc 字段与上限。 */
import { createSessionSanitizers } from '@capyclaw/document-workbench/session'

export const MAX_CMDS = 100               // 单队指令条数上限
export const MAX_TOTAL = 8 * 1024 * 1024  // 单队总量上限（字节）
export const MAX_SHOT = 4 * 1024 * 1024   // 截图 dataURL 上限
export const MAX_STATE = 12 * 1024 * 1024 // doc 镜像上限（长文档 + 内嵌 dataURL 图片）

const sanitizers = createSessionSanitizers({
  documentKey: 'doc',
  maxCmds: MAX_CMDS,
  maxTotal: MAX_TOTAL,
  maxShot: MAX_SHOT,
  maxTitle: 120,
  maxError: 2000,
  maxId: 64,
  maxState: MAX_STATE,
})

const {
  sanitizeAck,
  sanitizeClaim,
  sanitizePush,
  sanitizeShotResult,
} = sanitizers

/** /state 上限放宽到 MAX_STATE：文档镜像天然比单队指令大。 */
export function sanitizeState(body) {
  const value = body && body.doc
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (JSON.stringify(body).length > MAX_STATE) return null
  const seq = body.seq
  return {
    value,
    seq: Number.isInteger(seq) && seq >= 0 ? seq : undefined,
  }
}

export { sanitizeAck, sanitizeClaim, sanitizePush, sanitizeShotResult }

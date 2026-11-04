/** 桥协议白名单：通用信封来自 dsh-document-workbench，PPT 只需声明 deck 字段与上限。 */
import { createSessionSanitizers } from 'dsh-document-workbench/session'

export const MAX_CMDS = 100               // 单队指令条数上限
export const MAX_TOTAL = 8 * 1024 * 1024  // 单队总量上限（字节）
export const MAX_SHOT = 4 * 1024 * 1024   // 截图 dataURL 上限

const sanitizers = createSessionSanitizers({
  documentKey: 'deck',
  maxCmds: MAX_CMDS,
  maxTotal: MAX_TOTAL,
  maxShot: MAX_SHOT,
  maxTitle: 120,
  maxError: 2000,
  maxId: 64,
})

const {
  sanitizeAck,
  sanitizeClaim,
  sanitizePush,
  sanitizeShotResult,
  sanitizeState: baseSanitizeState,
} = sanitizers

export { sanitizeAck, sanitizeClaim, sanitizePush, sanitizeShotResult }

/** 兼容旧 API：返回 { deck, seq }；通用 bridge 会把它归一化为 value。 */
export function sanitizeState(body) {
  const data = baseSanitizeState(body)
  return data ? { deck: data.value, seq: data.seq } : null
}

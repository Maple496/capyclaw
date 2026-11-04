/**
 * Canvas 桥存储 facade：通用版本化会话来自 @capyclaw/document-workbench，
 * 本文件只保留 doc 的初始文档与摘要投影。
 */
import { DocumentSession, OWNER_TTL } from '@capyclaw/document-workbench/session'
import { FileBridgeBackend } from './backends/file-backend.mjs'
import { EMPTY_DOC } from './doc.mjs'
import { wordCountOf, elementStats } from '../../core/doc.js'

export * from './sanitize.mjs'
export { OWNER_TTL, FileBridgeBackend }

export class BridgeStore extends DocumentSession {
  constructor(fileOrOptions) {
    let backend
    if (typeof fileOrOptions === 'string') backend = new FileBridgeBackend(fileOrOptions)
    else if (fileOrOptions && fileOrOptions.backend) backend = fileOrOptions.backend
    else throw new Error('BridgeStore 需要 file 路径或 backend')

    super({
      backend,
      initialDoc: EMPTY_DOC(),
      documentKey: 'doc',
      stateCompact: true,
      summary: (doc) => {
        const stats = elementStats(doc.doc)
        return {
          words: wordCountOf(doc.doc),
          elements: stats.text + stats.table + stats.image + stats.other,
        }
      },
      checkpointDocument: () => ({ header: [], main: [], footer: [] }),
    })
  }
}

/**
 * PPT 桥存储 facade：通用版本化会话来自 dsh-document-workbench，
 * 本文件只保留 deck 的初始文档、summary 与标题同步。
 */
import { DocumentSession, OWNER_TTL } from 'dsh-document-workbench/session'
import { FileBridgeBackend } from './backends/file-backend.mjs'
import { EMPTY_DOC } from './doc.mjs'

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
      documentKey: 'deck',
      stateCompact: true,
      summary: (doc) => ({
        title: doc.deck && doc.deck.title ? doc.deck.title : '未命名',
        slides: doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0,
      }),
      checkpointDocument: () => ({ title: '未命名', slides: [] }),
      onApplied: (doc) => {
        if (doc.title && doc.deck) doc.deck.title = doc.title
      },
    })
  }
}

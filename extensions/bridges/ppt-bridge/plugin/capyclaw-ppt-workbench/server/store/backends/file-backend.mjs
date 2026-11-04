/** 文件后端：通用实现来自 dsh-state-service；保留 PPT 的初始文档。 */
import { FileStateBackend } from '../../shared/state-service.mjs'
import { getTuning } from '../../tuning.mjs'
import { EMPTY_DOC } from '../doc.mjs'

export class FileBridgeBackend extends FileStateBackend {
  constructor(file) {
    super(file, {
      initialDoc: EMPTY_DOC(),
      journalMaxBytes: getTuning().journalMaxBytes,
    })
  }
}

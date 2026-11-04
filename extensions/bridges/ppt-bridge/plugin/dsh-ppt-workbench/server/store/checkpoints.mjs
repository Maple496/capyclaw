/** 兼容层：checkpoint 名称与载荷沿用 PPT 字段，底层由 DocumentSession 写入。 */
export { checkpointName } from 'dsh-document-workbench/session'

export function buildCheckpoint(doc, name, meta = {}) {
  const pending = (doc.seq | 0) > (doc.applied_seq | 0)
  const deck = doc.deck || { title: '未命名', slides: [] }
  return {
    name,
    seq: doc.seq | 0,
    appliedSeq: doc.applied_seq | 0,
    pending,
    title: doc.title || deck.title || '未命名',
    slides: Array.isArray(deck.slides) ? deck.slides.length : 0,
    deck,
    meta: meta && typeof meta === 'object' ? meta : {},
    createdAt: new Date().toISOString(),
  }
}

export function listCheckpoints(backend) {
  return backend.listCheckpoints()
}

export function readCheckpoint(backend, name) {
  const payload = backend.readCheckpoint(name)
  if (!payload || !payload.deck) throw new Error('checkpoint 内容损坏: ' + name)
  return payload
}

/** journal：把事件写入 backend（失败不影响主流程）。 */

export function appendJournal(backend, event) {
  backend.appendJournal(event)
}

export function journalTail(backend, limit = 8) {
  return backend.journalTail(limit)
}

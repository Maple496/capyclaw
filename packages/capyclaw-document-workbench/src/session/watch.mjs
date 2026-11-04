/** 长轮询：seq / shot / ui 任一变化即返回。 */

export function watchSession(session, {
  seq = 0,
  shot = 0,
  ui = 0,
  timeoutS,
  isAborted = () => false,
  pollMs = 75,
  timeoutSec = 20,
  maxTimeoutSec = 30,
} = {}) {
  const poll = Math.max(10, Number(pollMs) || 75)
  const maxTimeout = Math.max(1, Number(maxTimeoutSec) || 30)
  const defaultTimeout = Math.max(1, Number(timeoutSec) || 20)
  const timeout = Math.min(Math.max(Number(timeoutS) || defaultTimeout, 1), maxTimeout)

  return new Promise((resolve) => {
    const deadline = Date.now() + timeout * 1000
    const tick = () => {
      if (isAborted()) return resolve(null)
      const doc = session.get()
      if ((doc.seq | 0) !== (seq | 0)
        || (doc.shot_req | 0) !== (shot | 0)
        || (doc.ui_seq | 0) !== (ui | 0)
        || Date.now() > deadline) {
        return resolve(doc)
      }
      setTimeout(tick, poll)
    }
    tick()
  })
}

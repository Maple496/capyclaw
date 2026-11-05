/** 长轮询：seq / shot / ui 任一变化即返回。
 *
 * 唤醒双保险：session 带 subscribe（事件）时变化即时返回——轮询粒度不再
 * 进入延迟路径；pollMs 定时器保留为兜底（事件丢失/老 session 无订阅面）。
 */

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
    let settled = false
    let timer = null
    let unsubscribe = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (unsubscribe) {
        try { unsubscribe() } catch { /* ignore */ }
      }
      resolve(value)
    }

    const changed = (doc) => (doc.seq | 0) !== (seq | 0)
      || (doc.shot_req | 0) !== (shot | 0)
      || (doc.ui_seq | 0) !== (ui | 0)

    const check = () => {
      if (isAborted()) return finish(null)
      const doc = session.get()
      if (changed(doc) || Date.now() > deadline) finish(doc)
    }

    /* 兜底轮询：事件路径正常时每次 tick 都是空检查（微秒级）。 */
    const tick = () => {
      if (settled) return
      check()
      if (!settled) timer = setTimeout(tick, poll)
    }

    if (typeof session.subscribe === 'function') {
      unsubscribe = session.subscribe(() => {
        if (settled) return
        check()
      })
    }
    tick()
  })
}

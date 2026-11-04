/**
 * 「显示即连接」编辑器租约标准模块。
 *
 * 活动权（claim）只存在于内部仲裁；不要把它渲染成 UI 状态。
 * 新打开的窗口强制抢占，旧窗口静默转入待命。
 */
import { tuning } from '../tuning.mjs'

const DEFAULT_TTL = 15 // 秒
const DEFAULT_HEARTBEAT = 3 // 秒（心跳间隔应小于 TTL）

/**
 * 创建编辑器租约仲裁器。
 * @param {{ ttl?: number }} [opts]
 */
export function createEditorLease(opts = {}) {
  const ttl = Number(opts.ttl) || DEFAULT_TTL
  let owner = null // { id, ts }

  return {
    claim(id, force = false) {
      const now = Date.now() / 1000
      if (force || !owner || owner.id === id || now - owner.ts > ttl) {
        owner = { id, ts: now }
        return { ok: true, owner: id }
      }
      return { ok: false, owner: owner.id }
    },

    release(id) {
      if (owner && owner.id === id) owner = null
      return { ok: true }
    },

    isLive() {
      return !!owner && Date.now() / 1000 - owner.ts <= ttl
    },

    status() {
      return owner
        ? { owner: owner.id, age: Math.round((Date.now() / 1000 - owner.ts) * 100) / 100 }
        : null
    },

    async wait(o = {}) {
      const { leaseWaitPollMs: pollMs, leaseWaitTimeoutMs: defaultTimeoutMs } = tuning()
      const deadline = Date.now() + (o.timeoutMs || defaultTimeoutMs)
      while (true) {
        if (this.isLive()) return this.status()
        if (Date.now() >= deadline) {
          const hint = o.openHint ? `（打开 ${o.openHint}）` : ''
          const panel = o.panelHint || '编辑器面板'
          throw new Error(`${panel}尚未连接${hint}。页面加载后会自动连接，无需其他操作。`)
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    },
  }
}

/**
 * 编辑器端自动挂接循环。
 * 首次 claim 强制抢占（后打开者赢），之后静默心跳。
 * @param {{
 *   clientId: string,
 *   claim: (force: boolean) => Promise<boolean>,
 *   release?: () => void,
 *   onActive?: () => void,
 *   onStandby?: () => void,
 *   retryMs?: number,
 *   heartbeatMs?: number,
 *   setInterval?: (cb: () => void) => any,
 *   clearInterval?: (handle: any) => void
 * }} o
 */
export function startAutoAttach(o) {
  if (!o || !o.clientId) throw new Error('startAutoAttach: clientId 必填')
  if (typeof o.claim !== 'function') throw new Error('startAutoAttach: claim 必须是函数')

  const retryMs = o.retryMs || 1000
  const heartbeatMs = o.heartbeatMs || DEFAULT_HEARTBEAT * 1000
  const setI = o.setInterval || ((cb) => setInterval(cb, heartbeatMs))
  const clearI = o.clearInterval || ((handle) => clearInterval(handle))

  let active = false
  let heartbeat = null
  let disposed = false

  async function tryClaim(force) {
    try {
      return await o.claim(force)
    } catch {
      return false
    }
  }

  function goActive() {
    if (active) return
    active = true
    try { o.onActive && o.onActive() } catch { /* 用户回调失败不阻塞挂接 */ }
    heartbeat = setI(async () => {
      if (disposed) return
      const ok = await tryClaim(false)
      if (!ok) goStandby()
    })
  }

  function goStandby() {
    if (!active) return
    active = false
    if (heartbeat != null) {
      clearI(heartbeat)
      heartbeat = null
    }
    try { o.onStandby && o.onStandby() } catch { /* 静默 */ }
  }

  ;(async () => {
    let first = true
    while (!disposed) {
      const ok = await tryClaim(first)
      first = false
      if (ok) {
        goActive()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  })()

  return {
    get active() { return active },
    dispose() {
      disposed = true
      goStandby()
      try { o.release && o.release() } catch { /* 释放失败不阻塞退出 */ }
    },
  }
}

/** 文档 owner 租约：心跳由客户端定期 claim 续约，默认 TTL 10s。 */

export const OWNER_TTL = 10

export function claimOwner(doc, id, force = false, meta = null, now = Date.now() / 1000) {
  const current = doc.owner
  const incomingMeta = meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length
    ? meta
    : null
  const currentMeta = current && current.meta && typeof current.meta === 'object' ? current.meta : null
  const stale = !current || now - (current.ts || 0) > OWNER_TTL

  /* 旧页面（不报 meta/能力）不能用 force 抢走已上报能力的页面；
   * 否则多个残留 tab 会轮流覆盖新编辑器的 state。 */
  if (force && current && current.id !== id && currentMeta && !incomingMeta && !stale) {
    return { ok: false, owner: current.id, changed: false }
  }

  if (force || !current || !current.id || current.id === id || stale) {
    const next = { id, ts: now }
    /* 编辑器能力/版本随 claim 上报：工具可以据此判断“旧页面不支持某 op”。
     * 心跳 worker 只发 {id} 不带 meta，同人续约时必须保留已上报的能力。 */
    const nextMeta = incomingMeta || (current && current.id === id ? current.meta : null)
    if (nextMeta && typeof nextMeta === 'object' && !Array.isArray(nextMeta)) next.meta = nextMeta
    doc.owner = next
    return { ok: true, owner: id, changed: true }
  }
  return { ok: false, owner: current.id, changed: false }
}

export function releaseOwner(doc, id) {
  if (doc.owner && doc.owner.id === id) {
    delete doc.owner
    return true
  }
  return false
}

export function ownerStatus(doc, now = Date.now() / 1000) {
  const owner = doc.owner
  if (!owner || !owner.id) return null
  return {
    id: owner.id,
    age: Math.round((now - (owner.ts || 0)) * 100) / 100,
    ...(owner.meta ? { meta: owner.meta } : {}),
  }
}

/**
 * 技能瘦客户端：把「技能服务」的 HTTP 面适配成原 ctx.skills 的进程内形状。
 *
 * 技能内容（SKILL.md 正文）不再通过 ctx.skills.registerProvider 进程内注册，
 * 而是从独立技能服务拉取——dsh 进程里只剩这一个瘦适配层。
 * 服务端形状见 bridges/ppt-bridge/dsh-skills-service（GET /skills、GET /skills/:name）。
 */
export function createSkillsClient(baseUrl) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  return {
    api: { name: 'skills', version: '1.0.0', kind: 'thin-client' },
    async list(signal) {
      const res = await fetch(`${root}/skills`, { signal: signal ?? AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`skills list HTTP ${res.status}`)
      const body = await res.json()
      return Array.isArray(body?.skills) ? body.skills : []
    },
    async get(candidate, options = {}) {
      const name = typeof candidate === 'string' ? candidate : candidate?.name
      if (!name) throw new Error('skills get: 缺 name')
      const res = await fetch(`${root}/skills/${encodeURIComponent(name)}`, {
        signal: options.signal ?? AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`未知 skill ${name}（HTTP ${res.status}）`)
      return res.json()
    },
  }
}

/**
 * ddr0 临时 Key 服务客户端（纯函数，fetch 可注入便于测试）。
 *
 * 服务端契约（applications/port-8217，公网经 https://ddr0.com/apps/port/8217/）：
 * - GET  /api/me          → 登录态校验 + 钱包/积分（403 = 未登录/非人类账号）
 * - POST /api/keys/issue  → { ttl_seconds?, idempotency_key? } 签发临时 Key
 *   鉴权：cookie > X-Session-Token > Bearer（主站 auth_sessions 会话 token）
 *   明文 Key 只返回一次（8214 只存哈希）；计费：按 TTL×费率预扣积分，
 *   到期按真实用量多退少补（流水 kind：llm_hold / llm_settle / llm_refund）。
 */

/** 拼接 base 与路径（容忍尾部斜杠）。 */
export function joinBase(base) {
  return String(base || '').replace(/\/+$/, '')
}

/**
 * 通用请求。返回 { ok, status, data }；网络错误返回 { ok:false, status:0, data:{message} }。
 * @param fetchImpl - 可注入的 fetch（默认 globalThis.fetch）。
 */
export async function request(method, url, { token, body, timeoutMs = 15000, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    let data = null
    const text = await res.text()
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 200) } }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    const message = error && error.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String(error)
    return { ok: false, status: 0, data: { message } }
  } finally {
    clearTimeout(timer)
  }
}

/** 登录态校验 + 钱包/积分。ok=true 时 data = { user_id, pool_id, wallet, points{balance,...} }。 */
export async function me(base, token, opts = {}) {
  return request('GET', `${joinBase(base)}/api/me`, { token, ...opts })
}

/** 签发临时 Key。ok=true 时 data 至少含 { api_key, key_prefix, expires_at, hold_id, held_points }。 */
export async function issue(base, token, { ttlSeconds, idempotencyKey } = {}, opts = {}) {
  const body = {}
  if (ttlSeconds !== undefined) body.ttl_seconds = ttlSeconds
  if (idempotencyKey) body.idempotency_key = idempotencyKey
  return request('POST', `${joinBase(base)}/api/keys/issue`, { token, body, ...opts })
}

/**
 * 平台 LLM 配置下发（apikey 之外的 url/model 也找平台要；P3 平台契约）：
 * GET /api/llm/config → { base_url, models:[{id,name?}], ttl_seconds? }
 * 平台未实现（404）时客户端必须回退本地静态配置，不得报错中断。
 */
export async function llmConfig(base, token, opts = {}) {
  return request('GET', `${joinBase(base)}/api/llm/config`, { token, ...opts })
}

/** 会话快照发现（解耦标准）：从本机网关拉会话 token 快照。
 *  契约：GET {url} → {logged_in, token, token_name?, username?}（网关侧
 *  仅回环监听并自校验对端地址；本插件不做任何鉴权假设）。 */
export async function discoverToken(url, opts = {}) {
  return request('GET', url, { timeoutMs: 8000, ...opts })
}

/** 积分余额速查（/api/me 的 points.balance）。 */
export function balanceOf(meData) {
  return meData && meData.points && typeof meData.points.balance === 'number' ? meData.points.balance : null
}

/** 生成签发幂等键（dsh 前缀 + 时间 + 随机，服务端上限 64 字符）。 */
export function newIdempotencyKey(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8)
  return `dsh-${now}-${rand}`.slice(0, 64)
}

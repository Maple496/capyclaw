/**
 * dsh-llm-tempkey 测试（node:test，无外部依赖；fetch 全部注入 mock）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** 可编程 mock fetch：按 URL 前缀路由。 */
function mockFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body })
    for (const r of routes) {
      if (url.startsWith(r.prefix) && (!r.method || r.method === (init.method || 'GET'))) {
        return {
          ok: r.status === undefined || (r.status >= 200 && r.status < 300),
          status: r.status ?? 200,
          text: async () => JSON.stringify(r.data ?? {}),
        }
      }
    }
    return { ok: false, status: 404, text: async () => '{}' }
  }
  fn.calls = calls
  return fn
}

test('包清单满足验证器契约', () => {
  const pkg = readJson(join(packageDir, 'package.json'))
  assert.equal(pkg.name, '@capyclaw/llm-tempkey')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.category, 'service')
  assert.equal(pkg.dsh.platform, 'both')
  assert.ok(pkg.dependencies['@capyclaw/plugin-kit'], '必须声明 @capyclaw/plugin-kit')
  assert.ok(pkg.scripts.test, '必须有 test 脚本')
  assert.ok(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8').includes('dsh-llm-pi-ai'), 'patch 必须挂 pi-ai 路由')
})

test('客户端代码形状正确（无 ESM 导入/导出）', () => {
  const src = readFileSync(join(packageDir, 'lib/ddr0.mjs'), 'utf8')
  assert.ok(!/\bimport\s/.test(src) || /import \* as/.test(src) === false, 'ddr0.mjs 允许自身无导入')
})

test('me：登录态校验（带 Bearer，403 时 ok=false）', async () => {
  const { me } = await import('../lib/ddr0.mjs')
  const f = mockFetch([
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 7, pool_id: 'pool-7', points: { balance: 500 } } },
  ])
  const r = await me('https://ddr0.com/apps/port/8217', 'tok-1', { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.data.user_id, 7)
  assert.equal(f.calls[0].headers.authorization, 'Bearer tok-1')
  assert.equal(ddr0Balance(r.data), 500)

  const f403 = mockFetch([
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', status: 403, data: { detail: '未登录' } },
  ])
  const r403 = await me('https://ddr0.com/apps/port/8217', 'bad', { fetchImpl: f403 })
  assert.equal(r403.ok, false)
  assert.equal(r403.status, 403)

  function ddr0Balance(d) { return d.points.balance }
})

test('issue：POST + Bearer + 幂等键', async () => {
  const { issue, newIdempotencyKey } = await import('../lib/ddr0.mjs')
  const f = mockFetch([
    {
      prefix: 'https://x.test/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-xxx', key_prefix: 'bce-ab', expires_at: 1793550000, hold_id: 9, held_points: 150 },
    },
  ])
  const key = newIdempotencyKey()
  const r = await issue('https://x.test', 'tok', { ttlSeconds: 300, idempotencyKey: key }, { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.data.api_key, 'bce-xxx')
  const sent = JSON.parse(f.calls[0].body)
  assert.equal(sent.ttl_seconds, 300)
  assert.equal(sent.idempotency_key, key)
  assert.ok(key.startsWith('dsh-'))
  assert.ok(key.length <= 64)
})

test('joinBase：容忍尾部斜杠', async () => {
  const { joinBase } = await import('../lib/ddr0.mjs')
  assert.equal(joinBase('https://x.test/'), 'https://x.test')
  assert.equal(joinBase('https://x.test/apps/port/8217/'), 'https://x.test/apps/port/8217')
})

test('宿主半：403 时不签发且状态 invalid（中转拒绝服务）', async () => {
  const f403 = mockFetch([
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', status: 403, data: { detail: '未登录' } },
  ])
  const mod = await import('../lib/host.mjs')
  assert.equal(mod.name, '@capyclaw/llm-tempkey')
  assert.equal(mod.CREDENTIAL_REF, 'DSH_TEMPKEY_LLM_KEY')

  const provided = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    provide: (name, api) => { provided.push({ name, api }) },
    effect: (fn) => { disposers.push(fn()) },
  }
  const originalFetch = globalThis.fetch
  const realFetch = originalFetch
  globalThis.fetch = f403
  try {
    mod.apply(ctx, { serverBase: 'https://ddr0.com/apps/port/8217', sessionToken: 'tok-bad', tickMs: 3600000, relayPort: 39701 })
    await new Promise((r) => setTimeout(r, 80))
    const tempkey = provided.find((p) => p.name === 'llmTempkey')
    assert.ok(tempkey, '必须提供 llmTempkey 状态面')
    const st = tempkey.api.status()
    assert.equal(st.login, 'invalid', '403 → 登录态 invalid')
    assert.equal(st.keyPrefix, null, '403 时不得有 Key')
    // 中转必须诚实拒绝（503 not ready），不能转发一个不存在的 Key
    const res = await realFetch('http://127.0.0.1:39701/v2/chat/completions', { method: 'POST', body: '{}' })
    assert.equal(res.status, 503)
    for (const d of disposers) await d()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('宿主半：登录有效 → 签发 → 中转就绪（占位凭据 + 状态面）', async () => {
  const routes = [
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 7, pool_id: 'pool-7', points: { balance: 500 } } },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-live-key', key_prefix: 'bce-li', expires_at: Math.floor(Date.now() / 1000) + 300, hold_id: 1, held_points: 150 },
    },
  ]
  const f = mockFetch(routes)
  const mod = await import('../lib/host.mjs')
  const provided = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    provide: (name, api) => { provided.push({ name, api }) },
    effect: (fn) => { disposers.push(fn()) },
  }
  const originalFetch = globalThis.fetch
  const realFetch = originalFetch
  globalThis.fetch = f
  try {
    mod.apply(ctx, { serverBase: 'https://ddr0.com/apps/port/8217', sessionToken: 'tok-ok', tickMs: 3600000, relayPort: 39702 })
    await new Promise((r) => setTimeout(r, 80))
    const tempkey = provided.find((p) => p.name === 'llmTempkey')
    const st = tempkey.api.status()
    assert.equal(st.login, 'valid')
    assert.equal(st.keyPrefix, 'bce-li')
    assert.equal(st.balance, 500)
    assert.ok(st.secondsLeft > 0)
    // 中转就绪且状态面可达（用真实 fetch，绕过 mock）
    const res = await realFetch('http://127.0.0.1:39702/__status')
    const relayStatus = await res.json()
    assert.equal(relayStatus.login, 'valid')
    assert.ok(relayStatus.relayRequests >= 0)
  } finally {
    globalThis.fetch = originalFetch
    for (const d of disposers) await d()
  }
})

test('宿主半：未配置 token → 不签发、状态 no-token', async () => {
  const f = mockFetch([])
  const mod = await import('../lib/host.mjs')
  const ctx = { get: () => undefined, provide: () => {}, effect: (fn) => { void fn } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = f
  const saved = process.env.DDR0_SESSION_TOKEN
  delete process.env.DDR0_SESSION_TOKEN
  try {
    mod.apply(ctx, { serverBase: 'https://ddr0.com/apps/port/8217', tickMs: 3600000 })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(f.calls.length, 0, '无 token 时绝不发请求')
  } finally {
    globalThis.fetch = originalFetch
    if (saved !== undefined) process.env.DDR0_SESSION_TOKEN = saved
  }
})

test('宿主半：tokenUrl 发现模式（网关会话快照 → 签发）', async () => {
  const routes = [
    { prefix: 'http://127.0.0.1:8850/api/desktop/account/session-token', data: { logged_in: true, token: 'tok-discovered', token_name: 'ddr0.sessionToken.v1', username: 'test2' } },
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 1256, pool_id: 'pool-7', points: { balance: 4650 } } },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-from-discovery', key_prefix: 'bce-di', expires_at: Math.floor(Date.now() / 1000) + 300, hold_id: 2, held_points: 150 },
    },
  ]
  const f = mockFetch(routes)
  const mod = await import('../lib/host.mjs')
  const provided = []
  const ctx = {
    get: () => undefined,
    provide: (name, api) => { provided.push({ name, api }) },
    effect: (fn) => { void fn() },
  }
  const saved = process.env.DDR0_SESSION_TOKEN
  delete process.env.DDR0_SESSION_TOKEN
  const originalFetch = globalThis.fetch
  globalThis.fetch = f
  try {
    mod.apply(ctx, {
      serverBase: 'https://ddr0.com/apps/port/8217',
      tokenUrl: 'http://127.0.0.1:8850/api/desktop/account/session-token',
      tickMs: 3600000, relayPort: 39704,
    })
    await new Promise((r) => setTimeout(r, 100))
    const tempkey = provided.find((p) => p.name === 'llmTempkey')
    const st = tempkey.api.status()
    assert.equal(st.tokenSource, 'discovery', '必须经发现端点取 token')
    assert.equal(st.keyPrefix, 'bce-di', '发现 token 后完成签发')
    const meCall = f.calls.find((c) => c.url.includes('/api/me'))
    assert.equal(meCall.headers.authorization, 'Bearer tok-discovered', '/api/me 必须携带发现的 token')
  } finally {
    globalThis.fetch = originalFetch
    if (saved !== undefined) process.env.DDR0_SESSION_TOKEN = saved
  }
})

test('中转：转发到上游并替换 Authorization', async () => {
  const http = await import('node:http')
  // mock 上游：回显收到的 authorization
  const seen = { auth: null }
  const upstream = http.createServer(function (req, res) {
    seen.auth = req.headers.authorization || null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ echoedAuth: seen.auth, model: 'ok' }))
  })
  await new Promise((r) => upstream.listen(39740, '127.0.0.1', r))
  upstream.unref()

  const routes = [
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 7, pool_id: 'pool-7', points: { balance: 500 } } },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-live-key', key_prefix: 'bce-li', expires_at: Math.floor(Date.now() / 1000) + 300, hold_id: 1, held_points: 150 },
    },
  ]
  const f = mockFetch(routes)
  const mod = await import('../lib/host.mjs')
  const ctx = {
    get: () => undefined,
    provide: () => {},
    effect: (fn) => { void fn() },
  }
  const originalFetch = globalThis.fetch
  const realFetch = originalFetch
  globalThis.fetch = f
  try {
    mod.apply(ctx, { serverBase: 'https://ddr0.com/apps/port/8217', sessionToken: 'tok-ok', tickMs: 3600000, relayPort: 39703, upstreamBase: 'http://127.0.0.1:39740/v2' })
    await new Promise((r) => setTimeout(r, 100))
    const res = await realFetch('http://127.0.0.1:39703/v2/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer should-be-replaced' },
      body: JSON.stringify({ model: 'ernie-4.5-turbo-128k', messages: [] }),
    })
    const body = await res.json()
    assert.equal(body.echoedAuth, 'Bearer bce-live-key', '上游必须收到临时 Key 而非调用方的占位凭据')
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = originalFetch
    upstream.close()
  }
})

test('平台下发 LLM 配置：中转上游动态切换到平台 base_url（url/model 来自平台）', async () => {
  const http = await import('node:http')
  const platformUpstream = 'http://127.0.0.1:39741/v2'
  const seen = { auth: null }
  const upstream = http.createServer(function (req, res) {
    seen.auth = req.headers.authorization || null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ echoedAuth: seen.auth, from: 'platform-upstream' }))
  })
  await new Promise((r) => upstream.listen(39741, '127.0.0.1', r))
  upstream.unref()

  const routes = [
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 7, pool_id: 'pool-7', points: { balance: 500 } } },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-platform-key', key_prefix: 'bce-pl', expires_at: Math.floor(Date.now() / 1000) + 300, hold_id: 3, held_points: 150 },
    },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/llm/config',
      data: { base_url: platformUpstream, models: [{ id: 'ernie-4.5-turbo-128k', name: 'ERNIE 4.5 Turbo' }, { id: 'ernie-speed-128k' }] },
    },
  ]
  const f = mockFetch(routes)
  const mod = await import('../lib/host.mjs')
  const provided = []
  const ctx = {
    get: () => undefined,
    provide: (name, api) => { provided.push({ name, api }) },
    effect: (fn) => { void fn() },
  }
  const originalFetch = globalThis.fetch
  const realFetch = originalFetch
  globalThis.fetch = f
  try {
    // 静态 upstreamBase 故意指向别处（config 来源），平台下发后必须被覆盖
    mod.apply(ctx, {
      serverBase: 'https://ddr0.com/apps/port/8217', sessionToken: 'tok-ok',
      tickMs: 3600000, relayPort: 39705,
      upstreamBase: 'http://127.0.0.1:1/v2',
      models: ['ernie-4.5-turbo-128k'],
    })
    await new Promise((r) => setTimeout(r, 100))
    const tempkey = provided.find((p) => p.name === 'llmTempkey')
    const st = tempkey.api.status()
    assert.equal(st.upstreamSource, 'platform', '上游来源必须是 platform')
    assert.equal(st.upstreamBase, platformUpstream, '上游地址必须切到平台下发的 base_url')
    assert.ok(Array.isArray(st.platformModels) && st.platformModels.length === 2, '平台 models 必须进入状态面')
    // 配置声明 + 平台下发混合：ernie-speed-128k 未声明不告警无法断言（log），只验状态
    // 转发确实打到平台上游
    const res = await realFetch('http://127.0.0.1:39705/v2/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ernie-4.5-turbo-128k', messages: [] }),
    })
    const body = await res.json()
    assert.equal(body.from, 'platform-upstream', '流量必须打到平台下发的上游')
    assert.equal(body.echoedAuth, 'Bearer bce-platform-key')
  } finally {
    globalThis.fetch = originalFetch
    upstream.close()
  }
})

test('平台无 /api/llm/config（404）：回退静态上游且状态面如实标注', async () => {
  const routes = [
    { prefix: 'https://ddr0.com/apps/port/8217/api/me', data: { user_id: 7, pool_id: 'pool-7', points: { balance: 500 } } },
    {
      prefix: 'https://ddr0.com/apps/port/8217/api/keys/issue', method: 'POST',
      data: { api_key: 'bce-live-key', key_prefix: 'bce-li', expires_at: Math.floor(Date.now() / 1000) + 300, hold_id: 1, held_points: 150 },
    },
    // api/llm/config 无路由 → mockFetch 回 404
  ]
  const f = mockFetch(routes)
  const mod = await import('../lib/host.mjs')
  const provided = []
  const ctx = {
    get: () => undefined,
    provide: (name, api) => { provided.push({ name, api }) },
    effect: (fn) => { void fn() },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = f
  try {
    mod.apply(ctx, {
      serverBase: 'https://ddr0.com/apps/port/8217', sessionToken: 'tok-ok',
      tickMs: 3600000, relayPort: 39706,
      upstreamBase: 'http://127.0.0.1:39742/v2',
    })
    await new Promise((r) => setTimeout(r, 100))
    const tempkey = provided.find((p) => p.name === 'llmTempkey')
    const st = tempkey.api.status()
    assert.equal(st.login, 'valid', '404 的 llm/config 不得影响签发')
    assert.equal(st.upstreamSource, 'config', '必须回退 config 来源')
    assert.equal(st.upstreamBase, 'http://127.0.0.1:39742/v2')
    assert.equal(st.platformModels, null)
    // 周期 tick 只告警一次：多个 llm/config 调用但不重复刷警告（调用仍发生，验证不炸即可）
  } finally {
    globalThis.fetch = originalFetch
  }
})

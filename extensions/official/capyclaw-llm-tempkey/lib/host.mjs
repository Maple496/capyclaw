/**
 * dsh-llm-tempkey 宿主半（Cordis 入口）。
 *
 * 职责（全部运行时外部获取，不写死任何 Key）：
 * 1. 登录态校验：GET /api/me（Bearer = 主站 auth_sessions 会话 token）。
 *    未配置 token / 403 → 状态置 invalid 并退避重试，绝不签发。
 * 2. 签发临时 Key：POST /api/keys/issue（计费中间层按 TTL 预扣积分，
 *    到期按真实用量多退少补）。明文 Key 只返回一次。
 * 3. 轮换：expires_at - refreshMargin 时自动签发新 Key，替换中转的上行凭据。
 * 4. 注入 dsh：内置 **loopback 中转**（127.0.0.1:relayPort，OpenAI 兼容
 *    /v2/chat/completions + /v2/models），dsh 的 pi-ai 路由静态指向它；
 *    Key 轮换发生在中转内部，对 dsh 完全透明（不碰 credentials 服务与
 *    环境快照，零集成面）。上游 401（Key 过期/失效）时自动换新并重试一次。
 * 5. 平台下发 url/model：GET /api/llm/config（P3 契约）成功则中转上游动态
 *    切换并对账模型声明；404/失败回退静态 upstreamBase——apikey/url/model
 *    最终全部来自平台，本地配置只是回退。
 * 路由本体（models）声明在本插件 cordis.patch.yml 的 dsh-llm-pi-ai 行。
 */
import http from 'node:http'
import https from 'node:https'
import * as ddr0 from './ddr0.mjs'
import { tuning } from './tuning.mjs'
import { decide, shouldForceRefreshOn401 } from './rotation-policy.mjs'
import { resolveConfig } from '@capyclaw/plugin-kit/config'

export const name = '@capyclaw/llm-tempkey'

/** 注入 dsh 的凭据引用名（必须与本插件 cordis.patch.yml 里 pi-ai 路由的 apiKeyEnv 一致）。 */
export const CREDENTIAL_REF = 'DSH_TEMPKEY_LLM_KEY'

function clamp(n, lo, hi, dflt) {
  const v = Number(n)
  if (!Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, v))
}

export function apply(ctx, config = {}) {
  // 调优层（进化搜索固化的基线）；解析顺序：ctx config → 环境变量 → 基线/默认值
  const T = tuning()
  const { value: cfg, issues: cfgIssues } = resolveConfig(config, {
    envPrefix: 'DSH_TEMPKEY',
    defaults: {
      serverBase: 'https://ddr0.com/apps/port/8217',
      tokenEnv: 'DDR0_SESSION_TOKEN',
      apiKeyEnvRef: CREDENTIAL_REF,
      relayPort: 39610,
      upstreamBase: 'https://qianfan.baidubce.com/v2',
    },
    fields: {
      serverBase: { env: 'SERVER_BASE', type: 'url' },
      tokenEnv: { env: 'TOKEN_ENV' },
      apiKeyEnvRef: { env: 'API_KEY_ENV_REF' },
      relayPort: { env: 'RELAY_PORT', type: 'port' },
      upstreamBase: { env: 'UPSTREAM_BASE', type: 'url' },
    },
  })
  if (cfgIssues.length && ctx?.logger?.warn) {
    for (const issue of cfgIssues) ctx.logger.warn(`[llm-tempkey] 配置: ${issue}`)
  }
  const serverBase = String(cfg.serverBase)
  const tokenEnv = String(cfg.tokenEnv)
  const ref = String(cfg.apiKeyEnvRef)
  const ttl = clamp(config.ttlSeconds ?? T.ttlSeconds, 300, 3600, T.ttlSeconds)
  const margin = clamp(config.refreshMarginSeconds ?? T.refreshMarginSeconds, 15, Math.floor(ttl / 2), T.refreshMarginSeconds)
  const tickMs = clamp(config.tickMs ?? T.tickMs, 5000, 300000, T.tickMs)
  const propagationMs = clamp(config.propagationMs ?? T.propagationMs, 5000, 600000, T.propagationMs)
  const upstreamTimeoutMs = clamp(config.upstreamTimeoutMs ?? T.upstreamTimeoutMs, 15000, 600000, T.upstreamTimeoutMs)
  const issueBackoffBaseMs = clamp(T.issueBackoffBaseMs, 500, 60000, 2000)
  const issueBackoffMaxMs = clamp(T.issueBackoffMaxMs, 30000, 600000, 300000)
  const relayPort = clamp(cfg.relayPort, 1024, 65535, 39610)
  // 上游 base 优先来自平台 /api/llm/config 下发（见 refreshLlmConfig）；此静态值为回退/缺省

  /** 实例状态：随 apply 作用域（多实例安全；不在模块级共享）。 */
  const state = {
    login: 'unknown', // unknown | no-token | invalid | valid
    tokenSource: 'unknown', // config | discovery | discovery-empty | env | none
    userId: null,
    balance: null,
    keyPrefix: null,
    apiKey: null,
    expiresAt: 0,
    lastError: null,
    lastIssueAt: 0,
    relayRequests: 0,
    upstreamBase: String(config.upstreamBase || 'https://qianfan.baidubce.com/v2').replace(/\/+$/, ''),
    upstreamSource: 'config', // config | platform（url/model 是否来自平台下发）
    platformModels: null, // 平台下发的 models（[{id,name?}]）；null = 未见平台下发
  }

  /** 会话 token 三级解析（解耦标准）。tokenUrl = 本机网关的会话快照端点。 */
  const tokenUrl = String(config.tokenUrl || '')

  function log(...args) {
    console.log('[dsh-llm-tempkey]', ...args)
  }
  function warn(...args) {
    console.warn('[dsh-llm-tempkey]', ...args)
  }


  /** 登录态校验 + 按需签发/轮换。force=true 时无视剩余有效期强制换新。返回是否处于可用状态。 */
  async function ensureKey(reason, force = false) {
    // 三级解析：config.sessionToken → tokenUrl（本机网关发现）→ tokenEnv
    let token = typeof config.sessionToken === 'string' ? config.sessionToken.trim() : ''
    let source = token ? 'config' : ''
    if (!token && tokenUrl) {
      const r = await ddr0.discoverToken(tokenUrl)
      if (r.ok && r.data && typeof r.data.token === 'string' && r.data.token) {
        token = r.data.token
        source = 'discovery'
      } else {
        source = 'discovery-empty'
      }
    }
    if (!token) {
      token = process.env[tokenEnv] || ''
      if (token) source = 'env'
    }
    state.tokenSource = source
    if (!token) {
      state.login = 'no-token'
      state.lastError = source === 'discovery-empty'
        ? `登录态发现端点未返回 token（网关未登录或不可达）：${tokenUrl}`
        : `未配置会话 token（config.sessionToken / config.tokenUrl / 环境变量 ${tokenEnv}）`
      return false
    }
    // 1) 登录态校验（403 = 未登录/会话过期 → 停止签发，等 token 更新）
    const me = await ddr0.me(serverBase, token)
    if (!me.ok) {
      state.login = me.status === 403 ? 'invalid' : 'unknown'
      state.lastError = `登录态校验失败（${reason}）: HTTP ${me.status}`
      if (me.status === 403) {
        // 会话失效：丢弃本地 Key 引用，避免拿失效 Key 静默失败
        state.apiKey = null
        state.expiresAt = 0
        warn(`登录态无效（HTTP 403），已停止签发。请更新 ${tokenEnv} 后等待自动恢复`)
      }
      return false
    }
    state.login = 'valid'
    state.userId = me.data && me.data.user_id
    state.balance = ddr0.balanceOf(me.data)

    // 1.5) 平台 LLM 配置下发（url/model）：成功则中转上游动态切换，失败/404 回退静态
    await refreshLlmConfig(token)

    // 2) Key 仍在轮换窗口外且非强制 → 无事（策略判定与进化评估器共用同一纯函数）
    if (!force && decide({ apiKey: state.apiKey, expiresAt: state.expiresAt, now: Date.now() }, Date.now(), { ttlSeconds: ttl, refreshMarginSeconds: margin }) === 'reuse') return true

    // 3) 签发/轮换
    const idem = ddr0.newIdempotencyKey()
    const issued = await ddr0.issue(serverBase, token, { ttlSeconds: ttl, idempotencyKey: idem })
    if (!issued.ok) {
      state.lastError = `签发失败（${reason}）: HTTP ${issued.status}`
      if (issued.status === 403) state.login = 'invalid'
      warn(state.lastError, issued.data && issued.data.detail ? `— ${issued.data.detail}` : '')
      return false
    }
    const data = issued.data || {}
    if (!data.api_key) {
      state.lastError = '签发响应缺 api_key（服务端已保证冲正）'
      warn(state.lastError)
      return false
    }
    state.apiKey = data.api_key
    state.keyPrefix = String(data.key_prefix || '')
    state.expiresAt = Number(data.expires_at || 0) * 1000
    state.lastIssueAt = Date.now()
    log(`临时Key已签发 prefix=${state.keyPrefix}*** 到期=${new Date(state.expiresAt).toLocaleString('zh-CN')} 预扣=${data.held_points}积分 TTL=${ttl}s（ref=${idem.slice(0, 18)}…）`)
    return true
  }

  /** 平台 LLM 配置下发（url/model）：成功 → 中转上游动态切换并对账模型声明；
   *  404（平台未上线）→ 安静回退静态配置；其他失败 → 告警一次后沿用静态。
   *  "apikey/url/model 全部来自平台" 的目标由这里落地——平台端实现契约后客户端零改动生效。 */
  let llmConfigWarned = false
  async function refreshLlmConfig(token) {
    const r = await ddr0.llmConfig(serverBase, token)
    if (r.ok && r.data && typeof r.data.base_url === 'string' && r.data.base_url) {
      const next = String(r.data.base_url).replace(/\/+$/, '')
      if (next !== state.upstreamBase) {
        log(`平台下发 LLM 上游: ${state.upstreamBase} → ${next}`)
        state.upstreamBase = next
      }
      state.platformModels = Array.isArray(r.data.models)
        ? r.data.models.filter((item) => item && typeof item.id === 'string')
        : []
      state.upstreamSource = 'platform'
      llmConfigWarned = false
      // 对账：cordis 静态声明的模型若不在平台下发列表，转发时可能被上游拒绝
      const declared = Array.isArray(config.models) ? config.models.map(String) : null
      if (declared) {
        const platformIds = state.platformModels.map((item) => item.id)
        for (const id of declared) {
          if (!platformIds.includes(id)) {
            warn(`静态声明的模型 ${id} 不在平台下发列表（[${platformIds.join(', ') || '空'}]），该模型请求可能被上游拒绝`)
          }
        }
      }
      return true
    }
    state.upstreamSource = 'config'
    state.platformModels = null
    if (!llmConfigWarned) {
      llmConfigWarned = true
      if (r.status === 404) log(`平台未提供 /api/llm/config（404），使用静态上游 ${state.upstreamBase}`)
      else warn(`平台 LLM 配置获取失败（HTTP ${r.status}），回退静态上游 ${state.upstreamBase}`)
    }
    return false
  }

  /** 中转：把 /v2/* 转发到上游，Authorization 替换为当前临时 Key。
   *  中转绝不允许抛出未捕获异常——它跑在 dsh 主进程里。 */
  function proxyToUpstream(req, res, attempt = 0) {
    try {
      state.relayRequests += 1
      if (!state.apiKey) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'temp key not ready', login: state.login, lastError: state.lastError }))
        return
      }
      const upstream = new URL(state.upstreamBase + req.url.replace(/^\/v2/, ''))
      const transport = upstream.protocol === 'https:' ? https : http
      const headers = { ...req.headers }
      // 只换 host 与鉴权；content-length 必须保留（body 原样透传，上游不接受 chunked 空体）
      delete headers.host
      headers.authorization = `Bearer ${state.apiKey}`
      let upstreamReq
      try {
        log(`forward → ${req.method} ${upstream.href} (attempt ${attempt})`)
        upstreamReq = transport.request(upstream, { method: req.method, headers }, (upstreamRes) => {
          log(`← upstream ${upstreamRes.statusCode} (${req.url})`)
          // Key 失效（401）：区分"刚签发未生效"（宽限内诚实回 401，避免千帆侧
          // 对重复坏鉴权限流挂起）与"签发已久仍 401"（Key 确实失效 → 强制换新重试一次）
          if (upstreamRes.statusCode === 401 && attempt === 0) {
            upstreamRes.resume()
            // 策略判定与评估器共用：宽限内诚实回 401；超过宽限强制换新
            if (!shouldForceRefreshOn401(state.lastIssueAt, Date.now(), propagationMs)) {
              const keyAge = state.lastIssueAt ? Date.now() - state.lastIssueAt : 0
              warn(`上游 401 但 Key 仅签发 ${Math.round(keyAge / 1000)}s（宽限内），回 401 给调用方`)
              res.writeHead(401, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'upstream rejected temp key (grace period)', hint: '等 Key 传播或检查服务端 IAM 配置' }))
              return
            }
            void ensureKey('relay-401', true).then(function (ok) {
              if (ok) proxyToUpstream(req, res, 1)
              else {
                res.writeHead(502, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: 'upstream 401 and re-issue failed', login: state.login }))
              }
            }).catch(function (error) {
              if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 're-issue crashed', message: String(error).slice(0, 120) }))
            })
            return
          }
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        })
      } catch (error) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream request create failed', message: String(error).slice(0, 120) }))
        return
      }
      upstreamReq.on('error', function (error) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' })
        }
        res.end(JSON.stringify({ error: 'upstream request failed', message: String(error).slice(0, 120) }))
      })
      req.on('error', function () { upstreamReq.destroy() })
      req.pipe(upstreamReq)
    } catch (error) {
      // 最后一道闸：中转的任何异常都不允许波及 dsh 主进程
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'relay internal error', message: String(error).slice(0, 120) }))
      } catch { /* 连接已断 */ }
    }
  }

  /** loopback 中转服务（仅 127.0.0.1）。 */
  const relay = http.createServer(function (req, res) {
    try {
      if (req.url === '/__status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status()))
        return
      }
      if (!req.url.startsWith('/v2/')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      proxyToUpstream(req, res)
    } catch (error) {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'relay internal error', message: String(error).slice(0, 120) }))
      } catch { /* 连接已断 */ }
    }
  })
  relay.on('clientError', function (error, socket) {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* 已断 */ }
  })
  relay.on('error', function (error) {
    warn('中转服务异常:', String(error).slice(0, 120))
  })

  // 启动：中转 + 周期（登录校验/续期一体）
  let timer = null
  let stopped = false
  ctx.effect(function () {
    relay.listen(relayPort, '127.0.0.1', function () {
      log(`中转已就绪 http://127.0.0.1:${relayPort}/v2 → ${state.upstreamBase}（pi-ai 路由静态指向本端口）`)
      // 不阻止进程退出（测试/无头环境必需；生产 dsh 自有常驻句柄）
      if (typeof relay.unref === 'function') relay.unref()
    })
    void (async () => {
      await ensureKey('boot').catch(function (error) {
        state.lastError = String(error)
        warn('启动签发异常:', String(error).slice(0, 100))
      })
      if (stopped) return
      timer = setInterval(function () {
        if (stopped) return
        void ensureKey('tick').catch(function (error) {
          warn('周期检查异常:', String(error).slice(0, 100))
        })
      }, tickMs)
      if (typeof timer.unref === 'function') timer.unref()
    })()
    return async function () {
      stopped = true
      if (timer !== null) clearInterval(timer)
      await new Promise(function (resolve) { relay.close(resolve) })
    }
  }, 'llm-tempkey: relay+cycle')

  /** 状态面：ctx.llmTempkey.status() + 中转 /__status。 */
  function status() {
    return {
      login: state.login,
      tokenSource: state.tokenSource || 'unknown',
      tokenUrl: tokenUrl || null,
      userId: state.userId,
      balance: state.balance,
      keyPrefix: state.keyPrefix,
      expiresAt: state.expiresAt,
      secondsLeft: state.expiresAt ? Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000)) : 0,
      lastError: state.lastError,
      credentialRef: ref,
      serverBase,
      ttlSeconds: ttl,
      relayPort,
      upstreamBase: state.upstreamBase,
      upstreamSource: state.upstreamSource,
      platformModels: state.platformModels,
      relayRequests: state.relayRequests,
    }
  }
  ctx.provide('llmTempkey', {
    status,
    refresh: function () {
      return ensureKey('manual')
    },
  })

  // 环境引用占位：pi-ai 校验凭据非空；中转忽略 Authorization 值本身
  process.env[ref] = process.env[ref] || 'relay-local'
  log(`客户端就绪 server=${serverBase} ttl=${ttl}s margin=${margin}s ref=${ref} 中转=127.0.0.1:${relayPort} 登录态=${state.login}`)
  return async function () { /* 资源由 effect 清理 */ }
}

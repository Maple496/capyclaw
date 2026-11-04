/**
 * dsh-scrapling 宿主半（Cordis 入口）
 *
 * 能力边界（诚实声明）：
 *   - fetch()            已实现：用 Node 内置 fetch 发起 HTTP 请求，返回状态/头/正文。
 *   - fetchWithBrowser() 未实现：浏览器渲染 / Cloudflare 绕过需要外部 Python scrapling，
 *                        当前直接抛 NOT_IMPLEMENTED，不会伪造结果。
 *   - parse()            未实现：CSS/XPath 选择器需要 DOM 解析器，同上。
 *
 * 配置（resolveConfig：ctx config → 环境变量 → 默认值）：
 *   enabled    是否注册服务        DSH_SCRAPLING_ENABLED     默认 true
 *   timeoutMs  单次请求超时(ms)    DSH_SCRAPLING_TIMEOUT_MS  默认 20000
 *   userAgent  默认 UA             DSH_SCRAPLING_USER_AGENT  默认 undici
 */
import { resolveConfig } from '@capyclaw/plugin-kit/config'

export const name = '@capyclaw/scrapling'

function notImplemented(feature) {
  const error = new Error(
    `[dsh-scrapling] ${feature} 未实现：浏览器渲染与选择器解析依赖外部 Python scrapling 运行时。` +
    '请使用 fetch() 做普通 HTTP 抓取，或另行部署 scrapling 服务后通过 HTTP 调用。',
  )
  error.code = 'NOT_IMPLEMENTED'
  return error
}

export async function apply(ctx, config = {}) {
  const { value: cfg, issues } = resolveConfig(config, {
    envPrefix: 'DSH_SCRAPLING',
    defaults: { enabled: true, timeoutMs: 20000, userAgent: 'undici' },
    fields: {
      enabled: { env: 'ENABLED', type: 'boolean' },
      timeoutMs: { env: 'TIMEOUT_MS', type: 'number' },
      userAgent: { env: 'USER_AGENT' },
    },
  })
  if (issues.length) {
    for (const issue of issues) ctx.logger?.warn?.(`[dsh-scrapling] 配置: ${issue}`)
  }

  if (!cfg.enabled) {
    ctx.logger?.info?.('[dsh-scrapling] 已按配置禁用，不注册 scrapling 服务')
    return
  }

  ctx.provide('scrapling', {
    /** 普通 HTTP 抓取（真实实现）。 */
    async fetch(url, options = {}) {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'user-agent': options.userAgent || cfg.userAgent,
          ...(options.headers || {}),
        },
        body: options.body,
        signal: AbortSignal.timeout(Number(options.timeoutMs) || cfg.timeoutMs),
      })
      const html = await response.text()
      return {
        url,
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        html,
      }
    },

    /** 浏览器渲染：未实现。 */
    async fetchWithBrowser() {
      throw notImplemented('fetchWithBrowser')
    },

    /** 选择器解析：未实现。 */
    parse() {
      throw notImplemented('parse')
    },
  })

  ctx.logger?.info?.(
    `[dsh-scrapling] 已注册 scrapling 服务（仅 HTTP fetch；浏览器/解析未实现，timeout=${cfg.timeoutMs}ms）`,
  )
}

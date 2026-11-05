/**
 * dsh-scrapling 宿主半（Cordis 入口）。
 *
 * 能力边界（诚实声明）：
 *   - fetch()            已实现：Node 内置 fetch 发起 HTTP 请求，返回状态/头/正文。
 *   - parse()            已实现：纯 Node 的容错 HTML 解析 + CSS 选择器引擎
 *                        （lib/html-parser.mjs / lib/selectors.mjs），支持
 *                        ::text / ::attr / 组合器 / 常见伪类；xpath 未实现。
 *   - fetchWithBrowser() 未实现：浏览器渲染 / Cloudflare 绕过需要外部 Python
 *                        scrapling，直接抛 NOT_IMPLEMENTED，不会伪造结果。
 *
 * 工作台服务（server/server.mjs）：
 *   - 由 service-broker 作为独立进程管理；Cordis 进程不监听业务端口；
 *   - 依赖注入可选：workbench: false 可只注册进程内 fetch/parse API；
 *   - 通过 webserver/index-inject 注入 URL（固定端口，注入时机先于 broker.start）；
 *     浏览器半据此挂右侧边栏面板。
 *
 * 配置（resolveConfig：ctx config → 环境变量 → 默认值）：
 *   enabled      是否注册服务/界面    DSH_SCRAPLING_ENABLED     默认 true
 *   port         工作台端口           DSH_SCRAPLING_PORT        默认 39640
 *   host         监听地址             DSH_SCRAPLING_HOST        默认 127.0.0.1
 *   timeoutMs    单次请求超时(ms)     DSH_SCRAPLING_TIMEOUT_MS  默认 20000
 *   userAgent    默认 UA              DSH_SCRAPLING_USER_AGENT
 *   workbench    是否拉起界面         DSH_SCRAPLING_WORKBENCH   默认 true
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '@capyclaw/plugin-kit/config'

import { createCrawler } from './crawler.mjs'
import { createSelectorDocument } from './selectors.mjs'

export const name = '@capyclaw/scrapling'
export const DEFAULT_PORT = 39640
export const inject = ['serviceBroker']

const SERVICE_ID = 'scrapling-workbench'

/* 版本号单一真源：读包内 package.json（createRequire 全 Node 版本稳态）。 */
import { createRequire } from 'node:module'
const requireFromHere = createRequire(import.meta.url)
const { version: PKG_VERSION } = requireFromHere('../package.json')

function notImplemented(feature) {
  const error = new Error(
    `[dsh-scrapling] ${feature} 未实现：浏览器渲染与 XPath 依赖外部 Python scrapling 运行时。` +
    '请使用 fetch()/parse()（HTTP 抓取 + CSS 选择器），或另行部署 scrapling 服务后通过 HTTP 调用。',
  )
  error.code = 'NOT_IMPLEMENTED'
  return error
}

export async function apply(ctx, config = {}) {
  const { value: cfg, issues } = resolveConfig(config, {
    envPrefix: 'DSH_SCRAPLING',
    defaults: {
      enabled: true,
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      timeoutMs: 20000,
      workbench: true,
    },
    fields: {
      enabled: { env: 'ENABLED', type: 'boolean' },
      port: { env: 'PORT', type: 'string' },
      host: { env: 'HOST' },
      timeoutMs: { env: 'TIMEOUT_MS', type: 'number' },
      userAgent: { env: 'USER_AGENT' },
      workbench: { env: 'WORKBENCH', type: 'boolean' },
    },
  })
  for (const issue of issues) ctx.logger?.warn?.(`[dsh-scrapling] 配置: ${issue}`)
  const port = cfg.port === 'auto' ? 'auto' : Number(cfg.port)
  if (port !== 'auto' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    ctx.logger?.warn?.(`[dsh-scrapling] 非法 port=${cfg.port}，回退为默认 ${DEFAULT_PORT}`)
  }
  const servicePort = port === 'auto' || !Number.isInteger(port) || port < 1 || port > 65535 ? DEFAULT_PORT : port

  if (!cfg.enabled) {
    ctx.logger?.info?.('[dsh-scrapling] 已按配置禁用，不注册 scrapling 服务')
    return
  }

  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const crawler = createCrawler({ timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent })

  ctx.provide('scrapling', {
    /** 普通 HTTP 抓取（真实实现）。 */
    async fetch(url, options = {}) {
      const record = await crawler.crawl({ url, timeoutMs: options.timeoutMs, userAgent: options.userAgent || options.headers?.['user-agent'] })
      if (record.error) {
        const error = new Error(record.error.message)
        error.code = record.error.code
        error.hint = record.error.hint
        throw error
      }
      return { url: record.url, status: record.status, ok: record.ok, headers: {}, html: record.html }
    },

    /** 浏览器渲染：未实现（诚实声明，不伪造结果）。 */
    async fetchWithBrowser() {
      throw notImplemented('fetchWithBrowser')
    },

    /** HTML → 文档包装：css('.a .b::text') / css('a::attr(href)')。 */
    parse(html, options = {}) {
      return createSelectorDocument(html, options)
    },

    /** 工作台爬取流水线（带步骤计时，工作台界面数据源）。 */
    crawler,
  })

  /* 工作台由 broker 独立拉起；Cordis 进程只注册 API 与 sidebar URL。
   * 时序契约：webserver/index-inject 是 webserver 启动时机的一次性事件，
   * 注册必须发生在 broker.start 之前，且 URL 必须此刻可知——所以默认固定端口
   *（port=auto 时 URL 要等 broker 分配，注入会错过时机，只做尽力补注册并告警）。 */
  let serviceBroker = null
  let stopServiceOnDispose = false
  if (cfg.workbench) {
    const expectedUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${servicePort}`
    ctx.on?.('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_SCRAPLING__', value: { url: `${expectedUrl}/`, version: PKG_VERSION } })
    })
    const broker = ctx.serviceBroker
    serviceBroker = broker || null
    if (!broker || typeof broker.start !== 'function') {
      ctx.logger?.warn?.('[dsh-scrapling] 缺少 ctx.serviceBroker，工作台未启动；fetch/parse API 仍可用')
    } else {
      const serviceFile = path.join(packageDir, 'server', 'server.mjs')
      const spec = {
        id: SERVICE_ID,
        cmd: [process.execPath, serviceFile, '--port', '${PORT}', '--host', cfg.host],
        env: {
          DSH_SCRAPLING_TIMEOUT_MS: String(cfg.timeoutMs),
          ...(cfg.userAgent ? { DSH_SCRAPLING_USER_AGENT: String(cfg.userAgent) } : {}),
        },
        ports: { main: servicePort },
        url: 'http://127.0.0.1:${PORT}',
        healthPath: '/healthz',
        keepAlive: true,
      }
      try {
        const started = await broker.start(spec)
        if (!started?.url) throw new Error('serviceBroker.start 未返回服务 url')
        const serviceUrl = started.url.replace(/\/$/, '')
        stopServiceOnDispose = true
        ctx.logger?.info?.(`[dsh-scrapling] broker 工作台已就绪: ${serviceUrl}/`)
        if (serviceUrl !== expectedUrl) {
          ctx.logger?.warn?.(`[dsh-scrapling] 实际服务地址 ${serviceUrl} 与注入地址 ${expectedUrl} 不一致（port=auto？），面板可能指向旧地址；建议使用固定端口`)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-scrapling] broker 工作台启动失败（fetch/parse API 仍可用）: ${error.message}`)
      }
    }
  } else {
    ctx.logger?.info?.('[dsh-scrapling] workbench=false，仅注册 scrapling API，不投递服务')
  }

  ctx.logger?.info?.(
    `[dsh-scrapling] 已注册 scrapling 服务（fetch + parse；浏览器/XPath 未实现，timeout=${cfg.timeoutMs}ms）`,
  )

  return async () => {
    if (stopServiceOnDispose && serviceBroker && typeof serviceBroker.stop === 'function') {
      const result = await serviceBroker.stop(SERVICE_ID)
      if (result?.stopped) ctx.logger?.info?.('[dsh-scrapling] broker 已停止工作台服务')
    }
  }
}

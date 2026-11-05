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
 *   - 默认 http://127.0.0.1:39640/ ，浏览器打开即用的可视化爬取界面；
 *   - 依赖注入可选：workbench: false 可只注册 scrapling 服务不起界面；
 *   - 通过 webserver/index-inject 注入 __DSH_SCRAPLING__ 供浏览器半挂面板。
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
      port: { env: 'PORT', type: 'port' },
      host: { env: 'HOST' },
      timeoutMs: { env: 'TIMEOUT_MS', type: 'number' },
      userAgent: { env: 'USER_AGENT' },
      workbench: { env: 'WORKBENCH', type: 'boolean' },
    },
  })
  for (const issue of issues) ctx.logger?.warn?.(`[dsh-scrapling] 配置: ${issue}`)

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

  /* 工作台界面（默认开启；workbench:false 可关闭） */
  let instance = null
  if (cfg.workbench) {
    const { startWorkbenchServer } = await import('../server/server.mjs')
    try {
      instance = await startWorkbenchServer({
        port: cfg.port,
        host: cfg.host,
        packageDir,
        crawler,
        version: '1.1.0',
      })
      ctx.logger?.info?.(`[dsh-scrapling] 爬虫工作台已就绪: ${instance.url}/ （浏览器打开即用）`)
      /* 与 DSH web 客户端的桥：注入 boot 全局（launchpad/port-sidebar 同款协议） */
      ctx.on?.('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__DSH_SCRAPLING__', value: { url: `${instance.url}/`, version: '1.1.0' } })
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-scrapling] 工作台启动失败（scrapling 服务仍可用）: ${error.message}`)
    }
  } else {
    ctx.logger?.info?.('[dsh-scrapling] workbench=false，仅注册 scrapling 服务')
  }

  ctx.logger?.info?.(
    `[dsh-scrapling] 已注册 scrapling 服务（fetch + parse；浏览器/XPath 未实现，timeout=${cfg.timeoutMs}ms）`,
  )

  return async () => {
    if (instance) {
      await instance.close()
      ctx.logger?.info?.('[dsh-scrapling] 爬虫工作台已停止')
    }
  }
}

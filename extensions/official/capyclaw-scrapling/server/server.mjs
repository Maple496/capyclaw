#!/usr/bin/env node
/**
 * dsh-scrapling 爬虫工作台独立服务入口（broker 清单 / 手动调试用）。
 *
 *   node server/server.mjs [--port 39640] [--host 127.0.0.1]
 *
 * 只绑 127.0.0.1；/healthz 报标准服务信息，`/` 是爬虫工作台界面，
 * /demo/* 是内置离线演示页（不依赖外网即可完整体验爬取流程）。
 * lib/host.mjs 在被 insert 时会以同一装配拉起本服务并返回 disposer。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { isMain, parseArgs } from '@capyclaw/plugin-kit'

import { createCrawler } from '../lib/crawler.mjs'

export const DEFAULT_PORT = 39640
export const CONTRACT_VERSION = '1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** 静态文件白名单（路径 → 磁盘相对路径），杜绝路径穿越。 */
function staticFiles(uiDir, demoDir) {
  return new Map([
    ['/', path.join(uiDir, 'index.html')],
    ['/index.html', path.join(uiDir, 'index.html')],
    ['/app.js', path.join(uiDir, 'app.js')],
    ['/style.css', path.join(uiDir, 'style.css')],
    ['/demo/quotes.html', path.join(demoDir, 'quotes.html')],
    ['/demo/products.html', path.join(demoDir, 'products.html')],
    ['/demo/news.html', path.join(demoDir, 'news.html')],
  ])
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, { code, message, hint }) {
  sendJson(res, status, { ok: false, error: { code, message, hint } })
}

async function readJsonBody(req, { limitBytes = 1024 * 1024 } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BODY_INVALID' })
  }
}

/** 校验 /api/crawl 与 /api/extract 的 selectors 入参形状。 */
function normalizeSelectors(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw Object.assign(new Error('selectors 需要是数组'), { code: 'SELECTORS_INVALID' })
  return raw.slice(0, 20).map((item, index) => {
    if (typeof item === 'string') return { key: `s${index + 1}`, selector: item }
    if (!item || typeof item.selector !== 'string') {
      throw Object.assign(new Error(`selectors[${index}] 缺少 selector 字段`), { code: 'SELECTORS_INVALID' })
    }
    return { key: String(item.key || `s${index + 1}`).slice(0, 60), selector: item.selector.slice(0, 500) }
  })
}

/**
 * 拉起工作台服务。
 *
 * @param {object} [options]
 * @param {number} [options.port=39640]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.packageDir] 插件根目录（默认取本文件上两级）
 * @param {object} [options.crawler] 注入的爬取器（默认新建）
 * @param {string} [options.version] healthz 里的版本号
 */
export async function startWorkbenchServer(options = {}) {
  const packageDir = options.packageDir
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const port = Number(options.port) || DEFAULT_PORT
  const host = options.host || '127.0.0.1'
  const crawler = options.crawler || createCrawler()
  const version = options.version || '1.1.0'
  const uiDir = path.join(packageDir, 'ui')
  const demoDir = path.join(packageDir, 'demo')
  const files = staticFiles(uiDir, demoDir)
  const startedAt = Date.now()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`)
    try {
      /* ---- 健康检查 / 指标（服务契约） ---- */
      if (url.pathname === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          name: 'scrapling-workbench',
          version,
          contractVersion: CONTRACT_VERSION,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          port,
          pid: process.pid,
          crawls: crawler.counters.total,
          capabilities: { http: true, browser: false, selectors: true },
        })
      }
      if (url.pathname === '/metrics' && req.method === 'GET') {
        const body = [
          '# HELP scrapling_up 服务存活状态',
          '# TYPE scrapling_up gauge',
          'scrapling_up 1',
          '# HELP scrapling_uptime_seconds 服务运行秒数',
          '# TYPE scrapling_uptime_seconds counter',
          `scrapling_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
          '# HELP scrapling_crawls_total 累计爬取次数',
          '# TYPE scrapling_crawls_total counter',
          `scrapling_crawls_total ${crawler.counters.total}`,
          '# HELP scrapling_crawl_errors_total 累计失败次数',
          '# TYPE scrapling_crawl_errors_total counter',
          `scrapling_crawl_errors_total ${crawler.counters.errors}`,
          '',
        ].join('\n')
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(body)
      }

      /* ---- API ---- */
      if (url.pathname === '/api/crawl' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (!body.url || typeof body.url !== 'string') {
          return sendError(res, 400, { code: 'URL_REQUIRED', message: '缺少 url 字段', hint: '请在请求体里提供要抓取的网址，如 { "url": "http://127.0.0.1:39640/demo/quotes.html" }' })
        }
        if (body.mode && body.mode !== 'http') {
          return sendError(res, 400, {
            code: 'NOT_IMPLEMENTED',
            message: `浏览器渲染模式（${body.mode}）未实现：依赖外部 Python scrapling 运行时`,
            hint: '请使用 HTTP 模式（mode 缺省即为 HTTP）。',
          })
        }
        const selectors = normalizeSelectors(body.selectors)
        const record = await crawler.crawl({
          url: body.url,
          mode: 'http',
          timeoutMs: Number(body.timeoutMs) || undefined,
          userAgent: body.userAgent,
          selectors,
        })
        /* 历史里保留 root 供二次提取；对外响应剔除 root/html 大字段 */
        const { root, html, ...payload } = record
        return sendJson(res, 200, { ok: !record.error, crawl: { ...payload, htmlPreview: typeof html === 'string' ? html.slice(0, 40000) : undefined } })
      }

      if (url.pathname === '/api/extract' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (!body.crawlId || typeof body.crawlId !== 'string') {
          return sendError(res, 400, { code: 'CRAWL_ID_REQUIRED', message: '缺少 crawlId', hint: '先执行一次 /api/crawl，再用返回的 crawl.id 做二次提取。' })
        }
        const selectors = normalizeSelectors(body.selectors)
        if (!selectors.length) {
          return sendError(res, 400, { code: 'SELECTORS_REQUIRED', message: '缺少 selectors', hint: '提供 [{ "key": "标题", "selector": "h1::text" }] 形式的选择器列表。' })
        }
        const result = crawler.reExtract(body.crawlId, selectors)
        if (!result) {
          return sendError(res, 404, { code: 'CRAWL_NOT_FOUND', message: `找不到爬取记录 ${body.crawlId}`, hint: '记录可能已过期（仅保留最近 20 条），请重新爬取一次。' })
        }
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (url.pathname === '/api/crawls' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, crawls: crawler.list() })
      }

      const crawlMatch = /^\/api\/crawls\/([\w-]+)$/.exec(url.pathname)
      if (crawlMatch) {
        if (req.method !== 'GET') return sendError(res, 405, { code: 'METHOD', message: '只支持 GET', hint: '' })
        const record = crawler.get(crawlMatch[1])
        if (!record) return sendError(res, 404, { code: 'CRAWL_NOT_FOUND', message: `找不到爬取记录 ${crawlMatch[1]}`, hint: '记录可能已过期，请重新爬取。' })
        return sendJson(res, 200, { ok: true, crawl: record })
      }

      if (url.pathname.startsWith('/api/')) {
        return sendError(res, 404, { code: 'NOT_FOUND', message: `未知接口 ${url.pathname}`, hint: '可用接口：POST /api/crawl、POST /api/extract、GET /api/crawls、GET /api/crawls/:id' })
      }

      /* ---- 静态资源（白名单） ---- */
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, { code: 'METHOD', message: `不支持 ${req.method}`, hint: '' })
      }
      const file = files.get(url.pathname)
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('Not found')
      }
      const content = await readFile(file)
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      return res.end(req.method === 'HEAD' ? undefined : content)
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE' || error.code === 'BODY_INVALID' || error.code === 'SELECTORS_INVALID') {
        return sendError(res, 400, { code: error.code, message: error.message, hint: '请检查请求体格式。' })
      }
      return sendError(res, 500, { code: 'INTERNAL', message: error.message || '服务内部错误', hint: '请重试；若持续失败请查看服务日志。' })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  return {
    port,
    host,
    url: `http://${host === '127.0.0.1' ? '127.0.0.1' : host}:${port}`,
    crawler,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    console.log('dsh-scrapling 工作台服务\n\n用法: node server/server.mjs [--port 39640] [--host 127.0.0.1]')
    return
  }
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port)
  const instance = await startWorkbenchServer({ port, host: flags.host })
  console.log(`[dsh-scrapling] 工作台已就绪: ${instance.url}/ （浏览器打开即用）`)
  const shutdown = () => {
    instance.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  })
}

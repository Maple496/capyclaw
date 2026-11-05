/**
 * 爬取流水线（fetch → parse → extract），带步骤计时与历史记录。
 *
 * 设计目标：让「DSH 如何爬取数据」可被观测——每一步（解析 URL/发请求/
 * 收响应/读内容/建文档树/提取）都记录真实耗时与细节，前端按步骤回放。
 *
 * 诚实边界：只有 HTTP 模式；浏览器渲染（Cloudflare 绕过等）依赖外部
 * Python scrapling 运行时，未实现，调用会返回结构化的 NOT_IMPLEMENTED。
 */

import { parseHtml, documentStats } from './html-parser.mjs'
import { extract as runExtract, SelectorError } from './selectors.mjs'

const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024
const DEFAULT_HISTORY_LIMIT = 20

/** 步骤计时器：每步记录 label/detail/ms，错误带「下一步」提示。 */
class StepRecorder {
  constructor() {
    this.steps = []
    this.last = performance.now()
  }

  add(id, label, { status = 'ok', detail = '', ms } = {}) {
    const now = performance.now()
    const step = { id, label, status, detail, ms: ms ?? Math.round((now - this.last) * 10) / 10 }
    this.last = now
    this.steps.push(step)
    return step
  }

  total() {
    return Math.round(this.steps.reduce((sum, s) => sum + (s.ms || 0), 0) * 10) / 10
  }
}

/** HTML meta 声明 charset 的嗅探（ASCII 区扫描，前 2048 字节足够）。 */
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([-\w]+)/i

/**
 * 按「响应头 charset → BOM → meta 标签 → UTF-8」的顺序解码响应体。
 * 大量中文老站点仍是 GBK/GB2312/GB18030，undici 的 response.text() 只会按
 * UTF-8 解码，直接用会得到乱码——所以这里必须自己按字节解码。
 */
export function decodeBody(buffer, contentTypeHeader) {
  const head = buffer.subarray(0, 3)
  // BOM 优先：UTF-8 / UTF-16 LE / UTF-16 BE
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { text: decodeWith('utf-8', buffer.subarray(3)), charset: 'utf-8(bom)' }
  }
  if (head[0] === 0xff && head[1] === 0xfe) {
    return { text: decodeWith('utf-16le', buffer.subarray(2)), charset: 'utf-16le(bom)' }
  }
  if (head[0] === 0xfe && head[1] === 0xff) {
    return { text: decodeWith('utf-16be', buffer.subarray(2)), charset: 'utf-16be(bom)' }
  }

  let charset = null
  // 1) Content-Type 响应头
  if (contentTypeHeader) {
    const m = /charset\s*=\s*["']?\s*([-\w]+)/i.exec(contentTypeHeader)
    if (m) charset = m[1]
  }
  // 2) <meta charset> / <meta http-equiv content-type>（内容按 latin1 看 ASCII 结构）
  if (!charset) {
    const probe = buffer.subarray(0, 2048).toString('latin1')
    const m = META_CHARSET_RE.exec(probe)
    if (m) charset = m[1]
  }
  if (!charset) charset = 'utf-8'

  return { text: decodeWith(charset, buffer), charset }
}

function decodeWith(charset, buffer) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    // Node 未带该编码的 ICU 数据等情况：退回 UTF-8 容错解码
    try { return new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
    catch { return buffer.toString('utf8') }
  }
}

/** 把底层网络错误翻译成普通人能懂的中文（保留原始码便于诊断）。 */
function describeNetworkError(error) {
  const cause = error?.cause || {}
  const code = cause.code || error?.code || ''
  const raw = code || (cause.message ? String(cause.message).slice(0, 60) : String(error.message || '').slice(0, 60))
  const table = [
    [/ECONNREFUSED/, '目标服务器拒绝连接（端口未开放或服务未启动）'],
    [/ENOTFOUND|EAI_AGAIN/, '域名无法解析（网址可能拼写有误，或该域名不存在）'],
    [/ECONNRESET/, '连接被目标服务器重置'],
    [/UND_ERR_CONNECT_TIMEOUT|ConnectTimeout/i, '连接建立超时'],
    [/CERT|TLS/i, 'HTTPS 证书校验失败'],
    [/EPROTO/, '协议不匹配（该端口可能不是网站服务）'],
  ]
  for (const [pattern, message] of table) {
    if (pattern.test(code) || pattern.test(String(cause.message || ''))) {
      return { message: `${message}（${raw}）`, raw }
    }
  }
  return { message: `无法连接到目标网址（${raw}）`, raw }
}

/** 生成短 id（c1, c2, …），人眼可读、URL 友好。 */
function createIdFactory() {
  let n = 0
  return () => `c${++n}`
}

/**
 * 创建爬取器实例。
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=20000] 默认超时
 * @param {string} [options.userAgent] 默认 UA
 * @param {number} [options.maxHtmlBytes=5MB] 响应体大小上限
 * @param {number} [options.historyLimit=20] 历史记录条数
 * @param {Function} [options.fetchImpl] 可注入的 fetch（测试用）
 */
export function createCrawler(options = {}) {
  const {
    timeoutMs: defaultTimeout = 20000,
    userAgent: defaultUserAgent = 'Mozilla/5.0 (compatible; dsh-scrapling/1.1; +https://github.com/Maple496/capyclaw)',
    maxHtmlBytes = DEFAULT_MAX_HTML_BYTES,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = options

  if (typeof fetchImpl !== 'function') throw new Error('[dsh-scrapling] 当前运行时没有可用的 fetch')

  const nextId = createIdFactory()
  const history = new Map()
  const counters = { total: 0, errors: 0 }
  /* 已解析文档缓存：crawlId → { root }，选择器试玩免重复解析 */
  const parsedCache = new Map()

  function summaryOf(record) {
    return {
      id: record.id,
      url: record.url,
      ts: record.ts,
      ok: record.ok,
      status: record.status,
      bytes: record.bytes,
      contentType: record.contentType,
      title: record.title,
      totalMs: record.totalMs,
      itemCount: record.itemCount,
      steps: record.steps.length,
    }
  }

  function remember(record) {
    history.set(record.id, record)
    parsedCache.set(record.id, { root: record.root })
    while (history.size > historyLimit) {
      const oldest = history.keys().next().value
      history.delete(oldest)
      parsedCache.delete(oldest)
    }
  }

  /** 对已抓取的 HTML 执行选择器提取（选择器试玩/二次提取）。 */
  function extractSelectors(root, selectors) {
    const started = performance.now()
    const results = {}
    for (const item of selectors || []) {
      const key = item.key || item.selector
      try {
        const values = runExtract(root, item.selector)
        results[key] = { selector: item.selector, count: values.length, values }
      } catch (error) {
        results[key] = {
          selector: item.selector,
          count: 0,
          values: [],
          error: error instanceof SelectorError ? error.message : `提取失败: ${error.message}`,
        }
      }
    }
    return { results, ms: Math.round((performance.now() - started) * 10) / 10 }
  }

  /**
   * 执行一次完整爬取。
   *
   * @param {object} input
   * @param {string} input.url 目标地址（http/https）
   * @param {'http'|'browser'} [input.mode='http'] 抓取模式
   * @param {number} [input.timeoutMs] 超时（毫秒）
   * @param {string} [input.userAgent] 自定义 UA
   * @param {Array<{key:string, selector:string}>} [input.selectors] 同时提取
   */
  async function crawl(input) {
    const rec = new StepRecorder()
    counters.total++
    const id = nextId()

    if (input.mode && input.mode !== 'http') {
      rec.add('mode', '检查抓取模式', {
        status: 'error',
        detail: `浏览器渲染模式（${input.mode}）未实现：依赖外部 Python scrapling 运行时。`,
      })
      const record = {
        id, url: input.url, ts: Date.now(), mode: input.mode, ok: false,
        status: 0, bytes: 0, steps: rec.steps, totalMs: rec.total(),
        error: { code: 'NOT_IMPLEMENTED', message: '浏览器渲染模式未实现，当前仅支持 HTTP 抓取', hint: '请在界面选择「HTTP 抓取」模式重试。' },
      }
      counters.errors++
      remember(record)
      return record
    }

    let urlObj
    try {
      urlObj = new URL(input.url)
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error(`仅支持 http/https，当前是 ${urlObj.protocol}`)
      }
      rec.add('url', '解析目标网址', { detail: `${urlObj.host}${urlObj.pathname === '/' ? '' : urlObj.pathname}` })
    } catch (error) {
      rec.add('url', '解析目标网址', {
        status: 'error',
        detail: `网址无效：${error.message}`,
      })
      const record = {
        id, url: String(input.url || ''), ts: Date.now(), mode: 'http', ok: false,
        status: 0, bytes: 0, steps: rec.steps, totalMs: rec.total(),
        error: { code: 'URL_INVALID', message: `网址无效：${error.message}`, hint: '请检查网址拼写，需要以 http:// 或 https:// 开头。' },
      }
      counters.errors++
      remember(record)
      return record
    }

    const timeout = Number(input.timeoutMs) || defaultTimeout
    const userAgent = input.userAgent || defaultUserAgent

    let response
    try {
      const timeoutLabel = timeout >= 1000 ? `${(timeout / 1000).toFixed(timeout % 1000 ? 1 : 0)} 秒` : `${timeout}ms`
      rec.add('request', '发送 HTTP 请求', { detail: `GET · 超时 ${timeoutLabel} · UA ${userAgent.slice(0, 40)}…` })
      response = await fetchImpl(urlObj.href, {
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError'
      const described = describeNetworkError(error)
      const message = isTimeout ? `请求超时（${timeout}ms）` : described.message
      const timeoutLabel2 = timeout >= 1000 ? `${(timeout / 1000).toFixed(timeout % 1000 ? 1 : 0)} 秒` : `${timeout}ms`
      rec.add('response', '等待服务器响应', {
        status: 'error',
        detail: isTimeout ? `请求超时（${timeoutLabel2}）` : message,
      })
      const record = {
        id, url: urlObj.href, ts: Date.now(), mode: 'http', ok: false,
        status: 0, bytes: 0, steps: rec.steps, totalMs: rec.total(),
        error: {
          code: isTimeout ? 'TIMEOUT' : 'NETWORK',
          message: isTimeout ? `请求超时（${timeoutLabel2}）` : message,
          hint: isTimeout
            ? '可在「高级选项」里加大超时时间后重试；也可先在浏览器里确认该网址能正常打开。'
            : '请确认网址是否正确、网络是否可用；若是内网地址请确认服务已启动。',
        },
      }
      counters.errors++
      remember(record)
      return record
    }

    const contentType = response.headers.get('content-type') || ''
    rec.add('response', '收到响应', {
      status: response.ok ? 'ok' : 'warn',
      detail: `HTTP ${response.status} ${response.statusText || ''} · ${contentType.split(';')[0] || '未知类型'}${response.redirected ? ' · 已跟随重定向' : ''}`,
    })

    let html = ''
    let bodyBytes = 0
    try {
      const buffer = Buffer.from(await response.arrayBuffer())
      const bytes = buffer.length
      bodyBytes = bytes
      if (bytes > maxHtmlBytes) {
        rec.add('body', '读取页面内容', {
          status: 'error',
          detail: `页面过大：${(bytes / 1024 / 1024).toFixed(1)}MB（上限 ${(maxHtmlBytes / 1024 / 1024).toFixed(0)}MB）`,
        })
        const record = {
          id, url: urlObj.href, ts: Date.now(), mode: 'http', ok: false,
          status: response.status, bytes, steps: rec.steps, totalMs: rec.total(),
          error: { code: 'TOO_LARGE', message: `页面内容超过大小上限（${(maxHtmlBytes / 1024 / 1024).toFixed(0)}MB）`, hint: '该页面不适合整页抓取，请选择更具体的入口页。' },
        }
        counters.errors++
        remember(record)
        return record
      }
      const decoded = decodeBody(buffer, response.headers.get('content-type'))
      html = decoded.text
      rec.add('body', '读取页面内容', { detail: `${(bytes / 1024).toFixed(1)} KB · ${decoded.charset.toUpperCase()} 解码完成` })
    } catch (error) {
      rec.add('body', '读取页面内容', { status: 'error', detail: `读取失败: ${error.message}` })
      const record = {
        id, url: urlObj.href, ts: Date.now(), mode: 'http', ok: false,
        status: response.status, bytes: 0, steps: rec.steps, totalMs: rec.total(),
        error: { code: 'BODY_ERROR', message: `读取响应内容失败: ${error.message}`, hint: '请重试；若持续失败可能是连接被中断。' },
      }
      counters.errors++
      remember(record)
      return record
    }

    const root = parseHtml(html)
    const stats = documentStats(root)
    rec.add('dom', '构建文档树', { detail: `${stats.elements} 个元素 · 最大深度 ${stats.maxDepth} · 标题「${stats.title.slice(0, 40)}」` })

    let extracts = null
    let itemCount = 0
    if (Array.isArray(input.selectors) && input.selectors.length) {
      const { results } = extractSelectors(root, input.selectors)
      extracts = results
      itemCount = Object.values(results).reduce((sum, r) => sum + r.count, 0)
      const okCount = Object.values(results).filter((r) => !r.error).length
      rec.add('extract', '提取结构化数据', {
        status: okCount === 0 && input.selectors.length > 0 ? 'warn' : 'ok',
        detail: `${input.selectors.length} 个选择器 · 命中 ${itemCount} 条数据`,
      })
    } else {
      rec.add('extract', '提取结构化数据', { status: 'skip', detail: '未指定选择器，跳过（可在结果区随时试玩选择器）' })
    }

    rec.add('done', '完成', { detail: `全程 ${rec.total()}ms` })
    const record = {
      id, url: urlObj.href, finalUrl: response.url || urlObj.href, ts: Date.now(), mode: 'http',
      ok: response.ok, status: response.status, statusText: response.statusText,
      contentType, bytes: bodyBytes, title: stats.title, stats,
      steps: rec.steps, totalMs: rec.total(), extracts, itemCount,
      html, root,
      get summary() { return summaryOf(this) },
    }
    delete record.error
    remember(record)
    return record
  }

  /** 基于历史记录二次提取（不重新请求）。 */
  function reExtract(crawlId, selectors) {
    const cache = parsedCache.get(crawlId)
    if (!cache) return null
    const { results, ms } = extractSelectors(cache.root, selectors)
    return { results, ms }
  }

  return {
    crawl,
    reExtract,
    summaryOf,
    list: () => [...history.values()].map(summaryOf).reverse(),
    get: (crawlId) => {
      const record = history.get(crawlId)
      if (!record) return null
      const { html, root, ...rest } = record
      return { ...rest, htmlPreview: typeof html === 'string' ? html.slice(0, 20000) : undefined }
    },
    counters,
  }
}

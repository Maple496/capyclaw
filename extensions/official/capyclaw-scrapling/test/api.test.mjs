/**
 * 工作台 HTTP 服务测试：健康检查 / 静态页 / 爬取 API / 提取 API / 历史 / 错误形态。
 * 全程离线：爬取目标用服务自带的 /demo/ 页。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startWorkbenchServer } from '../server/server.mjs'

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function getJson(port, pathname, init) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init)
  return { status: res.status, body: await res.json() }
}

test('工作台服务：healthz / metrics / 静态页 / API 全链路（离线自爬演示页）', async () => {
  const port = await freePort()
  const instance = await startWorkbenchServer({ port, packageDir: PACKAGE_DIR })

  try {
    const base = `http://127.0.0.1:${port}`

    /* 服务契约：/healthz 标准形状 */
    const h = await getJson(port, '/healthz')
    assert.equal(h.status, 200)
    assert.equal(h.body.ok, true)
    assert.equal(h.body.name, 'scrapling-workbench')
    assert.equal(h.body.contractVersion, '1')
    assert.equal(h.body.port, port)
    assert.equal(typeof h.body.pid, 'number')
    assert.deepEqual(h.body.capabilities, { http: true, browser: false, selectors: true })

    /* 服务契约：/metrics Prometheus 文本 */
    const metrics = await fetch(`${base}/metrics`)
    const metricsText = await metrics.text()
    assert.match(metricsText, /scrapling_up 1/)
    assert.match(metricsText, /scrapling_uptime_seconds \d+/)

    /* 静态页与演示页 */
    for (const file of ['/', '/app.js', '/style.css', '/demo/quotes.html', '/demo/products.html', '/demo/news.html']) {
      const res = await fetch(`${base}${file}`)
      assert.equal(res.status, 200, file)
    }
    const index = await fetch(`${base}/`)
    const indexHtml = await index.text()
    assert.ok(indexHtml.includes('DSH 爬虫工作台'))

    /* 未知路径与未知 API 的错误形态 */
    const notFoundApi = await getJson(port, '/api/nope')
    assert.equal(notFoundApi.status, 404)
    assert.equal(notFoundApi.body.ok, false)
    assert.ok(notFoundApi.body.error.hint)
    /* 路径穿越被白名单挡住（不在白名单一律 404，磁盘路径不来自用户输入） */
    const notFoundStatic = await fetch(`${base}/../etc/passwd`)
    assert.equal(notFoundStatic.status, 404)
    const traversal = await fetch(`${base}/demo/../package.json`)
    assert.equal(traversal.status, 404)

    /* 爬取：缺少 url → 400 带提示 */
    const noUrl = await fetch(`${base}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(noUrl.status, 400)
    assert.equal((await noUrl.json()).error.code, 'URL_REQUIRED')

    /* 浏览器模式 → 诚实拒绝 */
    const browser = await fetch(`${base}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/demo/quotes.html`, mode: 'browser' }),
    })
    assert.equal(browser.status, 400)
    assert.equal((await browser.json()).error.code, 'NOT_IMPLEMENTED')

    /* 爬取：自爬演示页，带选择器 */
    const crawlRes = await fetch(`${base}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${base}/demo/quotes.html`,
        selectors: [
          { key: '名言', selector: '.quote .text::text' },
          { key: '作者', selector: '.quote .author::text' },
          { key: '链接', selector: '.quote .tag::attr(href)' },
        ],
      }),
    })
    assert.equal(crawlRes.status, 200)
    const crawlJson = await crawlRes.json()
    assert.equal(crawlJson.ok, true)
    const crawl = crawlJson.crawl
    assert.equal(crawl.status, 200)
    assert.equal(crawl.title, '每日名言 · 演示站')
    assert.ok(crawl.bytes > 0)
    /* 步骤齐全且带耗时 */
    const ids = crawl.steps.map((s) => s.id)
    assert.deepEqual(ids, ['url', 'request', 'response', 'body', 'dom', 'extract', 'done'])
    assert.ok(crawl.steps.every((s) => typeof s.ms === 'number'))
    /* 提取结果正确 */
    assert.equal(crawl.extracts['名言'].count, 8)
    assert.equal(crawl.extracts['作者'].values[0], '佚名')
    assert.equal(crawl.extracts['链接'].values[0], '/tag/生活/1')
    /* 大字段不外泄全文 */
    assert.equal(crawl.html, undefined)
    assert.ok(crawl.htmlPreview.length > 0 && crawl.htmlPreview.length <= 40000)

    /* 二次提取（不重新请求） */
    const extractRes = await fetch(`${base}/api/extract`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ crawlId: crawl.id, selectors: [{ key: '标题', selector: 'h1::text' }] }),
    })
    assert.equal(extractRes.status, 200)
    const extractJson = await extractRes.json()
    assert.equal(extractJson.ok, true)
    assert.deepEqual(extractJson.results['标题'].values, ['每日名言'])

    /* 二次提取：坏选择器逐字段报错（不影响其他字段） */
    const badSel = await fetch(`${base}/api/extract`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        crawlId: crawl.id,
        selectors: [{ key: '坏', selector: 'a:::text' }, { key: '好', selector: 'h1::text' }],
      }),
    })
    const badSelJson = await badSel.json()
    assert.ok(badSelJson.results['坏'].error)
    assert.deepEqual(badSelJson.results['好'].values, ['每日名言'])

    /* 历史 */
    const list = await getJson(port, '/api/crawls')
    assert.equal(list.body.crawls.length, 1)
    assert.equal(list.body.crawls[0].id, crawl.id)
    const detail = await getJson(port, `/api/crawls/${crawl.id}`)
    assert.equal(detail.body.crawl.title, '每日名言 · 演示站')
    const missing = await getJson(port, '/api/crawls/c999')
    assert.equal(missing.status, 404)

    /* 非法 JSON 请求体 */
    const badBody = await fetch(`${base}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    })
    assert.equal(badBody.status, 400)

    /* 爬取失败形态：不可达地址 → 结构化错误 + 下一步提示 */
    const fail = await fetch(`${base}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:1/nope`, timeoutMs: 1500 }),
    })
    const failJson = await fail.json()
    assert.equal(failJson.ok, false)
    assert.equal(failJson.crawl.error.code, 'NETWORK')
    assert.ok(failJson.crawl.error.hint.includes('确认'))
  } finally {
    await instance.close()
  }
})
